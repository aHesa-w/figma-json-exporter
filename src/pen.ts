import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { persistExport, type ExportOptions, type PenBounds } from "./assets.js";

type Value = string | number | boolean;
type PenNode = Record<string, any> & { id: string; type: string; children?: PenNode[] };
type PenDocument = { version: string; children: PenNode[]; variables?: Record<string, { value: any }>; themes?: Record<string, string[]>; imports?: Record<string, string> };
type Box = { x: number; y: number; width: number; height: number };

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const array = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const clone = <T>(value: T): T => structuredClone(value);

function hexColor(value: unknown): { r: number; g: number; b: number; a: number; css: string } | null {
  if (typeof value !== "string" || !/^#[0-9a-f]{3,8}$/i.test(value)) return null;
  let raw = value.slice(1);
  if (raw.length === 3 || raw.length === 4) raw = [...raw].map(char => char + char).join("");
  if (raw.length === 6) raw += "ff";
  if (raw.length !== 8) return null;
  const bytes = [0, 2, 4, 6].map(offset => Number.parseInt(raw.slice(offset, offset + 2), 16));
  const [r, g, b, alpha] = bytes;
  const a = alpha / 255;
  return { r: r / 255, g: g / 255, b: b / 255, a, css: `rgba(${r},${g},${b},${Number(a.toFixed(6))})` };
}

function variableResolver(document: PenDocument) {
  const defaults = Object.fromEntries(Object.entries(document.themes ?? {}).map(([axis, values]) => [axis, values[0]]));
  const resolveValue = (value: any, theme: Record<string, string>, seen = new Set<string>()): any => {
    if (typeof value !== "string" || !value.startsWith("$")) return value;
    const name = value.slice(1);
    if (seen.has(name)) throw new Error(`Circular Pen variable: ${value}`);
    const definition = document.variables?.[name];
    if (!definition) throw new Error(`Unknown Pen variable: ${value}`);
    let selected = definition.value;
    if (Array.isArray(selected)) {
      const candidates = selected.filter(entry => entry && typeof entry === "object" && "value" in entry && Object.entries(entry.theme ?? {}).every(([axis, expected]) => theme[axis] === expected));
      selected = candidates.length ? candidates[candidates.length - 1].value : undefined;
    }
    if (selected === undefined) throw new Error(`No Pen variable value matches the active theme: ${value}`);
    return resolveValue(selected, theme, new Set([...seen, name]));
  };
  return { defaults, resolveValue };
}

function expandRefs(document: PenDocument): PenNode[] {
  if (document.imports && Object.keys(document.imports).length) throw new Error("Pen imports require the Pen engine and are not supported by static mode; flatten the imported components first");
  const all = new Map<string, PenNode>();
  const index = (node: PenNode) => { if (all.has(node.id)) throw new Error(`Duplicate Pen node ID: ${node.id}`); all.set(node.id, node); node.children?.forEach(index); };
  document.children.forEach(index);
  const instantiate = (node: PenNode, stack: string[] = []): PenNode => {
    if (node.type !== "ref") return { ...clone(node), children: node.children?.map(child => instantiate(child, stack)) };
    if (stack.includes(node.ref)) throw new Error(`Circular Pen component reference: ${[...stack, node.ref].join(" -> ")}`);
    const source = all.get(node.ref);
    if (!source) throw new Error(`Missing Pen component reference: ${node.ref}`);
    const instanceOverrides = Object.fromEntries(Object.entries(node).filter(([key]) => !["type", "ref", "descendants", "children"].includes(key)));
    const root = instantiate(source, [...stack, node.ref]);
    Object.assign(root, instanceOverrides, { id: node.id, type: source.type, componentSourceId: source.id });
    const descendants = node.descendants ?? {};
    const apply = (current: PenNode, path: string) => {
      const override = descendants[path];
      if (override) {
        if (override.type) Object.assign(current, instantiate(override, [...stack, node.ref]));
        else Object.assign(current, clone(override));
      }
      current.children = current.children?.map(child => {
        const originalId = child.id;
        const childPath = path ? `${path}/${originalId}` : originalId;
        apply(child, childPath);
        child.id = `${node.id}/${childPath}`;
        return child;
      });
    };
    root.children?.forEach(child => { const id = child.id; apply(child, id); child.id = `${node.id}/${id}`; });
    return root;
  };
  return document.children.map(node => instantiate(node));
}

function padding(value: any): [number, number, number, number] {
  if (finite(value)) return [value, value, value, value];
  if (Array.isArray(value) && value.every(finite)) {
    if (value.length === 2) return [value[0], value[1], value[0], value[1]];
    if (value.length === 4) return value as [number, number, number, number];
  }
  return [0, 0, 0, 0];
}

function fallbackSize(value: unknown): number | undefined {
  if (finite(value)) return value;
  if (typeof value !== "string") return undefined;
  const fallback = /\((-?(?:\d+(?:\.\d+)?|\.\d+))\)$/.exec(value);
  return fallback ? Number(fallback[1]) : undefined;
}

function computeBoxes(roots: PenNode[], supplied: PenBounds[]): Map<string, Box> {
  const overrides = new Map<string, PenBounds>(), usedOverrides = new Set<string>();
  for (const item of supplied) {
    if (overrides.has(item.id)) throw new Error(`Duplicate Pen bounds: ${item.id}`);
    overrides.set(item.id, item);
  }
  const boxes = new Map<string, Box>();
  const measuring = new Set<string>();
  const intrinsic = (node: PenNode, axis: "width" | "height"): number | undefined => {
    const suppliedBox = overrides.get(node.id);
    if (suppliedBox) return suppliedBox[axis];
    const direct = fallbackSize(node[axis]);
    if (direct !== undefined) return direct;
    const implicitFit = (node.type === "frame" || node.type === "group") && node[axis] === undefined;
    if ((!implicitFit && (typeof node[axis] !== "string" || !node[axis].startsWith("fit_content"))) || measuring.has(`${node.id}:${axis}`)) return undefined;
    measuring.add(`${node.id}:${axis}`);
    const children = (node.children ?? []).filter(child => child.layoutPosition !== "absolute");
    const mode = node.type === "frame" ? (node.layout ?? "horizontal") : "none";
    const [pt, pr, pb, pl] = padding(node.padding), horizontal = mode === "horizontal", main = horizontal ? "width" : "height";
    let result: number | undefined;
    if (!children.length) result = node.type === "frame" || node.type === "group" ? 0 : undefined;
    else if (mode === "none") {
      const sizes = children.map(child => intrinsic(child, axis));
      if (sizes.every(size => size !== undefined)) result = Math.max(0, ...children.map((child, index) => (finite(child[axis === "width" ? "x" : "y"]) ? child[axis === "width" ? "x" : "y"] : 0) + sizes[index]!));
    } else {
      const sizes = children.map(child => intrinsic(child, axis));
      if (sizes.every(size => size !== undefined)) result = axis === main
        ? (axis === "width" ? pl + pr : pt + pb) + sizes.reduce((sum, size) => sum + size!, 0) + (finite(node.gap) ? node.gap : 0) * Math.max(0, sizes.length - 1)
        : (axis === "width" ? pl + pr : pt + pb) + Math.max(0, ...sizes as number[]);
    }
    measuring.delete(`${node.id}:${axis}`);
    return result;
  };
  const layout = (node: PenNode, x: number, y: number, imposedWidth?: number, imposedHeight?: number): Box => {
    const provided = overrides.get(node.id);
    if (provided) { usedOverrides.add(node.id); boxes.set(node.id, provided); x = provided.x; y = provided.y; imposedWidth = provided.width; imposedHeight = provided.height; }
    let width = imposedWidth ?? intrinsic(node, "width");
    let height = imposedHeight ?? intrinsic(node, "height");
    const children = node.children ?? [];
    const mode = node.type === "frame" ? (node.layout ?? "horizontal") : "none";
    const [pt, pr, pb, pl] = padding(node.padding);
    const gap = finite(node.gap) ? node.gap : 0;
    if ((width === undefined || height === undefined) && children.length && mode !== "none") {
      const provisional = children.filter(child => child.layoutPosition !== "absolute").map(child => ({ child, w: intrinsic(child, "width"), h: intrinsic(child, "height") }));
      if (width === undefined && node.width?.startsWith?.("fit_content") && provisional.every(item => item.w !== undefined)) width = mode === "horizontal" ? pl + pr + provisional.reduce((sum, item) => sum + item.w!, 0) + gap * Math.max(0, provisional.length - 1) : pl + pr + Math.max(0, ...provisional.map(item => item.w!));
      if (height === undefined && node.height?.startsWith?.("fit_content") && provisional.every(item => item.h !== undefined)) height = mode === "vertical" ? pt + pb + provisional.reduce((sum, item) => sum + item.h!, 0) + gap * Math.max(0, provisional.length - 1) : pt + pb + Math.max(0, ...provisional.map(item => item.h!));
    }
    if (!finite(width) || !finite(height) || width < 0 || height < 0) throw new Error(`Pen node ${node.id} has unresolved size; supply numeric width/height, sizing fallback, or penBounds from the Pen engine`);
    const box = provided ?? { x, y, width, height };
    boxes.set(node.id, box);
    if (!children.length) return box;
    if (mode === "none") {
      for (const child of children) layout(child, x + (finite(child.x) ? child.x : 0), y + (finite(child.y) ? child.y : 0));
      return box;
    }
    const horizontal = mode === "horizontal", innerMain = horizontal ? width - pl - pr : height - pt - pb, innerCross = horizontal ? height - pt - pb : width - pl - pr;
    const flowing = children.filter(child => child.layoutPosition !== "absolute");
    const initial = flowing.map(child => ({ child, main: intrinsic(child, horizontal ? "width" : "height"), cross: intrinsic(child, horizontal ? "height" : "width") }));
    const fixed = initial.reduce((sum, item) => sum + (item.main ?? 0), 0) + gap * Math.max(0, initial.length - 1);
    const fills = initial.filter(item => item.child[horizontal ? "width" : "height"]?.startsWith?.("fill_container"));
    const fillSize = fills.length ? Math.max(0, innerMain - fixed) / fills.length : 0;
    for (const item of initial) if (item.main === undefined && fills.includes(item)) item.main = fillSize;
    if (initial.some(item => item.main === undefined)) throw new Error(`Pen layout ${node.id} contains an unresolved main-axis child size; supply penBounds`);
    const used = initial.reduce((sum, item) => sum + item.main!, 0) + gap * Math.max(0, initial.length - 1);
    const free = Math.max(0, innerMain - used);
    let cursor = (horizontal ? pl : pt) + (node.justifyContent === "center" ? free / 2 : node.justifyContent === "end" ? free : node.justifyContent === "space_around" && initial.length ? free / (initial.length * 2) : 0);
    const distributedGap = node.justifyContent === "space_between" && initial.length > 1 ? gap + free / (initial.length - 1) : node.justifyContent === "space_around" && initial.length ? gap + free / initial.length : gap;
    for (const item of initial) {
      const cross = item.cross ?? (item.child[horizontal ? "height" : "width"]?.startsWith?.("fill_container") ? innerCross : undefined);
      if (cross === undefined) throw new Error(`Pen layout ${node.id} contains an unresolved cross-axis child size; supply penBounds`);
      const crossOffset = node.alignItems === "center" ? (innerCross - cross) / 2 : node.alignItems === "end" ? innerCross - cross : 0;
      layout(item.child, x + (horizontal ? cursor : pl + crossOffset), y + (horizontal ? pt + crossOffset : cursor), horizontal ? item.main : cross, horizontal ? cross : item.main);
      cursor += item.main! + distributedGap;
    }
    for (const child of children.filter(child => child.layoutPosition === "absolute")) layout(child, x + (finite(child.x) ? child.x : 0), y + (finite(child.y) ? child.y : 0));
    return box;
  };
  for (const root of roots) layout(root, finite(root.x) ? root.x : 0, finite(root.y) ? root.y : 0);
  const unused = [...overrides.keys()].filter(id => !usedOverrides.has(id));
  if (unused.length) throw new Error(`Pen bounds IDs are not in the exported selection: ${unused.join(", ")}`);
  return boxes;
}

function normalizeDocument(raw: PenDocument, options: ExportOptions) {
  if (!raw || typeof raw.version !== "string" || !/^2\./.test(raw.version) || !Array.isArray(raw.children)) throw new Error("A Pen .pen JSON document with version 2.x is required");
  const { defaults, resolveValue } = variableResolver(raw);
  const resolveNode = (node: PenNode, inheritedTheme: Record<string, string>): PenNode => {
    const theme = { ...inheritedTheme, ...(node.theme ?? {}) };
    const result = clone(node);
    const walk = (value: any): any => Array.isArray(value) ? value.map(walk) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)])) : resolveValue(value, theme);
    for (const key of Object.keys(result)) if (!["children", "descendants"].includes(key)) result[key] = walk(result[key]);
    result.children = result.children?.map(child => resolveNode(child, theme));
    return result;
  };
  let roots = expandRefs(raw).map(node => resolveNode(node, defaults));
  const visible = (node: PenNode): PenNode | null => node.enabled === false || node.opacity === 0 ? null : { ...node, children: node.children?.map(visible).filter(Boolean) as PenNode[] };
  roots = roots.map(visible).filter(Boolean) as PenNode[];
  if (!roots.length) throw new Error("The Pen document is hidden, transparent, or empty");
  const requested = options.nodeIds?.length ? new Set(options.nodeIds) : null;
  let computationRoots = roots;
  if (requested) {
    const byId = new Map<string, PenNode>();
    const parent = new Map<string, string>();
    const visit = (node: PenNode) => { byId.set(node.id, node); node.children?.forEach(child => { parent.set(child.id, node.id); visit(child); }); };
    roots.forEach(visit);
    const selected = [...requested].map(id => byId.get(id) ?? (() => { throw new Error(`Pen node not found: ${id}`); })());
    const containsSelection = (node: PenNode): boolean => requested.has(node.id) || !!node.children?.some(containsSelection);
    computationRoots = roots.filter(containsSelection);
    const boxes = computeBoxes(computationRoots, options.penBounds ?? []);
    roots = selected.filter(node => { for (let id = parent.get(node.id); id; id = parent.get(id)) if (requested.has(id)) return false; return true; });
    return { roots, boxes };
  } else {
    const pages = roots.filter(node => node.reusable !== true);
    if (pages.length) roots = pages;
  }
  const boxes = computeBoxes(roots, options.penBounds ?? []);
  return { roots, boxes };
}

