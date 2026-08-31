import { prepareDesign, type Layer } from "./geometry.js";

export const SEMANTIC_INSTRUCTIONS = "Read semantic-plan.json before the flow refactor. Every container, repeatGroup and interaction candidate carries guidanceTags: call figma_guidance with those tags and follow the returned standards before implementing that node — do not assume unread rules. Follow codeOrder/orderPolicy for sibling order, render repeatGroups from data with stable keys (or d2c-repeat comments in plain HTML) preserving every data-d2c-id, and implement only safe-local interactions autonomously (callback-only expose typed callbacks/events, blocked stay inert). Re-run browser geometry/style validation after semantic refactoring.";

type OrderingPolicy = "visual-reading-order" | "preserve-design-paint-order";
type InteractionAutonomy = "safe-local" | "callback-only" | "blocked";
type LayoutPrimitive = "block-flow" | "inline-flow" | "flex-row" | "flex-column" | "grid" | "grid-overlay";

interface LayoutStrategy {
  preferred: LayoutPrimitive;
  necessity: "lightweight-default" | "required";
  reason: string;
  avoid: string[];
}

interface SemanticContainer {
  id: string;
  name: string;
  designOrder: string[];
  codeOrder: string[];
  orderPolicy: OrderingPolicy;
  readingDirection: "top-to-bottom" | "left-to-right" | "row-major";
  layoutStrategy: LayoutStrategy;
  guidanceTags: string[];
  reason: string;
}

interface RepeatGroup {
  parentId: string;
  component: string;
  collection: string;
  instanceIds: string[];
  keySource: "data-d2c-id";
  frameworkLoop: string;
  loopComment: { start: string; end: string };
  guidanceTags: string[];
}

interface TabStateStyle {
  textColor: string | null;
  fontWeight: number | null;
  indicatorColor: string | null;
  indicatorWeight: number | null;
  background: string | null;
}

interface TabInference {
  groupId: string;
  selected: boolean;
  selectedEvidence: string;
  stateStyles: { selected: TabStateStyle; unselected: TabStateStyle };
}

interface InputControlStyle {
  background: string | null;
  borderColor: string | null;
  borderWidth: number | null;
  borderRadius: number | null;
  textColor: string | null;
  fontSize: number | null;
  fontWeight: number | null;
  placeholderColor: string | null;
  padding: { left: number; right: number; top: number; bottom: number } | null;
}

interface InputInference {
  controlType: string;
  semanticElement: string;
  confidence: number;
  style: InputControlStyle;
  placeholder: { text: string; color: string } | null;
}

interface InteractionCandidate {
  id: string;
  name: string;
  kind: string;
  confidence: number;
  autonomy: InteractionAutonomy;
  behavior: string;
  accessibility: string[];
  evidence: string;
  guidanceTags: string[];
  tabInference?: TabInference;
  inputInference?: InputInference;
}

function descendants(nodes: Layer[]): Layer[] {
  const output: Layer[] = [];
  const visit = (node: Layer) => {
    output.push(node);
    node.children?.forEach(visit);
  };
  nodes.forEach(visit);
  return output;
}

function overlap(a: Layer, b: Layer): boolean {
  const ar = a.absoluteBounds, br = b.absoluteBounds;
  return Math.min(ar.right, br.right) - Math.max(ar.left, br.left) > 0.5
    && Math.min(ar.bottom, br.bottom) - Math.max(ar.top, br.top) > 0.5;
}

function visualCompare(a: Layer, b: Layer): number {
  const ar = a.absoluteBounds, br = b.absoluteBounds;
  const rowTolerance = Math.max(2, Math.min(ar.height, br.height) * 0.25);
  if (Math.abs(ar.y - br.y) > rowTolerance) return ar.y - br.y;
  if (Math.abs(ar.x - br.x) > 0.5) return ar.x - br.x;
  return ar.y - br.y;
}

function axisCompare(axis: "x" | "y") {
  return (a: Layer, b: Layer) => a.absoluteBounds[axis] - b.absoluteBounds[axis]
    || (axis === "x" ? a.absoluteBounds.y - b.absoluteBounds.y : a.absoluteBounds.x - b.absoluteBounds.x);
}

