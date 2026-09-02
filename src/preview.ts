import { flattenLayers, prepareDesign, type Design, type Layer, type Rect } from "./geometry.js";
import { semanticPlan } from "./semantics.js";

type PreviewPrimitive = "block-flow" | "inline-flow" | "flex-row" | "flex-column" | "layered-flow";
type PreviewRole = "background" | "content" | "decoration" | "overlay";

interface ContainerDecision {
  id: string;
  primitive: PreviewPrimitive;
  contentFlow: Exclude<PreviewPrimitive, "layered-flow">;
  source: "semantic-plan" | "single-child-default" | "empty";
  childOrder: string[];
  backgroundIds: string[];
  overlayIds: string[];
  contentRows: string[][];
  fallback: "layered-flow";
}

interface PlacementDecision {
  id: string;
  parentId: string | null;
  role: PreviewRole;
  alignment: "left" | "center" | "right" | "free";
}

type RenderUnit = { kind: "single"; layer: Layer } | { kind: "row"; layers: Layer[]; className: string };

export interface PreviewBundle {
  html: string;
  css: string;
  manifest: {
    schemaVersion: 1;
    renderer: "deterministic-preview-v1";
    purpose: string;
    limitations: string[];
    roots: string[];
    containers: ContainerDecision[];
    placements: PlacementDecision[];
    repeatGroups: ReturnType<typeof semanticPlan>["repeatGroups"];
    reviewRequired: Array<{ id: string; reason: string }>;
  };
}

const esc = (value: unknown): string => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const px = (value: unknown): string => `${Number(value ?? 0).toFixed(4).replace(/\.0+$|(?<=\.[0-9]*?)0+$/g, "")}px`;
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" ? value as Record<string, unknown> : undefined;

function visiblePaints(layer: Layer, property: "fills" | "strokes"): Array<Record<string, unknown>> {
  const paints = layer[property];
  return Array.isArray(paints) ? paints.map(record).filter((paint): paint is Record<string, unknown> => Boolean(paint) && paint!.visible !== false && paint!.opacity !== 0) : [];
}

function hasMeaningfulText(layer: Layer): boolean {
  if (layer.type === "TEXT" && String(layer.characters ?? "").trim()) return true;
  return (layer.children ?? []).some(hasMeaningfulText);
}

function isVisualLayer(layer: Layer): boolean {
  return layer.renderAs === "image" || visiblePaints(layer, "fills").length > 0 || visiblePaints(layer, "strokes").length > 0 || Array.isArray(layer.effects) && layer.effects.length > 0;
}

function overlapArea(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}

function backgroundIds(parent: Layer, ordered: Layer[]): string[] {
  const area = Math.max(1, parent.absoluteBounds.width * parent.absoluteBounds.height);
  return ordered.filter((child, index) => {
    const coverage = child.absoluteBounds.width * child.absoluteBounds.height / area;
    const widthCoverage = child.absoluteBounds.width / Math.max(1, parent.absoluteBounds.width);
    const topAnchored = Math.abs(child.localBounds.y) <= Math.max(1, parent.absoluteBounds.height * 0.005);
    const sectionalBackdrop = widthCoverage >= 0.85 && topAnchored;
    const overlapsLaterContent = ordered.slice(index + 1).some(other => overlapArea(child.absoluteBounds, other.absoluteBounds) > 1);
    return index < Math.max(1, Math.ceil(ordered.length / 2)) && (coverage >= 0.85 || sectionalBackdrop) && overlapsLaterContent && isVisualLayer(child) && !hasMeaningfulText(child);
  }).map(child => child.id);
}

function overlayIds(parent: Layer, ordered: Layer[], backgrounds: string[]): string[] {
  const width = Math.max(1, parent.absoluteBounds.width), height = Math.max(1, parent.absoluteBounds.height), area = width * height;
  const bottomTolerance = Math.max(1, height * 0.01);
  return ordered.filter((child, index) => {
    if (backgrounds.includes(child.id) || child.layoutPositioning === "ABSOLUTE" || child.renderAs === "image") return false;
    const anchoredToBottom = Math.abs(height - child.localBounds.bottom) <= bottomTolerance;
    const broad = child.absoluteBounds.width / width >= 0.85;
    const overlapsEarlierContent = ordered.slice(0, index).some(other => !backgrounds.includes(other.id) && overlapArea(child.absoluteBounds, other.absoluteBounds) > 1);
    const childArea = child.absoluteBounds.width * child.absoluteBounds.height;
    const overlaysLargeSibling = childArea / area <= 0.5 && ordered.slice(0, index).some(other => {
      if (backgrounds.includes(other.id)) return false;
      const otherArea = other.absoluteBounds.width * other.absoluteBounds.height;
      return otherArea / area >= 0.7 && overlapArea(child.absoluteBounds, other.absoluteBounds) >= childArea * 0.5;
    });
    return anchoredToBottom && broad && child.localBounds.y >= height * 0.5 && overlapsEarlierContent || overlaysLargeSibling;
  }).map(child => child.id);
}

