import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SERVER_NAME, SERVER_VERSION, type Exporter } from "./bridge.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { assessPreview, summarizeExport, validateFiles } from "./assets.js";
import { WORKFLOW_INSTRUCTIONS } from "./flow.js";
import { guidanceFor, guidanceTags } from "./guidance.js";
import type { ActualLayout } from "./geometry.js";

const flowBoxSchema = z.object({ display: z.string(), position: z.string(), cssFloat: z.string(), insets: z.array(z.string()).length(4), margins: z.array(z.string()).length(4), transform: z.string(), translate: z.string() });
const localPath = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed === "~") return homedir();
  return trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed;
};

export function createMCPServer(exporter: Exporter): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, {
    instructions: "PREVIEW-FIRST IS MANDATORY, NOT OPTIONAL. After figma_export, do not write code yet: open previewHtmlPath, read previewCssPath and generationManifestPath, assess the preview with figma_assess_preview, and use the preview as the implementation base. Baseline validation is blocked without previewAssessmentPath. Keep existing figma_* tool names and load detailed standards progressively with figma_guidance. Preserve data-d2c-id on every layer and data-d2c-root on selection roots. passed=true is automated-only; visualAcceptance stays not-verified. " + WORKFLOW_INSTRUCTIONS,
  });
  const result = async (operation: () => Promise<unknown>): Promise<CallToolResult> => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(await operation()) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
    }
  };
  server.registerTool("figma_status", {
    description: "Check whether the selected design source is ready. Default mode=figma checks the open JSON Exporter plugin. mode=pen checks a local .pen document and lists its top-level nodes; Pen needs no exporter plugin.",
    inputSchema: {
      mode: z.enum(["figma", "pen"]).optional().describe("Design source; defaults to figma."),
      penPath: z.string().optional().describe("Pen mode only: absolute path or ~/... path of the current .pen document. Ignored when mode=figma."),
    },
  }, async (args, extra) => result(() => {
    const mode = args.mode ?? "figma";
    if (mode === "figma") return exporter.status(extra.signal, { mode });
    const penPath = localPath(args.penPath);
    if (!penPath) throw new Error("mode=pen requires penPath");
    if (!isAbsolute(penPath)) throw new Error("Pen mode requires an absolute .pen path or a ~/... path");
    return exporter.status(extra.signal, { mode, penPath });
  }));
  server.registerTool("figma_guidance", {
    description: "Load tag-indexed implementation and inference standards on demand, instead of reading all rules up front. Pass the guidanceTags carried by semantic-plan containers/repeatGroups/interactions, or stage tags (workflow/baseline/flow/style), layer-property tags (image/gradient/text/clipping/mask/paint) or the subagent tag for delegation guidance. Omit tags to list every available tag.",
    inputSchema: {
      tags: z.array(z.string().min(1)).optional().describe("Tags to load standards for; omit to list all available tags."),
    },
  }, async (args) => result(async () => {
    if (!args.tags?.length) return { availableTags: guidanceTags(), hint: "Pass one or more tags to load their standards." };
    return guidanceFor(args.tags);
  }));
  server.registerTool("figma_export", {
    description: "Export visible design layers and create the mandatory first implementation candidate at previewHtmlPath. STOP after export: open previewHtmlPath, read previewCssPath and generationManifestPath, then call figma_assess_preview before writing code. Do not bypass or replace the preview by starting from design.json. Default mode=figma reads the live selection; mode=pen reads a local .pen document. responseMode=summary is preferred.",
    inputSchema: {
      mode: z.enum(["figma", "pen"]).optional().describe("Design source; defaults to figma."),
      penPath: z.string().optional().describe("Required with mode=pen: absolute path or ~/... path."),
      nodeIds: z.array(z.string().min(1)).min(1).optional().describe("Pen mode only: selected node/画板 IDs. Defaults to all non-reusable top-level nodes."),
      penBounds: z.array(z.object({ id: z.string().min(1), x: z.number(), y: z.number(), width: z.number().nonnegative(), height: z.number().nonnegative() })).optional().describe("Pen mode only: exact absolute bounds returned by the Pen engine for dynamic, rotated, ref, or otherwise unresolved nodes."),
      penRasters: z.array(z.object({ id: z.string().min(1), path: z.string().refine(isAbsolute), scale: z.number().positive().max(4).optional(), bounds: z.object({ id: z.string().min(1), x: z.number(), y: z.number(), width: z.number().nonnegative(), height: z.number().nonnegative() }).optional() })).optional().describe("Pen mode only: exact PNGs exported by the Pen engine for compound shapes, unusual fonts or unsupported paints. bounds may include outside strokes/effects; scale defaults to 1."),
      outputDir: z.string().refine(isAbsolute, "Use an absolute directory").optional().describe("Parent directory for a new export bundle; defaults to ~/Downloads/figma-json-exporter. Existing files are not overwritten."),
      shapeGroupsAsImages: z.boolean().optional().describe("Default true: collapse pure shape groups, boolean operations and vectors into PNG image layers."),
      responseMode: z.enum(["summary", "full"]).optional().describe("Default summary returns roots/counts/file paths without embedding the full design. full is an explicit compatibility/debug escape hatch."),
    },
  }, async (args, extra) => result(() => {
    const { responseMode, ...exportOptions } = args;
    const penOnly = exportOptions.penPath || exportOptions.nodeIds || exportOptions.penBounds || exportOptions.penRasters;
    if ((args.mode ?? "figma") !== "pen" && penOnly) throw new Error("penPath/nodeIds/penBounds/penRasters require mode=pen");
    if (args.mode === "pen") {
      exportOptions.penPath = localPath(args.penPath);
      if (!exportOptions.penPath) throw new Error("mode=pen requires penPath");
      if (!isAbsolute(exportOptions.penPath)) throw new Error("Pen mode requires an absolute .pen path or a ~/... path");
    }
    return exporter.export(extra.signal, exportOptions).then(data => responseMode === "full" ? data : summarizeExport(data));
  }));
  const optimizationGroupSchema = z.object({
    parentId: z.string().min(1).max(256).describe("Exported source parent ID. The parent must be inside the current selection and outside an Instance subtree."),
    name: z.string().trim().min(1).max(80).describe("Architectural group name, such as Header summary, Assets row, Main activity or Page background."),
    childIds: z.array(z.string().min(1).max(256)).min(2).max(50).describe("A contiguous run of direct source children in original paint order. Group siblings first when their horizontal midlines are close, or when background/foreground layers form one visual section; non-contiguous children are rejected to protect paint order."),
  });
  server.registerTool("figma_optimize_selection", {
    description: "MODEL-PLANNED FIGMA WRITE. First call figma_export on the live selection and inspect its hierarchy/geometry. Build an architectural hierarchy before sorting: group contiguous siblings whose horizontal midlines are close into rows, and group the background/foreground paint layers of one visual section. Then sort only those architecture groups and remaining independent nodes by their top-left anchors: top-to-bottom, and left-to-right within an approximate row. Supply this bounded plan using exported source IDs. The plugin verifies the current selection has not changed, creates a separate copy to the right, removes invisible and fully ancestor-clipped nodes from the copy, creates requested groups before parent reordering, and preserves paint order inside every group. Original nodes are never modified. Arbitrary JavaScript and arbitrary property writes are not accepted. Instance internals and mask-bearing containers are protected. Returns every created/mutated node ID and selects the optimized copies in Figma.",
    inputSchema: {
      expectedSelectionIds: z.array(z.string().min(1).max(256)).min(1).max(20).describe("Exact root IDs from the latest live figma_export. The operation fails if the current selection differs."),
      copyName: z.string().trim().min(1).max(80).optional().describe("Suffix for copied roots; defaults to DOM优化."),
      spacing: z.number().min(40).max(5000).optional().describe("Horizontal gap before the copied selection; defaults to 200 Figma pixels."),
      plan: z.object({
        summary: z.string().trim().min(20).max(2000).describe("Model explanation of the structural problems and intended DOM-like organization."),
        removeInvisible: z.boolean().optional().describe("Defaults true. Removes invisible, zero-opacity and pixel-empty nodes from the copy, except protected Instance internals."),
        reorderParentIds: z.array(z.string().min(1).max(256)).max(200).optional().describe("Containers chosen for Layers-panel normalization after architectural grouping. Groups and independent nodes are ordered by top-left anchor; overlap paint order remains protected inside each created group."),
        ungroupNodeIds: z.array(z.string().min(1).max(256)).max(200).optional().describe("Redundant source GROUP IDs to dissolve in the copy. Frames and Instance internals are rejected."),
        groups: z.array(optimizationGroupSchema).max(100).optional().describe("Architectural groups chosen before parent sorting. Prefer row groups based on near horizontal midlines and section groups that contain their layered background/foreground siblings. Each group must contain contiguous direct siblings so stacking cannot be silently changed."),
        postGroups: z.array(optimizationGroupSchema).max(100).optional().describe("Exceptional final wrappers applied only after parent sorting. Use when two architecture members such as a section and its bottom layer are non-contiguous in raw paint order but become contiguous after the primary groups and reorder. The plugin still rejects them unless they are direct contiguous siblings at this final stage."),
        rootArchitectureNodeIds: z.array(z.string().min(1).max(256)).max(100).optional().describe("Page architecture nodes such as a status/header bar or bottom/footer. These must remain direct children of an optimized selection root and cannot be absorbed into content groups."),
        floatingNodeIds: z.array(z.string().min(1).max(256)).max(100).optional().describe("Independent overlay nodes that have no clear row-midline relationship, such as collapse controls or floating actions. They remain direct root children, are excluded from row grouping, and retain overlay paint priority."),
      }),
    },
  }, async (args, extra) => result(() => exporter.optimize(extra.signal, args)));
  const assessmentItemSchema = z.object({
    description: z.string().trim().min(5).describe("Concrete preview decision or problem observed after reading/rendering the preview."),
    nodeIds: z.array(z.string().min(1)).min(1).describe("Exported data-d2c-id values affected by this observation."),
  });
  server.registerTool("figma_assess_preview", {
    description: "MANDATORY gate immediately after figma_export and before implementation. First open/render previewHtmlPath and read previewCssPath plus generationManifestPath. Then record what the deterministic preview already gets right and must be preserved, plus targeted gaps/actions. Returns previewAssessmentPath required by baseline validation. Generic claims or unknown node IDs are rejected.",
    inputSchema: {
      designPath: z.string().refine(isAbsolute).describe("designPath returned by the same figma_export."),
      assessment: z.object({
        summary: z.string().trim().min(20).describe("Concrete overall assessment of the rendered preview as the implementation starting point."),
        preserve: z.array(assessmentItemSchema).min(1).describe("Correct preview structure/styles to retain rather than regenerate."),
        gaps: z.array(assessmentItemSchema.extend({ action: z.string().trim().min(5).describe("Targeted code change based on this preview gap.") })).min(1).describe("Observed preview gaps and targeted changes; do not list speculative redesigns."),
      }),
    },
  }, async (args) => result(() => assessPreview(args.designPath, args.assessment)));
  server.registerTool("figma_validate_layout", {
    description: "Two-stage validation. Baseline requires the figma_assess_preview receipt. After baseline, refine normal document flow and remeasure phase=flow with baselineReportPath. CSS Grid is globally forbidden on design nodes and anonymous structural wrappers; display:grid/inline-grid always fail flow. Only workflowComplete=true completes automated stages. Measurements must come from the exported collector.",
    inputSchema: {
      designPath: z.string().refine(isAbsolute),
      mode: z.enum(["figma", "pen"]).optional().describe("Optional source assertion. When supplied it must match design.json meta.sourceMode."),
      phase: z.enum(["baseline", "flow"]).optional().describe("Default baseline. Its success is not completion: refactor to document flow and run phase=flow next."),
      previewAssessmentPath: z.string().refine(isAbsolute).optional().describe("Required for baseline: accepted receipt returned by figma_assess_preview for this designPath."),
      baselineReportPath: z.string().refine(isAbsolute).optional().describe("Required for flow: reportPath of a successful baseline for the unchanged design; new sample, same viewport, no looser tolerance."),
      flowExceptions: z.array(z.object({ id: z.string(), reason: z.string().trim().min(1) })).optional().describe("Explicit overlay exceptions for source ABSOLUTE nodes or leaf shapes only; ordinary containers and text cannot be exempted. Raster IMG offsets do not need exceptions."),
      actualPath: z.string().refine(isAbsolute).optional().describe("Absolute path to JSON returned by the exported DOM collector"),
      actual: z.object({
        collectorVersion: z.number().int().optional(), sampleId: z.string().optional(), collectedAt: z.string().optional(),
        coordinateSpace: z.literal("root-relative"), stable: z.boolean(), fontsReady: z.boolean(),
        brokenImages: z.array(z.string()).optional(),
        viewport: z.object({ width: z.number(), height: z.number(), devicePixelRatio: z.number() }).optional(),
        nodes: z.array(z.object({
          id: z.string(), rootId: z.string().nullable(), parentId: z.string().nullable(), visible: z.boolean(), tagName: z.string().optional(), imageSources: z.array(z.string()).optional(),
          textStyle: z.object({ color: z.string().optional(), textFillColor: z.string().optional(), fontSize: z.number().nullable(), lineHeight: z.number().nullable(), fontWeight: z.number().nullable().optional(), fontStyle: z.string().optional(), letterSpacing: z.number().nullable().optional(), textAlign: z.string().optional(), direction: z.string().optional(), textDecorationLine: z.string().optional() }).optional(),
          assetImages: z.array(z.object({ assetId: z.string(), src: z.string(), bounds: z.object({ x: z.number(), y: z.number(), width: z.number().nonnegative(), height: z.number().nonnegative() }), naturalWidth: z.number().nonnegative(), naturalHeight: z.number().nonnegative(), opacity: z.number().nullable(), objectFit: z.string() })).optional(),
          flowStyle: flowBoxSchema.extend({ wrappers: z.array(flowBoxSchema) }).optional(),
          renderStyle: z.object({ backgroundImage: z.string().optional(), backgroundOrigin: z.string().optional(), backgroundClip: z.string().optional(), backgroundSize: z.string().optional(), backgroundPosition: z.string().optional(), opacity: z.number().nullable(), position: z.string(), overflowX: z.string(), overflowY: z.string(), clipPath: z.string(), maskImage: z.string(), contain: z.string(), borderBoxWidth: z.number().nullable(), borderBoxHeight: z.number().nullable(), cornerRadii: z.array(z.string()).length(4), wrapperEffects: z.array(z.string()) }).optional(),
          bounds: z.object({ x: z.number(), y: z.number(), width: z.number().nonnegative(), height: z.number().nonnegative() }),
        })),
      }).optional().describe("Collector result; supply either actual or actualPath"),
      tolerance: z.number().min(0).max(10).optional().describe("CSS pixels, baseline default 1; flow defaults to baseline tolerance. Never raise tolerance merely to conceal errors"),
    },
  }, async (args) => result(async () => {
    if (Boolean(args.actual) === Boolean(args.actualPath)) throw new Error("Supply exactly one of actual or actualPath");
    const designHeader = JSON.parse(await readFile(args.designPath, "utf8"));
    const sourceMode = designHeader?.meta?.sourceMode ?? "figma";
    if (args.mode && args.mode !== sourceMode) throw new Error(`Validation mode=${args.mode} does not match design source ${sourceMode}`);
    if ((args.phase ?? "baseline") === "baseline" && !args.previewAssessmentPath) throw new Error("Preview-first gate: open previewHtmlPath, read previewCssPath and generationManifestPath, call figma_assess_preview, then retry baseline with previewAssessmentPath");
    const actual = args.actual ?? JSON.parse(await readFile(args.actualPath!, "utf8")) as ActualLayout;
    const report = await validateFiles(args.designPath, actual, args.tolerance, { phase: args.phase, previewAssessmentPath: args.previewAssessmentPath, baselineReportPath: args.baselineReportPath, flowExceptions: args.flowExceptions });
    const { layers, failed, reviewRequired, flowMismatches, ...summary } = report;
    return { ...summary, flowMismatches: flowMismatches.slice(0, 30), flowMismatchCount: flowMismatches.length, failed: failed.slice(0, 30), failedCount: failed.length, reviewRequired: reviewRequired.slice(0, 30), reviewRequiredCount: reviewRequired.length, detail: "Full layer results and pending visual reviews saved at reportPath. passed covers the current stage only; require workflowComplete=true for both stages. Neither proves visual acceptance." };
  }));
  return server;
}