function separatedOnAxis(children: Layer[], axis: "x" | "y"): boolean {
  const start = axis === "x" ? "left" : "top", end = axis === "x" ? "right" : "bottom";
  const sorted = [...children].sort((a, b) => a.absoluteBounds[start] - b.absoluteBounds[start]);
  return sorted.every((child, index) => index === 0 || sorted[index - 1].absoluteBounds[end] <= child.absoluteBounds[start] + 0.5);
}

function inferLayoutStrategy(node: Layer, children: Layer[], hasOverlap: boolean): LayoutStrategy {
  const auto = node.autoLayout as Record<string, unknown> | undefined;
  const mode = auto?.mode, wrap = auto?.layoutWrap === "WRAP", primary = auto?.primaryAxisAlignItems;
  const grows = children.some(child => Number(child.layoutGrow ?? 0) > 0 || child.layoutAlign === "STRETCH");
  const avoid = ["Do not convert child x/y values into per-child positioning margins", "Do not introduce anonymous flex/grid wrappers without a structural role"];
  if (hasOverlap) return { preferred: "grid-overlay", necessity: "required", reason: "Siblings overlap in the paint stack; a shared grid area preserves normal flow and paint order", avoid };
  if (mode === "HORIZONTAL" && wrap) return { preferred: "flex-row", necessity: "required", reason: "Source layout wraps horizontally; flex-wrap is the lightest primitive that preserves the dynamic row flow", avoid };
  if (mode === "HORIZONTAL") {
    if (primary === "SPACE_BETWEEN" || grows) return { preferred: "flex-row", necessity: "required", reason: "Horizontal children use dynamic distribution or fill/stretch sizing", avoid };
    return { preferred: "inline-flow", necessity: "lightweight-default", reason: "A simple non-wrapping horizontal sequence can use inline/inline-block content with vertical-align and local spacing", avoid };
  }
  if (mode === "VERTICAL") {
    if (["CENTER", "MAX", "SPACE_BETWEEN"].includes(String(primary)) || grows) return { preferred: "flex-column", necessity: "required", reason: "Vertical children use dynamic distribution or fill/stretch sizing", avoid };
    return { preferred: "block-flow", necessity: "lightweight-default", reason: "A vertical Auto Layout sequence maps directly to block flow; use padding and adjacent-sibling spacing", avoid };
  }
  if (separatedOnAxis(children, "y")) return { preferred: "block-flow", necessity: "lightweight-default", reason: "Children form one non-overlapping top-to-bottom sequence", avoid };
  if (separatedOnAxis(children, "x")) return { preferred: "inline-flow", necessity: "lightweight-default", reason: "Children form one non-overlapping left-to-right sequence", avoid };
  return { preferred: "grid", necessity: "required", reason: "Children form a non-overlapping two-dimensional arrangement that cannot be expressed as one block or inline sequence", avoid };
}