function paints(value: any, assets: Record<string, Record<string, unknown>>, assetFiles: Map<string, string>, penDir: string): any[] {
  return array(value).filter((fill: any) => typeof fill === "string" || fill?.enabled !== false).map((fill: any) => {
    if (typeof fill === "string") {
      const color = hexColor(fill); if (!color) throw new Error(`Invalid Pen fill color: ${fill}`);
      return { type: "SOLID", visible: true, color };
    }
    if (fill.type === "color") {
      const color = hexColor(fill.color); if (!color) throw new Error(`Invalid Pen fill color: ${fill.color}`);
      return { type: "SOLID", visible: true, blendMode: String(fill.blendMode ?? "normal").toUpperCase(), color };
    }
    if (fill.type === "image") {
      if (!fill.url || typeof fill.url !== "string" || /^[a-z]+:/i.test(fill.url)) throw new Error("Pen image fills must use a local path relative to the .pen file");
      const source = resolve(penDir, fill.url);
      const id = `pen-image-${createHash("sha256").update(source).digest("hex").slice(0, 24)}`;
      assets[id] = { id, sourcePath: source, sourceUrl: fill.url, mode: fill.mode ?? "fill" };
      assetFiles.set(id, source);
      return { type: "IMAGE", visible: true, opacity: fill.opacity ?? 1, imageHash: id, scaleMode: String(fill.mode ?? "fill").toUpperCase() };
    }
    return { ...fill, penType: fill.type, type: `PEN_${String(fill.type).toUpperCase()}`, visible: true };
  });
}

