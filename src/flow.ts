import { flattenLayers, prepareDesign, type ActualLayout, type Layer } from "./geometry.js";
import { semanticPlan } from "./semantics.js";

export interface FlowBox {
  display: string; position: string; cssFloat: string;
  insets: string[]; margins: string[]; transform: string; translate: string;
}
export interface FlowStyle extends FlowBox { wrappers: FlowBox[] }
export interface FlowException { id: string; reason: string }
export interface ValidationOptions {
  phase?: "baseline" | "flow";
  baselineReportPath?: string;
  previewAssessmentPath?: string;
  flowExceptions?: FlowException[];
}
export const WORKFLOW_INSTRUCTIONS = "Mandatory preview-first sequence: after figma_export, OPEN previewHtmlPath and READ previewCssPath plus generationManifestPath before writing or replacing implementation code. Treat that deterministic preview as the first implementation candidate: assess what it gets right, what must change, and affected exported IDs; then call figma_assess_preview. Do not restart from design.json. Baseline requires previewAssessmentPath. After assessment, validate baseline, then refine normal document flow and validate phase=flow with the successful baselineReportPath. CSS Grid is forbidden: never emit display:grid or inline-grid on a design node or structural wrapper. Use block/flow-root, inline/inline-block and justified Flex; for overlap, keep content in flow and restrict positioning to backgrounds, decorations or source-absolute leaves. Only workflowComplete=true completes automated stages; visual review remains separate.";

function exceptionCandidate(node: Layer): boolean {
  if (node.id === node.rootId) return false;
  return node.layoutPositioning === "ABSOLUTE" || (!node.children?.length && ["RECTANGLE", "ELLIPSE", "LINE", "POLYGON", "STAR", "VECTOR", "BOOLEAN_OPERATION", "GROUP"].includes(node.type));
}

export function flowPlan(input: unknown) {
  const nodes = flattenLayers(prepareDesign(input));
  const semanticContainers = new Map(semanticPlan(input).containers.map(container => [container.id, container]));
  return {
    instructions: WORKFLOW_INSTRUCTIONS,
    stages: ["baseline", "flow"],
    rules: [
      "Build the first version directly in document flow; do not generate an absolute-positioned draft and then convert it. Save a working checkpoint before the flow validation and adjust parent containers first, then children.",
      "HARD CONSTRAINT: display:grid and inline-grid are forbidden on every generated design node and anonymous structural wrapper; this is never exemptable. Flex is allowed only when layoutStrategy=flex-row/flex-column.",
      "Use block flow for ordinary vertical structure and inline/inline-block for simple horizontal content. Promote to flex only for dynamic distribution, fill/stretch or wrapping rows. Overlap uses layered-flow: normal content stays in flow; only backgrounds, decorations or source-absolute leaves may be positioned.",
      "Source Auto Layout is evidence about order, padding, gap and sizing, not an instruction to always emit display:flex. Coordinates alone do not determine a unique flow layout.",
      "Keep data-d2c-id and the nearest labelled parent. Anonymous structural wrappers must have a semantic role and must not introduce out-of-flow positioning or visual effects.",
      "Normal content uses static/relative/sticky positioning. No absolute/fixed wrappers, floats, nonzero relative insets, negative margins or translation tricks to fake document flow.",
      "Exceptions need explicit per-layer reasons and are limited to source ABSOLUTE children or leaf shapes. They remain pending visual review, never blanket exemptions for containers or text.",
      "Recheck original geometry, clipping, gradients, text, opacity and assets at the baseline viewport. Responsive behavior and source-code quality require separate review.",
    ],
    containers: nodes.filter(n => n.children?.length).map(n => {
      const auto = n.autoLayout as Record<string, unknown> | undefined;
      const semantics = semanticContainers.get(n.id);
      const wrappedRow = auto?.mode === "HORIZONTAL" && auto?.layoutWrap === "WRAP";
      const fallback = auto?.mode === "HORIZONTAL" ? (wrappedRow ? "flex-row" : "inline-flow") : "block-flow";
      return { id: n.id, children: n.children!.map(c => c.id), suggestion: { preferred: semantics?.layoutStrategy.preferred ?? fallback, necessity: semantics?.layoutStrategy.necessity ?? (wrappedRow ? "required" : "lightweight-default"), reason: semantics?.layoutStrategy.reason ?? (wrappedRow ? "Source layout explicitly wraps horizontally" : "Prefer the lightest one-dimensional flow"), source: auto ? "Design Auto Layout plus exported geometry" : "Exported geometry and semantic grouping", autoLayout: auto } };
    }),
    exceptionCandidates: nodes.filter(exceptionCandidate).map(n => ({ id: n.id, type: n.type, automaticApproval: false })),
  };
}