function semanticContainers(nodes: Layer[]): SemanticContainer[] {
  return descendants(nodes).filter(node => (node.children?.length ?? 0) > 1).map(node => {
    const children = node.children!;
    const designOrder = children.map(child => child.id);
    const hasOverlap = children.some((child, index) => children.slice(index + 1).some(other => overlap(child, other)));
    const auto = node.autoLayout as Record<string, unknown> | undefined;
    const mode = auto?.mode;
    const wrap = auto?.layoutWrap === "WRAP";
    let readingDirection: SemanticContainer["readingDirection"] = "row-major";
    let sorted = [...children].sort(visualCompare);
    let reason = "No source Auto Layout; inferred row-major reading order from exported geometry";

    if (mode === "HORIZONTAL" && !wrap) {
      readingDirection = "left-to-right";
      sorted = [...children].sort(axisCompare("x"));
      reason = "Source Auto Layout is horizontal; code follows left-to-right visual order";
    } else if (mode === "VERTICAL") {
      readingDirection = "top-to-bottom";
      sorted = [...children].sort(axisCompare("y"));
      reason = "Source Auto Layout is vertical; code follows top-to-bottom visual order";
    } else if (mode === "HORIZONTAL" && wrap) {
      reason = "Wrapped horizontal Auto Layout; code follows top-to-bottom rows and left-to-right items";
    }

    const layoutStrategy = inferLayoutStrategy(node, children, hasOverlap);
    if (hasOverlap) {
      return {
        id: node.id, name: node.name, designOrder, codeOrder: designOrder,
        orderPolicy: "preserve-design-paint-order" as const,
        readingDirection, layoutStrategy,
        guidanceTags: [layoutStrategy.preferred, "preserve-design-paint-order"],
        reason: "Overlapping siblings depend on paint order; retain design order unless explicit z-index preserves the stack",
      };
    }

    return {
      id: node.id, name: node.name, designOrder, codeOrder: sorted.map(child => child.id),
      orderPolicy: "visual-reading-order" as const, readingDirection,
      layoutStrategy,
      guidanceTags: [layoutStrategy.preferred, "visual-reading-order"],
      reason,
    };
  });
}

function normalizeName(value: string): string {
  return value.replace(/\s+(?:copy\s*)?\d+$/iu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function componentName(value: string): string {
  const words = normalizeName(value).split(/\s+/u).filter(Boolean);
  if (words.length && words.every(word => !/[a-z]/iu.test(word))) return `${words.join("")}Item`;
  return words.map(word => word[0].toUpperCase() + word.slice(1)).join("") || "RepeatedItem";
}

function signature(node: Layer, depth = 0): string {
  if (depth >= 6) return `${node.type}:${normalizeName(node.name)}`;
  const auto = node.autoLayout as Record<string, unknown> | undefined;
  return JSON.stringify([
    node.type,
    normalizeName(node.name),
    auto?.mode ?? null,
    node.children?.map(child => signature(child, depth + 1)) ?? [],
  ]);
}

function repeatGroups(nodes: Layer[], containers: SemanticContainer[]): RepeatGroup[] {
  const byId = new Map(descendants(nodes).map(node => [node.id, node]));
  const output: RepeatGroup[] = [];
  for (const container of containers) {
    const children = container.codeOrder.map(id => byId.get(id)).filter((node): node is Layer => Boolean(node));
    let start = 0;
    while (start < children.length) {
      const target = signature(children[start]);
      let end = start + 1;
      while (end < children.length && signature(children[end]) === target) end += 1;
      const run = children.slice(start, end);
      if (run.length >= 3) {
        const component = componentName(run[0].name);
        const collection = component[0].toLowerCase() + component.slice(1) + "s";
        output.push({
          parentId: container.id,
          component,
          collection,
          instanceIds: run.map(node => node.id),
          keySource: "data-d2c-id",
          frameworkLoop: `${collection}.map(item => <${component} key={item.id} item={item} data-d2c-id={item.d2cId} />)`,
          loopComment: {
            start: `<!-- d2c-repeat: component=${component}; collection=${collection}; key=data-d2c-id; count=${run.length} -->`,
            end: `<!-- d2c-repeat-end: ${component} -->`,
          },
          guidanceTags: ["repeat"],
        });
      }
      start = end;
    }
  }
  return output;
}

const excludedName = /(?:\b(label|text|icon|dot|divider|header|footer|cell|title|description)\b|文字|图标|圆点|分割线|页头|页脚|单元格|标题|描述)/iu;
const dangerousName = /(?:\b(delete|remove|destroy|pay|purchase|submit|publish|login|logout|authorize|upload)\b|删除|移除|销毁|支付|购买|提交|发布|登录|登出|授权|上传)/iu;

// ── 控件样式推断工具（只读导出的 paints/text 字段，不做像素猜测） ──

const asRecord = (node: Layer): Record<string, unknown> => node as unknown as Record<string, unknown>;

interface Rgba { r: number; g: number; b: number; a: number }

function parseRgba(css: string | null | undefined): Rgba | null {
  if (!css) return null;
  const match = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\)/i.exec(css);
  if (!match) return null;
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: match[4] === undefined ? 1 : Number(match[4]) };
}