// Group non-overlapping content into rows by vertical midline, then order each
// row left-to-right by horizontal midline. This preserves a 2D arrangement as
// stacked rows of inline content instead of flattening every item into a single
// wrapping flex line (which shifts items onto the wrong row and misaligns them).
const midX = (layer: Layer) => layer.localBounds.x + layer.localBounds.width / 2;
const midY = (layer: Layer) => layer.localBounds.y + layer.localBounds.height / 2;

function rowTolerance(a: Layer, b: Layer): number {
  return Math.max(2, Math.min(a.localBounds.height, b.localBounds.height) * 0.5);
}

function groupRows(children: Layer[]): Layer[][] {
  if (!children.length) return [];
  const sorted = [...children].sort((a, b) => midY(a) - midY(b) || midX(a) - midX(b));
  const rows: Layer[][] = [];
  for (const child of sorted) {
    const last = rows[rows.length - 1];
    const anchor = last?.[last.length - 1];
    if (anchor && Math.abs(midY(child) - midY(anchor)) <= rowTolerance(anchor, child)) last.push(child);
    else rows.push([child]);
  }
  return rows.map(row => [...row].sort((a, b) => midX(a) - midX(b) || midY(a) - midY(b)));
}

const rowTop = (row: Layer[]): number => Math.min(...row.map(child => child.localBounds.y));
const rowBottom = (row: Layer[]): number => Math.max(...row.map(child => child.localBounds.y + child.localBounds.height));

// Rough visual reading order for the DOM: top-to-bottom, then left-to-right by
// positioning midline. Stacking stays correct via z-index (paint order), so the
// source order can follow reading order.
const visualSort = (children: Layer[]): Layer[] => [...children].sort((a, b) => midY(a) - midY(b) || midX(a) - midX(b));

// True when any two content children overlap. Overlapping content cannot be
// expressed as document flow (inline/block would drop the overlap and stack or
// spread the items); it must keep its exported coordinates as an absolute layout.
function contentOverlaps(children: Layer[]): boolean {
  return children.some((child, index) => children.slice(index + 1).some(other => overlapArea(child.localBounds, other.localBounds) > 0.5));
}

// A single horizontal row maps to inline flow; a single vertical column maps to
// block flow; multiple rows with multiple columns map to a wrapping row layout.
function contentFlow(children: Layer[]): Exclude<PreviewPrimitive, "layered-flow"> {
  if (children.length <= 1) return "block-flow";
  const rows = groupRows(children);
  if (rows.length === 1) return "inline-flow";
  if (rows.every(row => row.length === 1)) return "block-flow";
  return "flex-row";
}

function alignment(child: Layer, parent: Layer): PlacementDecision["alignment"] {
  const box = child.localBounds, width = parent.absoluteBounds.width;
  const tolerance = Math.max(1, width * 0.005);
  const errors = {
    left: Math.abs(box.x),
    center: Math.abs(box.x + box.width / 2 - width / 2),
    right: Math.abs(width - box.x - box.width),
  };
  const winner = (Object.entries(errors) as Array<["left" | "center" | "right", number]>).sort((a, b) => a[1] - b[1])[0];
  return winner[1] <= tolerance ? winner[0] : "free";
}

interface Placement {
  primitive: PreviewPrimitive | null;
  role: PreviewRole;
  align: PlacementDecision["alignment"];
  previous: Layer | null;
  rowTop: number;
  inRow: boolean;
  absolute: boolean;
  rotation: number;
}

