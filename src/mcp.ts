import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SERVER_NAME, SERVER_VERSION, type Exporter } from "./bridge.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { assessPreview, summarizeExport, validateFiles } from "./assets.js";
import { WORKFLOW_INSTRUCTIONS } from "./flow.js";
import { guidanceFor, guidanceTags } from "./guidance.js";
import type { ActualLayout } from "./geometry.js";

const flowBoxSchema = z.object({ display: z.string(), position: z.string(), cssFloat: z.string(), insets: z.array(z.string()).length(4), margins: z.array(z.string()).length(4), transform: z.string(), translate: z.string() });

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
      penPath: z.string().refine(isAbsolute, "Use an absolute .pen path").optional().describe("Required with mode=pen: absolute path of the current .pen document."),
    },
  }, async (args, extra) => result(() => {
    if ((args.mode ?? "figma") !== "pen" && args.penPath) throw new Error("penPath requires mode=pen");
    if (args.mode === "pen" && !args.penPath) throw new Error("mode=pen requires penPath");
    return exporter.status(extra.signal, args);
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
      penPath: z.string().refine(isAbsolute, "Use an absolute .pen path").optional().describe("Required with mode=pen."),
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
    if (args.mode === "pen" && !args.penPath) throw new Error("mode=pen requires penPath");
    return exporter.export(extra.signal, exportOptions).then(data => responseMode === "full" ? data : summarizeExport(data));
  }));
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
    description: "Two-stage validation. Baseline is rejected unless figma_assess_preview was completed and its previewAssessmentPath is supplied; this enforces using the deterministic preview as the implementation base. After baseline success, refine normal document flow and remeasure for phase=flow with baselineReportPath. Only workflowComplete=true completes automated stages. Actual data must come from the exported collector, not estimates.",
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
