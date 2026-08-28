import { renderingRequirements, validateRendering, type RenderStyle, type TextStyle } from "./rendering.js";
import { linearGradient } from "./gradients.js";

export const COLLECTOR_VERSION = 4;

export interface Rect {
  x: number; y: number; width: number; height: number;
  left: number; top: number; right: number; bottom: number;
}
export interface Layer {
  id: string; name: string; type: string; rootId: string; parentId: string | null;
  absoluteBounds: Rect; relativeBounds: Rect; localBounds: Rect;
  renderAs?: string; assetId?: string; collapsedNodeIds?: string[];
  implementation?: ReturnType<typeof renderingRequirements>;
  imageBounds?: Rect; imagePlacement?: Rect; relativeImageBounds?: Rect;
  children?: Layer[];
  [key: string]: unknown;
}
export interface Design {
  meta: { schemaVersion: number; exportId?: string; [key: string]: unknown };
  nodes: Layer[];
  assets: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

export function rect(value: unknown): Rect {
  const input = value as Partial<Rect> | null;
  if (!input || ![input.x, input.y, input.width, input.height].every((n) => typeof n === "number" && Number.isFinite(n)) || input.width! < 0 || input.height! < 0) {
    throw new Error("Invalid layer bounds; reload the Figma plugin and export again");
  }
  const { x, y, width, height } = input as Rect;
  return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height };
}

// Recompute derived geometry in code; never trust rounded or model-inferred edges.
export function prepareDesign(input: unknown): Design {
  const design = structuredClone(input) as Design;
  if (design?.meta?.schemaVersion !== 3 || !Array.isArray(design.nodes) || !design.nodes.length) {
    throw new Error("Export schema v3 is required. Close and reopen Figma JSON Exporter, then export again");
  }
  design.assets ||= {};
  const ids = new Set<string>();
  function visit(layer: Layer, root: Layer, parent: Layer | null): void {
    if (!layer.id || ids.has(layer.id)) throw new Error(`Missing or duplicate design layer ID: ${layer.id}`);
    ids.add(layer.id);
    layer.absoluteBounds = rect(layer.absoluteBounds);
    layer.rootId = root.id;
    layer.parentId = parent?.id ?? null;
    const b = layer.absoluteBounds, origin = root.absoluteBounds, p = parent?.absoluteBounds ?? origin;
    layer.relativeBounds = rect({ x: b.x - origin.x, y: b.y - origin.y, width: b.width, height: b.height });
    layer.localBounds = rect({ x: b.x - p.x, y: b.y - p.y, width: b.width, height: b.height });
    if (layer.renderAs === "image" && layer.children?.length) throw new Error(`Collapsed image layer ${layer.id} must be a leaf`);
    if (layer.imageBounds) {
      layer.imageBounds = rect(layer.imageBounds);
      const image = layer.imageBounds;
      if (image.left > b.left || image.top > b.top || image.right < b.right || image.bottom < b.bottom) throw new Error(`Raster canvas must contain layout bounds: ${layer.id}`);
      layer.imagePlacement = rect({ x: image.x - b.x, y: image.y - b.y, width: image.width, height: image.height });
      layer.relativeImageBounds = rect({ x: image.x - origin.x, y: image.y - origin.y, width: image.width, height: image.height });
    }
    layer.implementation = renderingRequirements(layer);
    layer.gradient = linearGradient(layer);
    for (const child of layer.children ?? []) visit(child, root, layer);
  }
  for (const root of design.nodes) visit(root, root, null);
  return design;
}

export function flattenLayers(design: Design): Array<Layer & { depth: number }> {
  const layers: Array<Layer & { depth: number }> = [];
  function visit(node: Layer, depth: number) {
    layers.push({ ...node, depth });
    for (const child of node.children ?? []) visit(child, depth + 1);
  }
  for (const node of design.nodes) visit(node, 0);
  return layers;
}

export interface ActualLayer {
  id: string; rootId: string | null; parentId: string | null;
  bounds: { x: number; y: number; width: number; height: number };
  visible: boolean;
  tagName?: string;
  imageSources?: string[];
  textStyle?: TextStyle;
  renderStyle?: RenderStyle;
  assetImages?: Array<{ assetId: string; src: string; bounds: { x: number; y: number; width: number; height: number }; naturalWidth: number; naturalHeight: number; opacity: number | null; objectFit: string }>;
}
export interface ActualLayout {
  collectorVersion?: number;
  coordinateSpace: "root-relative";
  nodes: ActualLayer[];
  stable: boolean;
  brokenImages?: string[];
  fontsReady?: boolean;
  viewport?: { width: number; height: number; devicePixelRatio: number };
}