// A rotated layer's exported absoluteBounds is its axis-aligned bounding box, which
// is wider/taller than its unrotated width/height. Position the element by its
// center so `rotate` (around the default center origin) lands the box correctly.
function placementCSS(node: Layer, parent: Layer | null, placement: Placement): string[] {
  if (!parent || !placement.primitive) return [];
  const box = node.localBounds;
  const nodeWidth = typeof node.width === "number" ? node.width : null;
  const nodeHeight = typeof node.height === "number" ? node.height : null;
  const rotated = placement.rotation !== 0 && nodeWidth !== null && nodeHeight !== null;
  if (placement.absolute || (placement.primitive === "layered-flow" && (placement.role !== "content" || node.layoutPositioning === "ABSOLUTE"))) {
    const left = rotated ? box.x + (box.width - nodeWidth!) / 2 : box.x;
    const top = rotated ? box.y + (box.height - nodeHeight!) / 2 : box.y;
    return ["position:absolute", `left:${px(left)}`, `top:${px(top)}`];
  }
  if (placement.inRow) {
    const previousRight = placement.previous ? placement.previous.localBounds.x + placement.previous.localBounds.width : 0;
    return ["display:inline-block", `margin-left:${px(Math.max(0, box.x - previousRight))}`, `margin-top:${px(Math.max(0, box.y - placement.rowTop))}`, "vertical-align:top"];
  }
  if (placement.primitive === "inline-flow" || placement.primitive === "flex-row") {
    const previousRight = placement.previous ? placement.previous.localBounds.x + placement.previous.localBounds.width : 0;
    return [placement.primitive === "inline-flow" ? "display:inline-block" : "flex:none", `margin-left:${px(Math.max(0, box.x - previousRight))}`, `margin-top:${px(Math.max(0, box.y))}`, "vertical-align:top"];
  }
  const previousBottom = placement.previous ? placement.previous.localBounds.y + placement.previous.localBounds.height : 0;
  const rules = [`margin-top:${px(Math.max(0, box.y - previousBottom))}`];
  if (placement.align === "center") rules.push("margin-left:auto", "margin-right:auto");
  else if (placement.align === "right") rules.push("margin-left:auto");
  else if (box.x > 0) rules.push(`margin-left:${px(box.x)}`);
  if (placement.primitive === "flex-column") rules.push("flex:none");
  return rules;
}

function paintCSS(node: Layer, design: Design): string[] {
  const rules: string[] = [];
  // Atomic raster assets already contain their real vector/path silhouette, paints,
  // strokes, effects and rotation. Re-applying those properties to the wrapper
  // turns the axis-aligned bounds into visible black/white blocks or rectangular
  // outlines around icons and charts.
  if (node.renderAs === "image") {
    if (node.clipsContent) rules.push("overflow:hidden");
    return rules;
  }
  const fills = visiblePaints(node, "fills");
  const solid = [...fills].reverse().find(paint => paint.type === "SOLID" && typeof paint.color === "string");
  const image = [...fills].reverse().find(paint => paint.type === "IMAGE" && typeof paint.imageHash === "string");
  const gradient = record(node.gradient);
  if (node.type === "TEXT") {
    const color = record(node.textColor)?.css ?? solid?.color;
    if (typeof color === "string") rules.push(`color:${color}`);
  } else if (typeof gradient?.css === "string") rules.push(`background-image:${gradient.css}`);
  else if (image) {
    const asset = design.assets[String(image.imageHash)];
    if (typeof asset?.relativePath === "string") rules.push(`background-image:url("../${asset.relativePath}")`, "background-size:100% 100%", "background-repeat:no-repeat");
  } else if (typeof solid?.color === "string") rules.push(`background-color:${solid.color}`);

  const strokes = visiblePaints(node, "strokes");
  const stroke = strokes.find(paint => paint.type === "SOLID" && typeof paint.color === "string");
  if (stroke) rules.push(`outline:${px(typeof node.strokeWeight === "number" ? node.strokeWeight : 1)} solid ${stroke.color}`, "outline-offset:-1px");
  const radii = record(node.cornerRadii);
  if (radii && [radii.topLeft, radii.topRight, radii.bottomRight, radii.bottomLeft].every(value => typeof value === "number")) {
    rules.push(`border-radius:${px(radii.topLeft)} ${px(radii.topRight)} ${px(radii.bottomRight)} ${px(radii.bottomLeft)}`);
  } else if (typeof node.cornerRadius === "number" && node.cornerRadius > 0) rules.push(`border-radius:${px(node.cornerRadius)}`);
  // A Figma ELLIPSE carries no cornerRadius; its full inscribed oval is expressed
  // by a 50% radius on both axes (a circle for a square box, an oval otherwise).
  else if (node.type === "ELLIPSE") rules.push("border-radius:50%");
  if (node.clipsContent) rules.push("overflow:hidden");
  if (typeof node.opacity === "number" && node.opacity !== 1) rules.push(`opacity:${node.opacity}`);
  if (typeof node.rotation === "number" && node.rotation !== 0) rules.push(`rotate:${node.rotation}deg`);
  return rules;
}

