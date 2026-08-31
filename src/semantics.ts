import { prepareDesign, type Layer } from "./geometry.js";

export const SEMANTIC_INSTRUCTIONS = "Read semantic-plan.json before the flow refactor. Follow each container layoutStrategy and prefer the lightest primitive that preserves semantics and geometry: block flow first, then inline/inline-block, then flex, and grid only for genuine two-dimensional alignment or paint stacks. Do not mechanically translate every Figma Auto Layout or x/y coordinate set into flex/grid. Emit labelled siblings in codeOrder when orderPolicy=visual-reading-order; preserve design order for overlapping paint stacks. Framework targets should render repeatGroups from data with stable keys while preserving every instance data-d2c-id. Plain HTML must keep expanded DOM and copy the supplied loopComment around the repeated instances. Implement only safe-local interaction candidates autonomously; callback-only candidates expose typed callbacks/events without inventing navigation, APIs or persistence, and blocked candidates remain inert pending product requirements. Inferred interactions need semantic elements, keyboard behavior, focus visibility and ARIA state. Re-run browser geometry/style validation after semantic refactoring.";

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

    if (hasOverlap) {
      return {
        id: node.id, name: node.name, designOrder, codeOrder: designOrder,
        orderPolicy: "preserve-design-paint-order" as const,
        readingDirection,
        layoutStrategy: inferLayoutStrategy(node, children, hasOverlap),
        reason: "Overlapping siblings depend on paint order; retain design order unless explicit z-index preserves the stack",
      };
    }

    return {
      id: node.id, name: node.name, designOrder, codeOrder: sorted.map(child => child.id),
      orderPolicy: "visual-reading-order" as const, readingDirection,
      layoutStrategy: inferLayoutStrategy(node, children, hasOverlap), reason,
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
        });
      }
      start = end;
    }
  }
  return output;
}

const excludedName = /(?:\b(label|text|icon|dot|divider|header|footer|cell|title|description)\b|文字|图标|圆点|分割线|页头|页脚|单元格|标题|描述)/iu;
const dangerousName = /(?:\b(delete|remove|destroy|pay|purchase|submit|publish|login|logout|authorize|upload)\b|删除|移除|销毁|支付|购买|提交|发布|登录|登出|授权|上传)/iu;

function interactionFor(node: Layer): InteractionCandidate | null {
  const name = normalizeName(node.name);
  const lower = name.toLowerCase();
  if (!name || excludedName.test(name) || node.type === "TEXT") return null;
  const base = { id: node.id, name: node.name, evidence: `Layer name: ${node.name}` };
  if (dangerousName.test(name)) return { ...base, kind: "business-action", confidence: 0.9, autonomy: "blocked", behavior: "Do not invent or execute a side effect; require an explicit product contract", accessibility: ["Use a semantic button only after the action is confirmed", "Expose disabled/pending state when rendered"] };
  if (/(?:\btab\b|标签页|选项卡)/u.test(lower)) return { ...base, kind: "tab", confidence: 0.95, autonomy: "safe-local", behavior: "Switch the associated local panel without navigation or persistence", accessibility: ["role=tab/tablist/tabpanel", "Arrow-key navigation", "aria-selected and aria-controls"] };
  if (/(?:\bsearch\b|搜索)/u.test(lower)) return { ...base, kind: "search", confidence: 0.95, autonomy: "safe-local", behavior: "Filter already-rendered local content; do not call a remote API unless specified", accessibility: ["Use input type=search", "Provide an accessible label", "Keep results count announced"] };
  if (/(?:\b(filter|select|dropdown)\b|筛选|过滤|下拉|选择器)/u.test(lower)) return { ...base, kind: "filter", confidence: 0.9, autonomy: "safe-local", behavior: "Change local filter state using values present in the rendered data", accessibility: ["Use a native select when possible", "Expose current value", "Support keyboard operation"] };
  if (/(?:\b(toggle|switch|checkbox)\b|开关|复选框)/u.test(lower)) return { ...base, kind: "toggle", confidence: 0.92, autonomy: "safe-local", behavior: "Toggle local boolean state only", accessibility: ["Use checkbox or switch semantics", "Expose checked state", "Provide focus visibility"] };
  if (/(?:\b(accordion|disclosure|expand|collapse)\b|手风琴|展开|收起|折叠)/u.test(lower)) return { ...base, kind: "disclosure", confidence: 0.9, autonomy: "safe-local", behavior: "Show or hide an existing local content region", accessibility: ["aria-expanded", "aria-controls", "Enter and Space activation"] };
  if (/(?:\b(previous|next|pagination)\b|上一页|下一页|分页)/u.test(lower)) return { ...base, kind: "pagination", confidence: 0.88, autonomy: "safe-local", behavior: "Change local page state only when multiple rendered pages exist; otherwise disable", accessibility: ["Use semantic buttons", "Expose disabled state", "Announce page position"] };
  if (/(?:\b(nav|navigation|sidebar item)\b|导航|侧边栏项)/u.test(lower)) return { ...base, kind: "navigation", confidence: 0.86, autonomy: "callback-only", behavior: "Expose a navigation callback; do not invent routes or URLs", accessibility: ["Use nav and link/button semantics", "Expose aria-current for the active destination"] };
  if (/(?:\b(button|configure|settings|avatar|bell)\b|按钮|配置|设置|头像|通知)/u.test(lower)) return { ...base, kind: "action", confidence: 0.8, autonomy: "callback-only", behavior: "Expose a named callback or CustomEvent; do not invent business behavior", accessibility: ["Use a semantic button", "Provide an accessible name", "Support Enter and Space"] };
  return null;
}

function interactionCandidates(nodes: Layer[]): InteractionCandidate[] {
  return descendants(nodes).map(interactionFor).filter((candidate): candidate is InteractionCandidate => Boolean(candidate));
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
    },
  };
}
