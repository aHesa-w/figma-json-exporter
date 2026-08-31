import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SERVER_NAME, SERVER_VERSION, type Exporter } from "./bridge.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { validateFiles } from "./assets.js";
import { WORKFLOW_INSTRUCTIONS } from "./flow.js";
import type { ActualLayout } from "./geometry.js";

const flowBoxSchema = z.object({ display: z.string(), position: z.string(), cssFloat: z.string(), insets: z.array(z.string()).length(4), margins: z.array(z.string()).length(4), transform: z.string(), translate: z.string() });

export function createMCPServer(exporter: Exporter): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, {
    instructions: "Keep the existing figma_* tool names. Choose mode=figma for the live Figma plugin or mode=pen with an absolute penPath and nodeIds obtained from the Pen editor. Export visible source layers and local image assets first. Implement every exported layer using data-d2c-id matching its source layer ID; mark selection roots with data-d2c-root. For renderAs=image, keep the layer ID on a layout-sized wrapper and put the IMG with data-d2c-asset=assetId at imagePlacement (including negative offsets). Preserve original filenames and the expanded image canvas; never stretch it into the layout box or clip its outside strokes/shadows. Do not repeat baked text or effects. Use lineHeight.css when present: PERCENT stays %, Figma AUTO must have resolved px or be rasterized; never substitute fontSize or a guessed multiplier. Use textColor.css for text, not background-color; its alpha already includes paint opacity but not node opacity. Non-raster image paints must render via assets[imageHash], not empty containers. Read implementation.json and every layer.implementation BEFORE coding. Preserve clipsContent on the data-d2c-id element (both overflow axes), opacity, per-corner radii, text alignment, font weight/style and letterSpacing.css (percent is em, not px). Do not add clipping/opacity on unlabelled wrappers. For linear gradients use layer.gradient.css and its backgroundOrigin/Clip/Size/Position values. Direction is node-local; never copy an unconverted source angle or reverse color stops. The validator checks gradient angle, stops and paint box. Unsupported gradients cannot pass silently. Respect masks, paint order, strokes, effects, blend modes, transforms, stacking, Auto Layout/wrap and text truncation; unsupported properties must be reported, never dropped. Preserve exact target geometry. Wait for fonts/images, run the NEW exported DOM collector, then call figma_validate_layout. It also checks image references, clipping and rendering properties. Read propertyMismatches and reviewRequired. passed=true covers automated checks ONLY; visualAcceptance remains not-verified. Fix parent layout errors first and repeat real browser measurement until passed=true. Never fabricate measurements or alter target bounds to pass. If blocked or not converging, report failed checks; geometry success does not prove visual/interaction fidelity. " + WORKFLOW_INSTRUCTIONS,
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
  server.registerTool("figma_export", {
    description: "Export visible design layers while keeping this existing tool name. Default mode=figma reads the live plugin selection. mode=pen reads a local .pen document, optionally restricted by nodeIds, computes fixed/Auto Layout geometry and copies referenced local images. Writes design.json, layout.json, implementation.json, flow-plan.json and DOM collectors before returning. For unresolved Pen engine geometry pass penBounds; values are never guessed.",
    inputSchema: {
      mode: z.enum(["figma", "pen"]).optional().describe("Design source; defaults to figma."),
      penPath: z.string().refine(isAbsolute, "Use an absolute .pen path").optional().describe("Required with mode=pen."),
      nodeIds: z.array(z.string().min(1)).min(1).optional().describe("Pen mode only: selected node/画板 IDs. Defaults to all non-reusable top-level nodes."),
      penBounds: z.array(z.object({ id: z.string().min(1), x: z.number(), y: z.number(), width: z.number().nonnegative(), height: z.number().nonnegative() })).optional().describe("Pen mode only: exact absolute bounds returned by the Pen engine for dynamic, rotated, ref, or otherwise unresolved nodes."),
      penRasters: z.array(z.object({ id: z.string().min(1), path: z.string().refine(isAbsolute), scale: z.number().positive().max(4).optional(), bounds: z.object({ id: z.string().min(1), x: z.number(), y: z.number(), width: z.number().nonnegative(), height: z.number().nonnegative() }).optional() })).optional().describe("Pen mode only: exact PNGs exported by the Pen engine for compound shapes, unusual fonts or unsupported paints. bounds may include outside strokes/effects; scale defaults to 1."),
      outputDir: z.string().refine(isAbsolute, "Use an absolute directory").optional().describe("Parent directory for a new export bundle; defaults to ~/Downloads/figma-json-exporter. Existing files are not overwritten."),
      shapeGroupsAsImages: z.boolean().optional().describe("Default true: collapse pure shape groups, boolean operations and vectors into PNG image layers."),
    },
  }, async (args, extra) => result(() => {
    const penOnly = args.penPath || args.nodeIds || args.penBounds || args.penRasters;
    if ((args.mode ?? "figma") !== "pen" && penOnly) throw new Error("penPath/nodeIds/penBounds/penRasters require mode=pen");
    if (args.mode === "pen" && !args.penPath) throw new Error("mode=pen requires penPath");
    return exporter.export(extra.signal, args);
  }));
  server.registerTool("figma_validate_layout", {
    description: "Two-stage validation: phase=baseline first; after success refactor real HTML/CSS into flex/grid/block document flow and remeasure, then phase=flow with baselineReportPath. Only workflowComplete=true completes both automated stages. Compare actual browser DOM rectangles with an exported design.json. Returns pass/fail, missing/duplicate/unexpected IDs, hierarchy mismatches, propertyMismatches (clipping, opacity, radii, text metrics, gradient direction/stops), reviewRequired, and per-layer left/top/right/bottom/width/height deltas and a saved full report. Fix failed layers parent-first, rerender and repeat until passed; do not claim completion on failure. Actual data must come from the exported collector, not estimates.",
    inputSchema: {
      designPath: z.string().refine(isAbsolute),
      mode: z.enum(["figma", "pen"]).optional().describe("Optional source assertion. When supplied it must match design.json meta.sourceMode."),
      phase: z.enum(["baseline", "flow"]).optional().describe("Default baseline. Its success is not completion: refactor to document flow and run phase=flow next."),
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
    const actual = args.actual ?? JSON.parse(await readFile(args.actualPath!, "utf8")) as ActualLayout;
    const report = await validateFiles(args.designPath, actual, args.tolerance, { phase: args.phase, baselineReportPath: args.baselineReportPath, flowExceptions: args.flowExceptions });
    const { layers, failed, reviewRequired, flowMismatches, ...summary } = report;
    return { ...summary, flowMismatches: flowMismatches.slice(0, 30), flowMismatchCount: flowMismatches.length, failed: failed.slice(0, 30), failedCount: failed.length, reviewRequired: reviewRequired.slice(0, 30), reviewRequiredCount: reviewRequired.length, detail: "Full layer results and pending visual reviews saved at reportPath. passed covers the current stage only; require workflowComplete=true for both stages. Neither proves visual acceptance." };
  }));
  return server;
}