function solidPaint(paints: unknown): string | null {
  if (!Array.isArray(paints)) return null;
  for (const paint of paints) {
    if (!paint || typeof paint !== "object") continue;
    const entry = paint as Record<string, unknown>;
    if (entry.type === "SOLID" && entry.visible !== false && entry.opacity !== 0 && typeof entry.color === "string") return entry.color;
  }
  return null;
}

function solidFill(node: Layer): string | null { return solidPaint(asRecord(node).fills); }
function solidStroke(node: Layer): string | null { return solidPaint(asRecord(node).strokes); }

function primaryText(node: Layer): Layer | null {
  if (node.type === "TEXT") return node;
  return descendants([node]).find(child => child.type === "TEXT") ?? null;
}

function textColorOf(node: Layer): string | null {
  const text = primaryText(node);
  const color = text ? asRecord(text).textColor : undefined;
  const css = color && typeof color === "object" ? (color as Record<string, unknown>).css : undefined;
  return typeof css === "string" ? css : null;
}

function layerNumber(node: Layer, key: string): number | null {
  const value = asRecord(node)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function paddingOf(node: Layer): { left: number; right: number; top: number; bottom: number } | null {
  const auto = asRecord(node).autoLayout as Record<string, unknown> | undefined;
  if (!auto) return null;
  const values = ["paddingLeft", "paddingRight", "paddingTop", "paddingBottom"].map(key => auto[key]);
  if (!values.every((value): value is number => typeof value === "number")) return null;
  return { left: values[0], right: values[1], top: values[2], bottom: values[3] };
}

function isLightGray(rgba: Rgba | null): boolean {
  if (!rgba) return false;
  const max = Math.max(rgba.r, rgba.g, rgba.b), min = Math.min(rgba.r, rgba.g, rgba.b);
  return max - min <= 40 && (max + min) / 2 >= 150;
}

function findPlaceholder(node: Layer): { text: string; color: string } | null {
  const texts = descendants([node]).filter(child => {
    if (child.type !== "TEXT") return false;
    const characters = asRecord(child).characters;
    return typeof characters === "string" && characters.trim().length > 0;
  });
  const candidates = texts.map(text => ({ text: String(asRecord(text).characters).trim(), color: textColorOf(text), name: normalizeName(text.name), rgba: parseRgba(textColorOf(text)) }))
    .filter((candidate): candidate is { text: string; color: string; name: string; rgba: Rgba | null } => typeof candidate.color === "string" && candidate.color.length > 0);
  if (!candidates.length) return null;
  const placeholder = candidates.find(candidate => /(?:hint|placeholder|占位|提示|示例|example|eg)/iu.test(candidate.name) || isLightGray(candidate.rgba));
  const picked = placeholder ?? candidates[candidates.length - 1];
  return { text: picked.text, color: picked.color };
}

function tabStateStyle(node: Layer): TabStateStyle {
  const text = primaryText(node);
  return {
    textColor: textColorOf(node),
    fontWeight: text ? layerNumber(text, "fontWeight") : null,
    indicatorColor: solidStroke(node),
    indicatorWeight: layerNumber(node, "strokeWeight"),
    background: solidFill(node),
  };
}

function tabProminence(node: Layer): number {
  let score = 0;
  const color = parseRgba(textColorOf(node));
  if (color && Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b) > 40) score += 1;
  if (solidStroke(node)) score += 1;
  const text = primaryText(node);
  const weight = text ? layerNumber(text, "fontWeight") : null;
  if (weight !== null && weight > 400) score += 0.5;
  if (solidFill(node)) score += 0.5;
  return score;
}

function sameBand(a: Layer, b: Layer): boolean {
  const ab = a.absoluteBounds, bb = b.absoluteBounds;
  const rowTolerance = Math.max(2, Math.min(ab.height, bb.height) * 0.25);
  const colTolerance = Math.max(2, Math.min(ab.width, bb.width) * 0.25);
  return Math.abs(ab.y - bb.y) <= rowTolerance || Math.abs(ab.x - bb.x) <= colTolerance;
}

