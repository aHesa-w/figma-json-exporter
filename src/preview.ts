import { flattenLayers, prepareDesign, type Design, type Layer, type Rect } from "./geometry.js";
import { semanticPlan } from "./semantics.js";

type PreviewPrimitive = "block-flow" | "inline-flow" | "flex-row" | "flex-column" | "grid" | "grid-overlay";
type PreviewRole = "background" | "content" | "decoration";

interface ContainerDecision {
  id: string;
  primitive: PreviewPrimitive;
  source: "semantic-plan" | "single-child-default" | "empty";
  childOrder: string[];
  backgroundIds: string[];
  fallback: "grid-overlay";
}

interface PlacementDecision {
  id: string;
  parentId: string | null;
  role: PreviewRole;
  alignment: "left" | "center" | "right" | "free";
}

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
    const overlapsLaterContent = ordered.slice(index + 1).some(other => overlapArea(child.absoluteBounds, other.absoluteBounds) > 1);
    return index < Math.max(1, Math.ceil(ordered.length / 2)) && coverage >= 0.85 && overlapsLaterContent && isVisualLayer(child) && !hasMeaningfulText(child);
  }).map(child => child.id);
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

function placementCSS(node: Layer, parent: Layer | null, parentPrimitive: PreviewPrimitive | null, previous: Layer | null, align: PlacementDecision["alignment"]): string[] {
  if (!parent || !parentPrimitive) return [];
  const box = node.localBounds;
  if (parentPrimitive === "grid" || parentPrimitive === "grid-overlay") {
    return ["grid-area:1 / 1", `margin-left:${px(box.x)}`, `margin-top:${px(box.y)}`, "align-self:start", "justify-self:start"];
  }
  if (parentPrimitive === "inline-flow" || parentPrimitive === "flex-row") {
    const previousRight = previous ? previous.localBounds.x + previous.localBounds.width : 0;
    return [parentPrimitive === "inline-flow" ? "display:inline-block" : "flex:none", `margin-left:${px(Math.max(0, box.x - previousRight))}`, `margin-top:${px(Math.max(0, box.y))}`, "vertical-align:top"];
  }
  const previousBottom = previous ? previous.localBounds.y + previous.localBounds.height : 0;
  const rules = [`margin-top:${px(Math.max(0, box.y - previousBottom))}`];
  if (align === "center") rules.push("margin-left:auto", "margin-right:auto");
  else if (align === "right") rules.push("margin-left:auto");
  else if (box.x > 0) rules.push(`margin-left:${px(box.x)}`);
  if (parentPrimitive === "flex-column") rules.push("flex:none");
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
  if (node.clipsContent) rules.push("overflow:hidden");
  if (typeof node.opacity === "number" && node.opacity !== 1) rules.push(`opacity:${node.opacity}`);
  if (typeof node.rotation === "number" && node.rotation !== 0) rules.push(`rotate:${node.rotation}deg`);
  return rules;
}