async function designFromPen(penPath: string, options: ExportOptions) {
  if (!isAbsolute(penPath) || extname(penPath).toLowerCase() !== ".pen") throw new Error("penPath must be an absolute .pen file path");
  const info = await stat(penPath);
  if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error("penPath must be a .pen file smaller than 64MB");
  const raw = JSON.parse(await readFile(penPath, "utf8")) as PenDocument;
  const { roots, boxes } = normalizeDocument(raw, options);
  const assets: Record<string, Record<string, unknown>> = {}, assetFiles = new Map<string, string>(), penDir = dirname(penPath);
  const rasters = new Map<string, NonNullable<ExportOptions["penRasters"]>[number]>(), usedRasters = new Set<string>();
  for (const item of options.penRasters ?? []) {
    if (rasters.has(item.id)) throw new Error(`Duplicate Pen raster mapping: ${item.id}`);
    rasters.set(item.id, item);
  }
  const convert = (node: PenNode): any => {
    if (["script", "note", "prompt", "context"].includes(node.type)) throw new Error(`Pen node type ${node.type} (${node.id}) cannot be rendered reliably by static export`);
    const bounds = boxes.get(node.id)!;
    const raster = rasters.get(node.id);
    if (raster) {
      if (!isAbsolute(raster.path)) throw new Error(`Pen raster path must be absolute: ${node.id}`);
      if (raster.bounds && raster.bounds.id !== node.id) throw new Error(`Pen raster bounds ID must match raster ID: ${node.id}`);
      usedRasters.add(node.id);
      const imageBounds = raster.bounds ?? { id: node.id, ...bounds };
      const assetId = `pen-raster-${createHash("sha256").update(`${node.id}\0${raster.path}`).digest("hex").slice(0, 24)}`;
      assets[assetId] = { id: assetId, sourcePath: raster.path, bounds: { x: imageBounds.x, y: imageBounds.y, width: imageBounds.width, height: imageBounds.height }, scale: raster.scale ?? 1, opacityBaked: true, sourceNodeId: node.id };
      assetFiles.set(assetId, raster.path);
      const collapsedNodeIds: string[] = [];
      const collect = (current: PenNode) => { collapsedNodeIds.push(current.id); current.children?.forEach(collect); };
      collect(node);
      return { id: node.id, name: node.name ?? node.id, type: node.type.toUpperCase(), absoluteBounds: bounds, width: bounds.width, height: bounds.height, opacity: finite(node.opacity) ? node.opacity : 1,
        renderAs: "image", assetId, imageBounds: { x: imageBounds.x, y: imageBounds.y, width: imageBounds.width, height: imageBounds.height }, imageBoundsSource: "pen-engine-raster", collapsedNodeIds };
    }
    if (finite(node.rotation) && node.rotation !== 0 && !options.penBounds?.some(item => item.id === node.id)) throw new Error(`Rotated Pen node ${node.id} requires penBounds from the Pen engine`);
    const fillList = paints(node.fill, assets, assetFiles, penDir);
    const strokeList = paints(node.stroke, assets, assetFiles, penDir);
    const colorFill = fillList.find(fill => fill.type === "SOLID" && fill.color);
    const visibleSourceFills = array(node.fill).filter((fill: any) => typeof fill === "string" || fill?.enabled !== false);
    const gradientFill = visibleSourceFills.find((fill: any) => fill?.type === "gradient");
    const gradientStroke = array(node.stroke).find((fill: any) => fill?.enabled !== false && fill?.type === "gradient");
    if (gradientStroke || (gradientFill && (visibleSourceFills.length !== 1 || (gradientFill.gradientType ?? "linear") !== "linear" || (gradientFill.center && (gradientFill.center.x !== 0.5 || gradientFill.center.y !== 0.5)) || (gradientFill.size?.height !== undefined && gradientFill.size.height !== 1)))) {
      throw new Error(`Pen node ${node.id} uses a gradient that requires raster export; export that node with the Pen engine and pass penRasters`);
    }
    const corner = Array.isArray(node.cornerRadius) ? { cornerRadii: { topLeft: node.cornerRadius[0], topRight: node.cornerRadius[1], bottomRight: node.cornerRadius[2], bottomLeft: node.cornerRadius[3] } } : finite(node.cornerRadius) ? { cornerRadius: node.cornerRadius } : {};
    const autoLayout = node.type === "frame" && node.layout !== "none" ? { mode: node.layout === "vertical" ? "VERTICAL" : "HORIZONTAL", gap: node.gap ?? 0, padding: padding(node.padding), justifyContent: node.justifyContent ?? "start", alignItems: node.alignItems ?? "start" } : undefined;
    const result: any = {
      id: node.id, name: node.name ?? node.id, type: ({ frame: "FRAME", group: "GROUP", rectangle: "RECTANGLE", ellipse: "ELLIPSE", polygon: "POLYGON", path: "VECTOR", text: "TEXT", icon: "VECTOR" } as Record<string, string>)[node.type] ?? node.type.toUpperCase(),
      absoluteBounds: bounds, width: bounds.width, height: bounds.height, opacity: finite(node.opacity) ? node.opacity : 1,
      clipsContent: node.type === "frame" ? node.clip === true : false, fills: fillList, strokes: strokeList,
      strokeWeight: finite(node.strokeWidth) ? node.strokeWidth : undefined, strokeAlign: String(node.strokeAlignment ?? "center").toUpperCase(), effects: array(node.effect).map((effect: any) => ({ ...effect, type: String(effect.type).toUpperCase(), visible: effect.enabled !== false })),
      blendMode: String(node.blendMode ?? "normal").toUpperCase(), rotation: node.rotation ?? 0, layoutPositioning: node.layoutPosition === "absolute" ? "ABSOLUTE" : "AUTO", autoLayout, ...corner,
      ...(gradientFill ? { sourceGradient: { ...gradientFill, unsupportedComposition: visibleSourceFills.length !== 1 } } : {}),
      ...(node.type === "path" ? { vectorGeometry: node.geometry, viewBox: node.viewBox } : {}),
      ...(node.type === "icon" ? { icon: { library: node.library, name: node.icon, weight: node.weight } } : {}),
      children: node.children?.map(convert),
    };
    if (node.type === "text") {
      const fontSize = finite(node.fontSize) ? node.fontSize : 16, multiplier = finite(node.lineHeight) ? node.lineHeight : null;
      const weight = Number(node.fontWeight ?? 400);
      Object.assign(result, { characters: String(node.content ?? ""), fontName: { family: String(node.fontFamily ?? "sans-serif"), style: String(node.fontStyle ?? "normal") }, fontSize,
        fontWeight: Number.isFinite(weight) ? weight : undefined, letterSpacing: { unit: "PIXELS", value: finite(node.letterSpacing) ? node.letterSpacing : 0 },
        lineHeight: multiplier === null ? undefined : { unit: "PIXELS", value: fontSize * multiplier, source: "pen-multiplier" },
        textAlignHorizontal: String(node.textAlign ?? "left").toUpperCase(), textAlignVertical: String(node.textAlignVertical ?? "top").toUpperCase(),
        textDecoration: node.underline ? "UNDERLINE" : node.strikethrough ? "STRIKETHROUGH" : "NONE", textColor: colorFill?.color ? { rgba: colorFill.color, css: colorFill.color.css } : undefined });
    }
    return result;
  };
  const nodes = roots.map(convert);
  const unused = [...rasters.keys()].filter(id => !usedRasters.has(id));
  if (unused.length) throw new Error(`Pen raster IDs are not in the exported selection: ${unused.join(", ")}`);
  const design = { meta: { schemaVersion: 3, exporterVersion: "pen-static-1", sourceMode: "pen", sourceVersion: raw.version, sourcePath: penPath, selectedNodeIds: roots.map(node => node.id), geometrySource: options.penBounds?.length ? "pen-engine-overrides-with-static-fallback" : "pen-static-layout" }, assets, nodes };
  return { design, assetFiles };
}