function assignTabInference(candidates: InteractionCandidate[], nodes: Layer[]): void {
  const byId = new Map(descendants(nodes).map(node => [node.id, node]));
  const parentGroups = new Map<string, InteractionCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.kind !== "tab") continue;
    const node = byId.get(candidate.id);
    parentGroups.set(node?.parentId ?? node?.rootId ?? "", [...(parentGroups.get(node?.parentId ?? node?.rootId ?? "") ?? []), candidate]);
  }
  let sequence = 0;
  for (const group of parentGroups.values()) {
    const bands: InteractionCandidate[][] = [];
    for (const candidate of group) {
      const node = byId.get(candidate.id);
      if (!node) continue;
      const host = bands.find(band => band.some(member => sameBand(node, byId.get(member.id)!)));
      if (host) host.push(candidate);
      else bands.push([candidate]);
    }
    for (const band of bands) {
      sequence += 1;
      const groupId = `tab-group-${sequence}`;
      const scored = band.map(candidate => ({ candidate, node: byId.get(candidate.id)!, score: tabProminence(byId.get(candidate.id)!) }));
      const maxScore = Math.max(...scored.map(entry => entry.score));
      const distinct = maxScore > 0 && scored.filter(entry => entry.score === maxScore).length === 1;
      const selectedEntry = distinct ? scored.find(entry => entry.score === maxScore)! : scored[0];
      const selectedEvidence = distinct
        ? "Selected tab shows the highest visual prominence (colored text, indicator stroke, heavier weight or distinct background)"
        : "No distinguishing style detected; defaulting to the first tab as selected pending design review";
      const unselectedNode = scored.find(entry => entry.candidate.id !== selectedEntry.candidate.id)?.node ?? selectedEntry.node;
      const stateStyles = { selected: tabStateStyle(selectedEntry.node), unselected: tabStateStyle(unselectedNode) };
      for (const entry of scored) {
        entry.candidate.tabInference = { groupId, selected: entry.candidate.id === selectedEntry.candidate.id, selectedEvidence, stateStyles };
      }
    }
  }
}

function inferInput(node: Layer): { controlType: string; semanticElement: string; confidence: number } | null {
  const lower = normalizeName(node.name).toLowerCase();
  const rules: Array<[RegExp, string, string, number]> = [
    [/(?:\bsearch\b|搜索|查找|检索)/u, "search", "input[type=search]", 0.95],
    [/(?:\bpassword\b|\bpass\b|密码)/u, "password", "input[type=password]", 0.95],
    [/(?:\be-?mail\b|\bemail\b|邮箱|邮件)/u, "email", "input[type=email]", 0.95],
    [/(?:\bphone\b|\btel\b|\bmobile\b|手机号?|电话)/u, "tel", "input[type=tel]", 0.9],
    [/(?:\bamount\b|\bqty\b|\bquantity\b|数量|金额)/u, "number", "input[type=number]", 0.85],
    [/(?:\btextarea\b|text\s*area|多行|文本域|备注|简介|留言)/u, "textarea", "textarea", 0.9],
    [/(?:\bselect\b|\bdropdown\b|\bcombo\b|下拉|选择器)/u, "select", "select", 0.9],
    [/(?:\bcheckbox\b|复选框|多选)/u, "checkbox", "input[type=checkbox]", 0.92],
    [/(?:\bradio\b|单选)/u, "radio", "input[type=radio]", 0.9],
    [/(?:\bswitch\b|\btoggle\b|开关)/u, "switch", "input[type=checkbox][role=switch]", 0.9],
    [/(?:\binput\b|\btextbox\b|text\s*field|输入框?|文本框|编辑框)/u, "text", "input[type=text]", 0.85],
  ];
  for (const [pattern, controlType, semanticElement, confidence] of rules) {
    if (pattern.test(lower)) return { controlType, semanticElement, confidence };
  }
  return null;
}