function textStyleCSS(value: Record<string, unknown>): string[] {
  const font = record(value.fontName), lineHeight = record(value.lineHeight), letterSpacing = record(value.letterSpacing), textColor = record(value.textColor);
  const rules: string[] = [];
  if (typeof font?.family === "string") rules.push(`font-family:${JSON.stringify(font.family)}`);
  if (typeof value.fontSize === "number") rules.push(`font-size:${px(value.fontSize)}`);
  if (typeof value.fontWeight === "number") rules.push(`font-weight:${value.fontWeight}`);
  if (typeof lineHeight?.css === "string") rules.push(`line-height:${lineHeight.css}`);
  if (typeof letterSpacing?.css === "string") rules.push(`letter-spacing:${letterSpacing.css}`);
  if (typeof textColor?.css === "string") rules.push(`color:${textColor.css}`);
  const decoration = { UNDERLINE: "underline", STRIKETHROUGH: "line-through", NONE: "none" }[String(value.textDecoration)] as string | undefined;
  if (decoration) rules.push(`text-decoration-line:${decoration}`);
  const textTransform = { UPPER: "uppercase", LOWER: "lowercase", TITLE: "capitalize", ORIGINAL: "none" }[String(value.textCase)] as string | undefined;
  if (textTransform) rules.push(`text-transform:${textTransform}`);
  return rules;
}

function textCSS(node: Layer): string[] {
  if (node.type !== "TEXT") return [];
  // Preserve explicit source newlines without introducing browser soft-wraps.
  // `pre-wrap` + `anywhere` incorrectly broke selectable styled text merely
  // because its measured Figma box was narrower than the browser glyph run.
  const rules = ["white-space:pre", "overflow-wrap:normal", "word-break:normal", ...textStyleCSS(node)];
  if (typeof node.textAlignHorizontal === "string") rules.push(`text-align:${node.textAlignHorizontal.toLowerCase()}`);
  return rules;
}

function imageMarkup(node: Layer, design: Design): string {
  if (node.renderAs !== "image" || !node.assetId) return "";
  const asset = design.assets[node.assetId];
  if (typeof asset?.relativePath !== "string") return "";
  return `<img class="d2c-asset" data-d2c-asset="${esc(node.assetId)}" alt="" src="../${esc(asset.relativePath)}">`;
}