export async function penStatus(penPath: string | undefined) {
  if (!penPath) return { connected: false, mode: "pen", ready: false, reason: "penPath is required; pass the absolute path of the open .pen document" };
  try {
    if (!isAbsolute(penPath) || extname(penPath).toLowerCase() !== ".pen") throw new Error("penPath must be an absolute .pen file path");
    const raw = JSON.parse(await readFile(penPath, "utf8"));
    if (!raw || typeof raw.version !== "string" || !/^2\./.test(raw.version) || !Array.isArray(raw.children)) throw new Error("A Pen .pen JSON document with version 2.x is required");
    return { connected: true, mode: "pen", ready: true, penPath, version: raw.version, topLevelNodes: raw.children.map((node: PenNode) => ({ id: node.id, name: node.name ?? node.id, type: node.type, reusable: node.reusable === true })) };
  } catch (error) {
    return { connected: false, mode: "pen", ready: false, penPath, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function exportPen(signal: AbortSignal | undefined, options: ExportOptions) {
  signal?.throwIfAborted();
  if (!options.penPath) throw new Error("mode=pen requires penPath with an absolute .pen file path");
  const { design, assetFiles } = await designFromPen(options.penPath, options);
  const bytes = new Map<string, Buffer>();
  let total = 0;
  for (const [id, path] of assetFiles) {
    signal?.throwIfAborted();
    const info = await stat(path);
    if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error(`Pen image asset must be a file no larger than 32MB: ${path}`);
    total += info.size;
    if (total > 128 * 1024 * 1024) throw new Error("Pen export image payload exceeds 128MB");
    bytes.set(id, await readFile(path));
  }
  return persistExport(design, bytes, options, signal);
}