function textCSS(node: Layer): string[] {
  if (node.type !== "TEXT") return [];
  const font = record(node.fontName), lineHeight = record(node.lineHeight), letterSpacing = record(node.letterSpacing);
  const rules = ["white-space:pre-wrap", "overflow-wrap:anywhere"];
  if (typeof font?.family === "string") rules.push(`font-family:${JSON.stringify(font.family)}`);
  if (typeof node.fontSize === "number") rules.push(`font-size:${px(node.fontSize)}`);
  if (typeof node.fontWeight === "number") rules.push(`font-weight:${node.fontWeight}`);
  if (typeof lineHeight?.css === "string") rules.push(`line-height:${lineHeight.css}`);
  if (typeof letterSpacing?.css === "string") rules.push(`letter-spacing:${letterSpacing.css}`);
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
  const orderedById = new Map<string, Layer[]>();

  for (const parent of layers) {
    const children = parent.children ?? [];
    if (!children.length) continue;
    const order = orderById.get(parent.id);
    const byId = new Map(children.map(child => [child.id, child]));
    const ordered = order ? [...order.map(id => byId.get(id)).filter((node): node is Layer => Boolean(node)), ...children.filter(child => !order.includes(child.id))] : children;
    const backgrounds = backgroundIds(parent, ordered);
    const primitive = strategyById.get(parent.id) ?? (children.length === 1 ? "block-flow" : "grid-overlay");
    primitiveById.set(parent.id, primitive);
    orderedById.set(parent.id, ordered);
    for (const child of ordered) roleById.set(child.id, backgrounds.includes(child.id) ? "background" : isVisualLayer(child) && !hasMeaningfulText(child) && child.absoluteBounds.width * child.absoluteBounds.height < parent.absoluteBounds.width * parent.absoluteBounds.height * 0.25 ? "decoration" : "content");
    containerDecisions.push({ id: parent.id, primitive, source: strategyById.has(parent.id) ? "semantic-plan" : "single-child-default", childOrder: ordered.map(child => child.id), backgroundIds: backgrounds, fallback: "grid-overlay" });
  }

  const cssRules: string[] = [];
  for (const node of layers) {
    const parent = node.parentId ? layers.find(candidate => candidate.id === node.parentId) ?? null : null;
    const parentPrimitive = parent ? primitiveById.get(parent.id) ?? null : null;
    const siblings = parent ? orderedById.get(parent.id) ?? [] : [];
    const index = siblings.findIndex(sibling => sibling.id === node.id);
    const align = parent ? alignment(node, parent) : "left";
    placementDecisions.push({ id: node.id, parentId: node.parentId, role: roleById.get(node.id) ?? "content", alignment: align });
    const rules = [`width:${px(node.absoluteBounds.width)}`, `height:${px(node.absoluteBounds.height)}`, ...placementCSS(node, parent, parentPrimitive, index > 0 ? siblings[index - 1] : null, align), ...paintCSS(node, design), ...textCSS(node)];
    cssRules.push(`.${classById.get(node.id)} { ${rules.join("; ")}; }`);
    if (node.renderAs === "image") {
      const box = node.imagePlacement ?? { x: 0, y: 0, width: node.absoluteBounds.width, height: node.absoluteBounds.height };
      cssRules.push(`.${classById.get(node.id)} > .d2c-asset { left:${px(box.x)}; top:${px(box.y)}; width:${px(box.width)}; height:${px(box.height)}; }`);
    }
    const primitive = primitiveById.get(node.id);
    if (primitive) {
      const display = primitive === "grid" || primitive === "grid-overlay" ? "grid" : primitive === "flex-row" || primitive === "flex-column" ? "flex" : primitive === "inline-flow" ? "block" : "flow-root";
      const extras = primitive === "flex-row" ? "flex-direction:row" : primitive === "flex-column" ? "flex-direction:column" : primitive === "inline-flow" ? "font-size:0;white-space:nowrap" : "";
      cssRules.push(`.${classById.get(node.id)} > .d2c-children { display:${display}; ${extras}; width:100%; height:100%; }`);
    }
  }

  const render = (node: Layer, root = false): string => {
    const children = orderedById.get(node.id) ?? node.children ?? [];
    const body = node.renderAs === "image" ? imageMarkup(node, design)
      : node.type === "TEXT" ? esc(node.characters)
      : children.length ? `<div class="d2c-children">${children.map(child => render(child)).join("")}</div>` : "";
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
    if (layer.type === "EMBED" || layer.type === "WIDGET") reasons.push(`${layer.type.toLowerCase()} uses a generic container fallback`);
    return reasons.map(reason => ({ id: layer.id, reason }));
  });
  const title = design.nodes.map(root => root.name).join(" + ") || "D2C Preview";
  const html = `<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>${esc(title)} · D2C Preview</title>\n<link rel="stylesheet" href="./preview.css">\n</head>\n<body>\n<main class="d2c-preview">${design.nodes.map(root => `<section class="d2c-root-shell">${render(root, true)}</section>`).join("")}</main>\n</body>\n</html>\n`;
  const css = `/* Deterministic model-free preview. It is a starting point, not final flow or visual acceptance. */\n* { box-sizing:border-box; }\nhtml, body { margin:0; min-height:100%; }\nbody { background:#f3f4f6; color:#111; font-family:Arial, sans-serif; }\n.d2c-preview { display:flex; flex-direction:column; align-items:center; gap:24px; padding:24px; }\n.d2c-root-shell { flex:none; box-shadow:0 8px 32px rgba(0,0,0,.12); }\n.d2c-node { position:relative; min-width:0; min-height:0; overflow:visible; flex:none; }\n.d2c-children { position:relative; min-width:0; min-height:0; }\n.d2c-asset { position:absolute; max-width:none; object-fit:fill; opacity:1; }\n${cssRules.join("\n")}\n`;

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