function inferControlStyle(node: Layer): { style: InputControlStyle; placeholder: { text: string; color: string } | null } {
  const text = primaryText(node);
  const placeholder = findPlaceholder(node);
  return {
    style: {
      background: solidFill(node),
      borderColor: solidStroke(node),
      borderWidth: layerNumber(node, "strokeWeight"),
      borderRadius: layerNumber(node, "cornerRadius"),
      textColor: textColorOf(node),
      fontSize: text ? layerNumber(text, "fontSize") : null,
      fontWeight: text ? layerNumber(text, "fontWeight") : null,
      placeholderColor: placeholder?.color ?? null,
      padding: paddingOf(node),
    },
    placeholder,
  };
}

function inputBehavior(controlType: string): string {
  if (controlType === "search") return "Filter already-rendered local content; do not call a remote API unless specified";
  if (controlType === "select") return "Change local filter state using values present in the rendered data";
  if (["checkbox", "radio", "switch"].includes(controlType)) return "Toggle local boolean/selection state only";
  return "Manage only local input state; never invent validation, submission, APIs or persistence";
}

function inputAccessibility(controlType: string): string[] {
  if (controlType === "search") return ["Use input type=search", "Provide an accessible label", "Keep results count announced"];
  if (controlType === "select") return ["Use a native select when possible", "Expose current value", "Support keyboard operation"];
  if (["checkbox", "radio", "switch"].includes(controlType)) return ["Use checkbox/switch/radio semantics", "Expose checked/selected state", "Provide focus visibility"];
  return ["Associate a visible label (label or aria-label)", "Use the inferred semantic element", "Provide a visible focus state"];
}

function inputGuidanceTags(controlType: string): string[] {
  if (controlType === "search") return ["search"];
  if (controlType === "select") return ["select"];
  if (["checkbox", "radio", "switch"].includes(controlType)) return ["toggle", controlType];
  return ["input", `input-${controlType}`];
}

function interactionFor(node: Layer): InteractionCandidate | null {
  const name = normalizeName(node.name);
  if (!name || node.type === "TEXT") return null;
  const lower = name.toLowerCase();
  const base = { id: node.id, name: node.name, evidence: `Layer name: ${node.name}` };
  if (dangerousName.test(name)) return { ...base, kind: "business-action", confidence: 0.9, autonomy: "blocked", behavior: "Do not invent or execute a side effect; require an explicit product contract", accessibility: ["Use a semantic button only after the action is confirmed", "Expose disabled/pending state when rendered"], guidanceTags: ["business-action"] };

  const input = inferInput(node);
  if (input) {
    const { style, placeholder } = inferControlStyle(node);
    const inputInference: InputInference = { controlType: input.controlType, semanticElement: input.semanticElement, confidence: input.confidence, style, placeholder };
    const behavior = inputBehavior(input.controlType);
    const accessibility = inputAccessibility(input.controlType);
    const guidanceTags = inputGuidanceTags(input.controlType);
    if (input.controlType === "search") return { ...base, kind: "search", confidence: input.confidence, autonomy: "safe-local", behavior, accessibility, inputInference, guidanceTags };
    if (input.controlType === "select") return { ...base, kind: "filter", confidence: input.confidence, autonomy: "safe-local", behavior, accessibility, inputInference, guidanceTags };
    if (["checkbox", "radio", "switch"].includes(input.controlType)) return { ...base, kind: "toggle", confidence: input.confidence, autonomy: "safe-local", behavior, accessibility, inputInference, guidanceTags };
    return { ...base, kind: "input", confidence: input.confidence, autonomy: "safe-local", behavior, accessibility, inputInference, guidanceTags };
  }

  if (excludedName.test(name)) return null;
  if (/(?:\btab\b|标签页|选项卡)/u.test(lower)) return { ...base, kind: "tab", confidence: 0.95, autonomy: "safe-local", behavior: "Switch the associated local panel without navigation or persistence", accessibility: ["role=tab/tablist/tabpanel", "Arrow-key navigation", "aria-selected and aria-controls"], guidanceTags: ["tab"] };
  if (/(?:\bfilter\b|筛选|过滤)/u.test(lower)) return { ...base, kind: "filter", confidence: 0.9, autonomy: "safe-local", behavior: "Change local filter state using values present in the rendered data", accessibility: ["Use a native select when possible", "Expose current value", "Support keyboard operation"], guidanceTags: ["filter"] };
  if (/(?:\b(accordion|disclosure|expand|collapse)\b|手风琴|展开|收起|折叠)/u.test(lower)) return { ...base, kind: "disclosure", confidence: 0.9, autonomy: "safe-local", behavior: "Show or hide an existing local content region", accessibility: ["aria-expanded", "aria-controls", "Enter and Space activation"], guidanceTags: ["disclosure"] };
  if (/(?:\b(previous|next|pagination)\b|上一页|下一页|分页)/u.test(lower)) return { ...base, kind: "pagination", confidence: 0.88, autonomy: "safe-local", behavior: "Change local page state only when multiple rendered pages exist; otherwise disable", accessibility: ["Use semantic buttons", "Expose disabled state", "Announce page position"], guidanceTags: ["pagination"] };
  if (/(?:\b(nav|navigation|sidebar item)\b|导航|侧边栏项)/u.test(lower)) return { ...base, kind: "navigation", confidence: 0.86, autonomy: "callback-only", behavior: "Expose a navigation callback; do not invent routes or URLs", accessibility: ["Use nav and link/button semantics", "Expose aria-current for the active destination"], guidanceTags: ["navigation"] };
  if (/(?:\b(button|configure|settings|avatar|bell)\b|按钮|配置|设置|头像|通知)/u.test(lower)) return { ...base, kind: "action", confidence: 0.8, autonomy: "callback-only", behavior: "Expose a named callback or CustomEvent; do not invent business behavior", accessibility: ["Use a semantic button", "Provide an accessible name", "Support Enter and Space"], guidanceTags: ["action"] };
  return null;
}