export function validateLayout(designInput: unknown, actual: ActualLayout, tolerance = 1) {
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 10) throw new Error("Tolerance must be between 0 and 10 CSS pixels");
  if (actual?.coordinateSpace !== "root-relative" || !Array.isArray(actual.nodes)) throw new Error("Use the exported collector: actual geometry must be root-relative");
  const design = prepareDesign(designInput);
  const expected = flattenLayers(design);
  const expectedIds = new Set(expected.map((n) => n.id));
  const actualById = new Map<string, ActualLayer>();
  const duplicates: string[] = [];
  for (const node of actual.nodes) {
    if (actualById.has(node.id)) duplicates.push(node.id);
    else actualById.set(node.id, node);
  }
  const unexpected = actual.nodes.filter((n) => !expectedIds.has(n.id)).map((n) => n.id);
  const missing: string[] = [];
  const fields = ["left", "top", "right", "bottom", "width", "height"] as const;
  const layers = expected.map((node) => {
    const found = actualById.get(node.id);
    if (!found) {
      missing.push(node.id);
      return { id: node.id, name: node.name, depth: node.depth, passed: false, reason: "missing", expected: node.relativeBounds };
    }
    const bounds = rect(found.bounds);
    const delta = Object.fromEntries(fields.map((field) => [field, bounds[field] - node.relativeBounds[field]]));
    const maxError = Math.max(...Object.values(delta).map(Math.abs));
    const hierarchyMatches = found.rootId === node.rootId && found.parentId === node.parentId;
    const assetIds = node.assetId ? [node.assetId] : ["fills", "strokes"].flatMap((property) => {
      const paints = node[property];
      return Array.isArray(paints) ? paints.filter((p) => p.type === "IMAGE" && p.visible !== false && p.opacity !== 0 && p.imageHash).map((p) => p.imageHash as string) : [];
    });
    const missingAssets = assetIds.filter((id) => {
      const asset = design.assets[id];
      const filename = String(asset?.relativePath ?? asset?.path ?? "").split("/").pop();
      const sources = node.imageBounds ? (found.assetImages ?? []).filter((img) => img.assetId === node.assetId).map((img) => img.src) : found.imageSources ?? [];
      return !filename || !sources.some((src) => {
        try { return decodeURIComponent(new URL(src, "http://local.invalid/").pathname).split("/").pop() === filename; } catch { return false; }
      });
    });
    const imageMatches = !missingAssets.length && (!node.assetId || !!node.imageBounds || found.tagName === "IMG");
    const lineHeight = node.lineHeight as { unit?: string; value?: number; pixels?: number | null } | undefined;
    const expectedLineHeight = lineHeight?.unit === "PIXELS" ? lineHeight.value : lineHeight?.unit === "PERCENT" && typeof node.fontSize === "number" ? node.fontSize * lineHeight.value! / 100 : lineHeight?.unit === "AUTO" ? lineHeight.pixels : null;
    const checkLineHeight = node.type === "TEXT" && node.renderAs !== "image" && typeof expectedLineHeight === "number" && Number.isFinite(expectedLineHeight);
    const actualLineHeight = found.textStyle?.lineHeight;
    const lineHeightMatches = !checkLineHeight || (typeof actualLineHeight === "number" && Math.abs(actualLineHeight - expectedLineHeight!) <= tolerance);
    const propertyMismatches = validateRendering(node, found, design, tolerance);
    return {
      id: node.id, name: node.name, depth: node.depth, parentId: node.parentId,
      passed: maxError <= tolerance && hierarchyMatches && imageMatches && lineHeightMatches && !propertyMismatches.length && found.visible === true && !duplicates.includes(node.id),
      reason: duplicates.includes(node.id) ? "duplicate-id" : !found.visible ? "hidden-in-implementation" : !hierarchyMatches ? "hierarchy-mismatch" : !imageMatches ? "image-missing-or-wrong-source" : !lineHeightMatches ? "line-height-mismatch" : propertyMismatches.length ? "rendering-property-mismatch" : maxError > tolerance ? "geometry-mismatch" : "matched",
      expected: node.relativeBounds, actual: bounds, delta, maxError,
      missingAssets, propertyMismatches, ...(checkLineHeight ? { expectedLineHeight, actualLineHeight: actualLineHeight ?? null } : {}),
    };
  });
  const failed = layers.filter((n) => !n.passed).sort((a, b) => a.depth - b.depth);
  const environmentReady = actual.stable === true && actual.fontsReady === true && !(actual.brokenImages?.length);
  const collectorCompatible = actual.collectorVersion === COLLECTOR_VERSION && actual.nodes.every((n) => {
    const style = n.renderStyle;
    return style && typeof style.opacity === "number" && Number.isFinite(style.opacity)
      && [style.position, style.overflowX, style.overflowY, style.clipPath, style.maskImage, style.contain].every((v) => typeof v === "string")
      && [style.borderBoxWidth, style.borderBoxHeight].every((v) => v === null || (typeof v === "number" && Number.isFinite(v)))
      && Array.isArray(style.cornerRadii) && style.cornerRadii.length === 4 && style.cornerRadii.every((v) => typeof v === "string")
      && Array.isArray(style.wrapperEffects) && style.wrapperEffects.every((v) => typeof v === "string");
  });
  const reviewRequired = expected.filter((n) => n.implementation!.review.length).map((n) => ({ id: n.id, name: n.name, properties: n.implementation!.review }));
  return {
    passed: failed.length === 0 && duplicates.length === 0 && unexpected.length === 0 && environmentReady && collectorCompatible,
    scope: "automated geometry, image references/placement/pixel dimensions, clipping, opacity, ordinary corner radii, text metrics/colors and linear gradient direction/stops/paint box only; not full visual or interaction acceptance",
    collectorCompatible, requiredCollectorVersion: COLLECTOR_VERSION,
    visualAcceptance: "not-verified", reviewRequired,
    sourceCoverage: design.meta.exporterVersion === "3.4.1" ? "v3.4" : "legacy export: newly added properties may be absent; re-export for full property coverage",
    tolerance, total: layers.length, matched: layers.length - failed.length,
    missing, duplicates, unexpected, environmentReady,
    stable: actual.stable, fontsReady: actual.fontsReady, brokenImages: actual.brokenImages ?? [],
    maxError: Math.max(0, ...layers.map((n) => "maxError" in n ? n.maxError : 0)),
    nextAction: !collectorCompatible ? "Run the NEW exported collector; legacy or incomplete measurements cannot pass" : failed.length ? "Fix parent layers and propertyMismatches first; preserve data-d2c-id; remeasure until passed. Do not edit targets or invent measurements." : !environmentReady ? "Wait for fonts, images and stable layout, then collect again" : unexpected.length || duplicates.length ? "Fix duplicate/unexpected IDs, then collect again" : "Automated checks passed ONLY. Inspect reviewRequired and perform visual/interaction review; do not claim full fidelity from this report.",
    failed, layers,
  };
}