export function generatePreview(input: unknown): PreviewBundle {
  const design = prepareDesign(input);
  const semantics = semanticPlan(design);
  const layers = flattenLayers(design);
  const classById = new Map(layers.map((layer, index) => [layer.id, `d2c-n-${index + 1}`]));
  const strategyById = new Map(semantics.containers.map(container => [container.id, container.layoutStrategy.preferred as PreviewPrimitive]));
  const orderById = new Map(semantics.containers.map(container => [container.id, container.codeOrder]));
  const containerDecisions: ContainerDecision[] = [];
  const placementDecisions: PlacementDecision[] = [];
  const roleById = new Map<string, PreviewRole>();
  const primitiveById = new Map<string, PreviewPrimitive>();
  const contentFlowById = new Map<string, Exclude<PreviewPrimitive, "layered-flow">>();
  const orderedById = new Map<string, Layer[]>();
  const multiRowById = new Map<string, boolean>();
  const contentAbsoluteById = new Map<string, boolean>();
  const paintOrderById = new Map<string, number>();
  const renderUnitsById = new Map<string, RenderUnit[]>();
  const rowTopById = new Map<string, number>();
  const prevInRowById = new Map<string, Layer | null>();
  const inRowById = new Map<string, boolean>();
  const rowMarginByClass = new Map<string, number>();
  let rowClassCounter = 0;

  for (const parent of layers) {
    const children = parent.children ?? [];
    if (!children.length) continue;
    const order = orderById.get(parent.id);
    const byId = new Map(children.map(child => [child.id, child]));
    const ordered = order ? [...order.map(id => byId.get(id)).filter((node): node is Layer => Boolean(node)), ...children.filter(child => !order.includes(child.id))] : children;
    ordered.forEach((child, index) => paintOrderById.set(child.id, index + 1));
    const backgrounds = backgroundIds(parent, ordered);
    const overlays = overlayIds(parent, ordered, backgrounds);
    const primitive = strategyById.get(parent.id) ?? (children.length === 1 ? "block-flow" : "layered-flow");
    for (const child of ordered) {
      const atomicPaintLayer = primitive === "layered-flow" && child.renderAs === "image";
      const smallVisualLayer = primitive === "layered-flow" && isVisualLayer(child) && !hasMeaningfulText(child) && child.absoluteBounds.width * child.absoluteBounds.height < parent.absoluteBounds.width * parent.absoluteBounds.height * 0.25;
      roleById.set(child.id, backgrounds.includes(child.id) ? "background" : overlays.includes(child.id) ? "overlay" : atomicPaintLayer || smallVisualLayer ? "decoration" : "content");
    }
    const flowChildren = ordered.filter(child => (roleById.get(child.id) ?? "content") === "content" && child.layoutPositioning !== "ABSOLUTE");
    const rows = groupRows(flowChildren);
    const flow = contentFlow(flowChildren);
    const multiRow = rows.length > 1 && rows.some(row => row.length > 1);
    const contentAbsolute = contentOverlaps(flowChildren);
    // The DOM follows a rough top-to-bottom, left-to-right reading order. Stacking
    // is handled separately by z-index (paint order), so source order is free to be
    // readable. Backgrounds lead, then content in visual order, then overlays and
    // decorations in visual order.
    const previewOrder = primitive === "layered-flow"
      ? [...visualSort(ordered.filter(child => (roleById.get(child.id) ?? "content") === "background")), ...rows.flat(), ...visualSort(ordered.filter(child => !["background", "content"].includes(roleById.get(child.id) ?? "content") || child.layoutPositioning === "ABSOLUTE"))]
      : ordered;

    // Multi-row content is wrapped in inline row boxes so the browser stacks rows
    // vertically instead of flattening them into one long, wrapping line. When the
    // rows overlap, no document flow can reproduce their positions, so every child
    // keeps its exported coordinates as an absolute layout.
    let units: RenderUnit[];
    if (multiRow && !contentAbsolute) {
      const backgroundUnits = visualSort(ordered.filter(child => roleById.get(child.id) === "background")).map(child => ({ kind: "single" as const, layer: child }));
      const overlayUnits = visualSort(ordered.filter(child => {
        const role = roleById.get(child.id) ?? "content";
        return role !== "background" && (role !== "content" || child.layoutPositioning === "ABSOLUTE");
      })).map(child => ({ kind: "single" as const, layer: child }));
      const rowUnits = rows.map((row, rowIndex) => {
        const className = `d2c-row-${++rowClassCounter}`;
        const top = rowTop(row);
        rowMarginByClass.set(className, Math.max(0, top - (rowIndex === 0 ? 0 : rowBottom(rows[rowIndex - 1]))));
        for (let index = 0; index < row.length; index++) {
          const child = row[index];
          rowTopById.set(child.id, top);
          prevInRowById.set(child.id, index > 0 ? row[index - 1] : null);
          inRowById.set(child.id, true);
        }
        return { kind: "row" as const, layers: row, className };
      });
      units = [...backgroundUnits, ...rowUnits, ...overlayUnits];
    } else {
      units = previewOrder.map(child => ({ kind: "single" as const, layer: child }));
    }

    primitiveById.set(parent.id, primitive);
    contentFlowById.set(parent.id, flow);
    orderedById.set(parent.id, previewOrder);
    multiRowById.set(parent.id, multiRow);
    contentAbsoluteById.set(parent.id, contentAbsolute);
    renderUnitsById.set(parent.id, units);
    containerDecisions.push({ id: parent.id, primitive, contentFlow: flow, source: strategyById.has(parent.id) ? "semantic-plan" : "single-child-default", childOrder: previewOrder.map(child => child.id), backgroundIds: backgrounds, overlayIds: overlays, contentRows: rows.map(row => row.map(child => child.id)), fallback: "layered-flow" });
  }

  const cssRules: string[] = [];
  for (const [className, margin] of rowMarginByClass) cssRules.push(`.${className} { display:block; font-size:0; white-space:nowrap; margin-top:${px(margin)}; }`);

  for (const node of layers) {
    const parent = node.parentId ? layers.find(candidate => candidate.id === node.parentId) ?? null : null;
    const parentPrimitive = parent ? primitiveById.get(parent.id) ?? null : null;
    const role = roleById.get(node.id) ?? "content";
    const align = parent ? alignment(node, parent) : "left";
    placementDecisions.push({ id: node.id, parentId: node.parentId, role, alignment: align });

    let effectivePrimitive: PreviewPrimitive | null = parentPrimitive;
    let previous: Layer | null = null;
    let rowTopValue = 0;
    const inRow = inRowById.get(node.id) ?? false;
    if (inRow) {
      previous = prevInRowById.get(node.id) ?? null;
      rowTopValue = rowTopById.get(node.id) ?? 0;
    } else {
      if (parentPrimitive === "layered-flow" && role === "content" && node.layoutPositioning !== "ABSOLUTE") {
        effectivePrimitive = contentFlowById.get(parent!.id) ?? "block-flow";
      }
      const siblings = parent ? orderedById.get(parent.id) ?? [] : [];
      const index = siblings.findIndex(sibling => sibling.id === node.id);
      previous = index > 0 ? [...siblings.slice(0, index)].reverse().find(sibling => parentPrimitive !== "layered-flow" || (roleById.get(sibling.id) ?? "content") === "content" && sibling.layoutPositioning !== "ABSOLUTE") ?? null : null;
    }

    const absolute = contentAbsoluteById.get(parent?.id ?? "") ?? false;
    const rotation = typeof node.rotation === "number" && node.renderAs !== "image" ? node.rotation : 0;
    const rotatedSize = rotation !== 0 && typeof node.width === "number" && typeof node.height === "number" ? { width: node.width, height: node.height } : null;
    const nodeWidth = rotatedSize ? rotatedSize.width : node.absoluteBounds.width;
    const nodeHeight = rotatedSize ? rotatedSize.height : node.absoluteBounds.height;
    const placement: Placement = { primitive: effectivePrimitive, role, align, previous, rowTop: rowTopValue, inRow, absolute, rotation };
    const paintOrder = parentPrimitive === "layered-flow" ? [`z-index:${paintOrderById.get(node.id) ?? 0}`] : [];
    const rules = [`width:${px(nodeWidth)}`, `height:${px(nodeHeight)}`, ...placementCSS(node, parent, placement), ...paintOrder, ...paintCSS(node, design), ...textCSS(node)];
    cssRules.push(`.${classById.get(node.id)} { ${rules.join("; ")}; }`);
    if (Array.isArray(node.styledTextSegments)) node.styledTextSegments.forEach((segment, segmentIndex) => {
      const style = record(segment);
      if (style) cssRules.push(`.${classById.get(node.id)}-text-${segmentIndex + 1} { ${textStyleCSS(style).join("; ")}; }`);
    });
    if (node.renderAs === "image") {
      const box = node.imagePlacement ?? { x: 0, y: 0, width: node.absoluteBounds.width, height: node.absoluteBounds.height };
      cssRules.push(`.${classById.get(node.id)} > .d2c-asset { left:${px(box.x)}; top:${px(box.y)}; width:${px(box.width)}; height:${px(box.height)}; }`);
    }
    const primitive = primitiveById.get(node.id);
    if (primitive) {
      const multiRow = multiRowById.get(node.id) ?? false;
      const renderedPrimitive = multiRow ? "block-flow" : (primitive === "layered-flow" ? contentFlowById.get(node.id) ?? "block-flow" : primitive);
      const display = renderedPrimitive === "flex-row" || renderedPrimitive === "flex-column" ? "flex" : renderedPrimitive === "inline-flow" ? "block" : "flow-root";
      const extras = [
        renderedPrimitive === "flex-row" ? "flex-direction:row;flex-wrap:wrap" : renderedPrimitive === "flex-column" ? "flex-direction:column" : renderedPrimitive === "inline-flow" ? "font-size:0;white-space:nowrap" : "",
        primitive === "layered-flow" ? "position:relative;isolation:isolate" : "",
      ].filter(Boolean).join(";");
      cssRules.push(`.${classById.get(node.id)} > .d2c-children { display:${display}; ${extras ? `${extras}; ` : ""}width:100%; height:100%; }`);
    }
  }

  const render = (node: Layer, root = false): string => {
    const units = renderUnitsById.get(node.id);
    const textSegments = Array.isArray(node.styledTextSegments) ? node.styledTextSegments.map(record).filter((segment): segment is Record<string, unknown> => Boolean(segment)) : [];
    const body = node.renderAs === "image" ? imageMarkup(node, design)
      : node.type === "TEXT" && textSegments.length ? textSegments.map((segment, segmentIndex) => `<span class="d2c-text-segment ${classById.get(node.id)}-text-${segmentIndex + 1}" data-d2c-text-start="${esc(segment.start)}" data-d2c-text-end="${esc(segment.end)}">${esc(segment.characters)}</span>`).join("")
      : node.type === "TEXT" ? esc(node.characters)
      : units && units.length ? `<div class="d2c-children">${units.map(unit => unit.kind === "row" ? `<div class="d2c-row ${unit.className}">${unit.layers.map(child => render(child)).join("")}</div>` : render(unit.layer)).join("")}</div>` : "";
    const repeat = semantics.repeatGroups.find(group => group.instanceIds.includes(node.id));
    const attributes = [
      `class="d2c-node ${classById.get(node.id)}"`, `data-d2c-id="${esc(node.id)}"`, `data-layer-name="${esc(node.name)}"`,
      `data-d2c-role="${roleById.get(node.id) ?? "content"}"`, root ? 'data-d2c-root="true"' : "",
      repeat ? `data-d2c-repeat="${esc(repeat.component)}"` : "",
    ].filter(Boolean).join(" ");
    return `<div ${attributes}>${body}</div>`;
  };

  const reviewRequired = layers.flatMap(layer => {
    const reasons: string[] = [];
    if (layer.isMask) reasons.push("mask relationship uses the default preserved hierarchy");
    if (layer.renderAs !== "image" && typeof layer.rotation === "number" && layer.rotation !== 0) reasons.push("rotated layer uses a CSS rotate fallback");
    if (primitiveById.get(layer.id) === "layered-flow") reasons.push("overlapping container uses a no-Grid layered-flow fallback; keep content in flow and review positioned paint layers");
    if (layer.type === "EMBED" || layer.type === "WIDGET") reasons.push(`${layer.type.toLowerCase()} uses a generic container fallback`);
    return reasons.map(reason => ({ id: layer.id, reason }));
  });
  const title = design.nodes.map(root => root.name).join(" + ") || "D2C Preview";
  const html = `<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>${esc(title)} · D2C Preview</title>\n<link rel="stylesheet" href="./preview.css">\n</head>\n<body>\n<main class="d2c-preview">${design.nodes.map(root => `<section class="d2c-root-shell">${render(root, true)}</section>`).join("")}</main>\n</body>\n</html>\n`;
  const css = `/* Deterministic model-free preview. It is a starting point, not final flow or visual acceptance. */\n* { box-sizing:border-box; }\nhtml, body { margin:0; min-height:100%; }\nbody { background:#f3f4f6; color:#111; font-family:Arial, sans-serif; }\n.d2c-preview { display:flex; flex-direction:column; align-items:center; gap:24px; padding:24px; }\n.d2c-root-shell { flex:none; box-shadow:0 8px 32px rgba(0,0,0,.12); }\n.d2c-node { position:relative; min-width:0; min-height:0; overflow:visible; flex:none; }\n.d2c-children { position:relative; min-width:0; min-height:0; }\n.d2c-asset { position:absolute; max-width:none; object-fit:fill; opacity:1; }\n.d2c-text-segment { white-space:inherit; }\n${cssRules.join("\n")}\n`;

  return {
    html, css,
    manifest: {
      schemaVersion: 1,
      renderer: "deterministic-preview-v1",
      purpose: "Model-free structural preview generated from the current export only",
      limitations: ["Not a final flow implementation", "No tab-specific inference or behavior", "Complex and low-confidence structures use deterministic preserved-hierarchy fallbacks", "Visual and interaction acceptance remain separate"],
      roots: design.nodes.map(root => root.id), containers: containerDecisions, placements: placementDecisions,
      repeatGroups: semantics.repeatGroups, reviewRequired,
    },
  };
}