const zero = (v: string) => /^[-+]?0+(?:\.0+)?(?:px|%)?$/.test(v);
function boxIssues(box: FlowBox | undefined): string[] {
  if (!box || ![box.display, box.position, box.cssFloat, box.transform, box.translate].every(v => typeof v === "string" && v.length > 0)
    || ![box.insets, box.margins].every(v => Array.isArray(v) && v.length === 4 && v.every(x => typeof x === "string"))) return ["missing-flow-style"];
  const issues: string[] = [];
  if (!["static", "relative", "sticky"].includes(box.position)) issues.push("out-of-flow-position");
  if (box.cssFloat !== "none") issues.push("float");
  if (box.position === "relative" && box.insets.some(v => v !== "auto" && !zero(v))) issues.push("relative-offset");
  if (box.margins.some(v => Number.parseFloat(v) < 0)) issues.push("negative-margin");
  if (box.translate !== "none" && !box.translate.trim().split(/\s+/).every(zero)) issues.push("translate-offset");
  if (box.transform !== "none") {
    const match = /^matrix(3d)?\(([^)]+)\)$/.exec(box.transform);
    const values = match?.[2].split(",").map(Number);
    const indices = match?.[1] ? [12, 13, 14] : [4, 5];
    if (!values || values.length !== (match?.[1] ? 16 : 6) || !values.every(Number.isFinite) || indices.some(i => Math.abs(values[i]) > 0.001)) issues.push("transform-offset");
  }
  return issues;
}

// Grid is globally forbidden for generated design nodes and structural wrappers.
// Flex remains gated by semantic-plan layoutStrategy.
function layoutPrimitiveIssues(display: string | undefined, strategy: { preferred: string; necessity: string } | undefined): string[] {
  if (!display) return [];
  const issues: string[] = [];
  const isGrid = display === "grid" || display === "inline-grid";
  const isFlex = display === "flex" || display === "inline-flex";
  if (isGrid) issues.push(`grid-forbidden${strategy ? ` (layoutStrategy prefers ${strategy.preferred}/${strategy.necessity})` : ""}: use block/inline/flex or restricted layered-flow`);
  if (!strategy) return issues;
  if (isFlex && !["flex-row", "flex-column"].includes(strategy.preferred)) {
    issues.push(`flex-not-justified (layoutStrategy prefers ${strategy.preferred}/${strategy.necessity}): flex requires dynamic distribution, fill/stretch or wrap`);
  }
  return issues;
}

export function validateFlow(input: unknown, actual: ActualLayout, exceptions: FlowException[] = []) {
  const layers = flattenLayers(prepareDesign(input)), byId = new Map(layers.map(n => [n.id, n]));
  const containers = new Map(semanticPlan(input).containers.map(container => [container.id, container]));
  const approved = new Map<string, string>();
  for (const entry of exceptions) {
    const node = byId.get(entry.id);
    if (!node || !exceptionCandidate(node) || !entry.reason?.trim() || approved.has(entry.id)) throw new Error(`Invalid flow exception: ${entry.id}; only explicit source ABSOLUTE children or leaf shapes may be exempted with a reason`);
    approved.set(entry.id, entry.reason.trim());
  }
  const mismatches: Array<{ id: string; issues: string[] }> = [];
  for (const node of layers) {
    const measured = actual.nodes.find(n => n.id === node.id), style = measured?.flowStyle;
    // Even exempted nodes require a complete sample; wrappers are never exempt.
    const issues = boxIssues(style).filter(issue => issue === "missing-flow-style" || !approved.has(node.id));
    if (!Array.isArray(style?.wrappers)) issues.push("missing-flow-wrappers");
    else style.wrappers.forEach((box, index) => {
      issues.push(...boxIssues(box).map(issue => `wrapper[${index}].${issue}`));
      if (box.display === "grid" || box.display === "inline-grid") issues.push(`wrapper[${index}].grid-forbidden`);
    });
    if (style && measured?.renderStyle && style.position !== measured.renderStyle.position) issues.push("inconsistent-position-sample");
    // Hard constraint: reject every Grid and justify each Flex; never exemptable.
    issues.push(...layoutPrimitiveIssues(style?.display, containers.get(node.id)?.layoutStrategy));
    if (issues.length) mismatches.push({ id: node.id, issues });
  }
  return { passed: mismatches.length === 0, mismatches, exceptions: [...approved].map(([id, reason]) => ({ id, reason, reviewRequired: true })) };
}