// This self-contained function runs in the implementation page, not in Node.
// It reads DOM geometry; it never adjusts elements to make the check pass.
export async function collectLayout(): Promise<ActualLayout> {
  await document.fonts.ready;
  await Promise.all(Array.from(document.images).map((img) => img.decode().catch(() => {})));
  function sample() {
    return Array.from(document.querySelectorAll<HTMLElement>("[data-d2c-id]")).map((element) => {
      const root = element.closest<HTMLElement>("[data-d2c-root]");
      const box = element.getBoundingClientRect(), origin = root?.getBoundingClientRect();
      const computed = getComputedStyle(element);
      const number = (value: string) => Number.isFinite(Number.parseFloat(value)) ? Number.parseFloat(value) : null;
      const dimension = (axis: "width" | "height") => {
        const size = number(computed[axis]);
        if (size === null || computed.boxSizing === "border-box") return size;
        const sides = axis === "width" ? [computed.paddingLeft, computed.paddingRight, computed.borderLeftWidth, computed.borderRightWidth] : [computed.paddingTop, computed.paddingBottom, computed.borderTopWidth, computed.borderBottomWidth];
        return size + sides.reduce((sum, v) => sum + (number(v) ?? 0), 0);
      };
      const wrapperEffects: string[] = [];
      // Only intermediate wrappers inside a selection root are part of this
      // contract; the page hosting separate selection roots is not a design node.
      if (element !== root) for (let wrapper = element.parentElement; wrapper && !wrapper.hasAttribute("data-d2c-id"); wrapper = wrapper.parentElement) {
        const css = getComputedStyle(wrapper);
        for (const prop of ["overflowX", "overflowY", "clipPath", "maskImage", "filter", "backdropFilter", "mixBlendMode", "opacity", "contain"] as const) {
          const value = css[prop];
          const unsafe = prop === "opacity" ? Number(value) !== 1 : prop === "contain" ? /\b(paint|strict|content)\b/.test(value) : !!value && !["visible", "none", "normal"].includes(value);
          if (unsafe) wrapperEffects.push(`${prop}:${value}`);
        }
      }
      const imageSources: string[] = [];
      if (element.tagName === "IMG") imageSources.push((element as unknown as HTMLImageElement).currentSrc || (element as unknown as HTMLImageElement).src);
      for (const match of (computed.backgroundImage || "").matchAll(/url\(["']?([^"')]+)["']?\)/g)) imageSources.push(match[1]!);
      const assetImages = [element, ...Array.from(element.querySelectorAll<HTMLElement>("img[data-d2c-asset]"))]
        .filter((img) => img.tagName === "IMG" && img.dataset.d2cAsset && img.closest("[data-d2c-id]") === element)
        .map((el) => {
          const img = el as HTMLImageElement, b = img.getBoundingClientRect(), css = getComputedStyle(img);
          return { assetId: img.dataset.d2cAsset!, src: img.currentSrc || img.src, bounds: { x: b.x - (origin?.x ?? 0), y: b.y - (origin?.y ?? 0), width: b.width, height: b.height }, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, opacity: number(css.opacity), objectFit: css.objectFit };
        });
      let visible = true;
      for (let current: HTMLElement | null = element; current; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) visible = false;
      }
      return {
        id: element.dataset.d2cId!, rootId: root?.dataset.d2cId ?? null,
        parentId: element === root ? null : element.parentElement?.closest<HTMLElement>("[data-d2c-id]")?.dataset.d2cId ?? null,
        bounds: { x: box.x - (origin?.x ?? 0), y: box.y - (origin?.y ?? 0), width: box.width, height: box.height }, visible,
        tagName: element.tagName, imageSources, assetImages,
        renderStyle: { backgroundImage: computed.backgroundImage, backgroundOrigin: computed.backgroundOrigin, backgroundClip: computed.backgroundClip, backgroundSize: computed.backgroundSize, backgroundPosition: computed.backgroundPosition, opacity: number(computed.opacity), position: computed.position, overflowX: computed.overflowX, overflowY: computed.overflowY, clipPath: computed.clipPath, maskImage: computed.maskImage, contain: computed.contain, borderBoxWidth: dimension("width"), borderBoxHeight: dimension("height"), cornerRadii: [computed.borderTopLeftRadius, computed.borderTopRightRadius, computed.borderBottomRightRadius, computed.borderBottomLeftRadius], wrapperEffects },
        textStyle: { color: computed.color, textFillColor: computed.webkitTextFillColor || computed.color, fontSize: number(computed.fontSize), lineHeight: computed.lineHeight === "normal" ? null : number(computed.lineHeight), fontWeight: number(computed.fontWeight), fontStyle: computed.fontStyle, letterSpacing: computed.letterSpacing === "normal" ? 0 : number(computed.letterSpacing), textAlign: computed.textAlign, direction: computed.direction, textDecorationLine: computed.textDecorationLine },
      };
    });
  }
  let previous = sample(), nodes = previous, stable = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    nodes = sample();
    stable = JSON.stringify(nodes) === JSON.stringify(previous);
    if (stable) break;
    previous = nodes;
  }
  return {
    collectorVersion: 4, coordinateSpace: "root-relative", nodes, stable, fontsReady: document.fonts.status === "loaded",
    brokenImages: Array.from(document.images).filter((img) => !img.complete || !img.naturalWidth).map((img) => img.currentSrc || img.src),
    viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
  };
}