function interactionCandidates(nodes: Layer[]): InteractionCandidate[] {
  const candidates = descendants(nodes).map(interactionFor).filter((candidate): candidate is InteractionCandidate => Boolean(candidate));
  assignTabInference(candidates, nodes);
  return candidates;
}

export function semanticPlan(input: unknown) {
  const design = prepareDesign(input);
  const containers = semanticContainers(design.nodes);
  const repeats = repeatGroups(design.nodes, containers);
  const interactions = interactionCandidates(design.nodes);
  return {
    instructions: SEMANTIC_INSTRUCTIONS,
    orderConvention: "Recursive visual reading order: top-to-bottom, then left-to-right; overlapping paint stacks retain design order",
    containers,
    repeatGroups: repeats,
    interactions,
    policies: {
      layoutPrimitives: "Use block flow first, inline/inline-block for simple horizontal content, flex only for dynamic distribution/wrap, and grid only for two-dimensional alignment or overlap",
      flexGridGate: "Every flex/grid container must be justified by layoutStrategy. Do not use universal display:grid/flex as a coordinate-placement mechanism",
      frameworkRepeats: "Generate data-driven loops/components and preserve each concrete instance data-d2c-id plus a stable key",
      plainHtmlRepeats: "Keep expanded DOM and wrap repeated instances with the supplied d2c-repeat comments",
      interactionThresholds: { safeLocal: 0.85, callbackOnly: 0.75 },
      sideEffects: "Never infer APIs, persistence, destructive actions, authentication, payments, uploads or routes",
    },
    summary: {
      containerCount: containers.length,
      reorderedContainerCount: containers.filter(container => container.designOrder.join("\0") !== container.codeOrder.join("\0")).length,
      repeatGroupCount: repeats.length,
      interactionCandidateCount: interactions.length,
      safeLocalInteractionCount: interactions.filter(candidate => candidate.autonomy === "safe-local").length,
      tabGroupCount: new Set(interactions.filter(candidate => candidate.tabInference).map(candidate => candidate.tabInference!.groupId)).size,
      inputControlCount: interactions.filter(candidate => candidate.inputInference).length,
    },
  };
}
