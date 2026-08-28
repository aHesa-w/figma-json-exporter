import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SERVER_NAME, SERVER_VERSION, type Exporter } from "./bridge.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { validateFiles } from "./assets.js";
import type { ActualLayout } from "./geometry.js";

export function createMCPServer(exporter: Exporter): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, {
    instructions: "Export visible Figma layers and local image assets first. Implement every exported layer using data-d2c-id matching its Figma ID; mark selection roots with data-d2c-root. For renderAs=image, keep the layer ID on a layout-sized wrapper and put the IMG with data-d2c-asset=assetId at imagePlacement (including negative offsets). Preserve original filenames and the expanded image canvas; never stretch it into the layout box or clip its outside strokes/shadows. Do not repeat baked text or effects. Use lineHeight.css: PERCENT stays %, AUTO must have Figma-resolved px or be rasterized; never substitute normal, fontSize or a guessed multiplier. Use textColor.css for text, not background-color; its alpha already includes paint opacity but not node opacity. Non-raster image paints must render via assets[imageHash], not empty containers. Read implementation.json and every layer.implementation BEFORE coding. Preserve clipsContent on the data-d2c-id element (both overflow axes), opacity, per-corner radii, text alignment, font weight/style and letterSpacing.css (percent is em, not px). Do not add clipping/opacity on unlabelled wrappers. For linear gradients use layer.gradient.css and its backgroundOrigin/Clip/Size/Position values. Direction is node-local and depends on width/height: never copy a bare matrix angle or reverse color stops. The validator checks gradient angle, stops and paint box. Complex gradients are rasterized; legacy unsupported gradients cannot pass silently. Respect masks, paint order, strokes, effects, blend modes, transforms, stacking, Auto Layout/wrap and text truncation; unsupported properties must be reported, never dropped. Preserve exact target geometry. Wait for fonts/images, run the NEW exported DOM collector, then call figma_validate_layout. It also checks image references, clipping and rendering properties. Read propertyMismatches and reviewRequired. passed=true covers automated checks ONLY; visualAcceptance remains not-verified. Fix parent layout errors first and repeat real browser measurement until passed=true. Never fabricate measurements or alter target bounds to pass. If blocked or not converging, report failed checks; geometry success does not prove visual/interaction fidelity.",
  });
  const result = async (operation: () => Promise<unknown>): Promise<CallToolResult> => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(await operation()) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
    }
  };
  server.registerTool("figma_status", {
    description: "Check whether the Figma JSON Exporter plugin is open and connected.",
    inputSchema: {},
  }, async (_args, extra) => result(async () => ({
    connected: await exporter.connected(extra.signal), pluginName: "Figma JSON Exporter",
  })));
  server.registerTool("figma_export", {
    description: "Export visible Figma selection with exact absolute and root-relative layer edges. Writes images, composite shape PNGs, design.json, layout.json, implementation.json and DOM collector to a unique local directory BEFORE returning paths. Use local assets rather than recreating icons. Read the per-layer implementation rules and pending reviews; reload the plugin after upgrading to v3.4.",
    inputSchema: {
      outputDir: z.string().refine(isAbsolute, "Use an absolute directory").optional().describe("Parent directory for a new export bundle; defaults to ~/Downloads/figma-json-exporter. Existing files are not overwritten."),
      shapeGroupsAsImages: z.boolean().optional().describe("Default true: collapse pure shape groups, boolean operations and vectors into PNG image layers."),
    },
  }, async (args, extra) => result(() => exporter.export(extra.signal, args)));
  server.registerTool("figma_validate_layout", {
    description: "Compare actual browser DOM rectangles with an exported design.json. Returns pass/fail, missing/duplicate/unexpected IDs, hierarchy mismatches, propertyMismatches (clipping, opacity, radii, text metrics, gradient direction/stops), reviewRequired, and per-layer left/top/right/bottom/width/height deltas and a saved full report. Fix failed layers parent-first, rerender and repeat until passed; do not claim completion on failure. Actual data must come from the exported collector, not estimates.",
    inputSchema: {
      designPath: z.string().refine(isAbsolute),
      actualPath: z.string().refine(isAbsolute).optional().describe("Absolute path to JSON returned by the exported DOM collector"),
      actual: z.object({
        collectorVersion: z.number().int().optional(),
        coordinateSpace: z.literal("root-relative"), stable: z.boolean(), fontsReady: z.boolean(),
        brokenImages: z.array(z.string()).optional(),
        viewport: z.object({ width: z.number(), height: z.number(), devicePixelRatio: z.number() }).optional(),
        nodes: z.array(z.object({
          id: z.string(), rootId: z.string().nullable(), parentId: z.string().nullable(), visible: z.boolean(), tagName: z.string().optional(), imageSources: z.array(z.string()).optional(),
          textStyle: z.object({ color: z.string().optional(), textFillColor: z.string().optional(), fontSize: z.number().nullable(), lineHeight: z.number().nullable(), fontWeight: z.number().nullable().optional(), fontStyle: z.string().optional(), letterSpacing: z.number().nullable().optional(), textAlign: z.string().optional(), direction: z.string().optional(), textDecorationLine: z.string().optional() }).optional(),
          assetImages: z.array(z.object({ assetId: z.string(), src: z.string(), bounds: z.object({ x: z.number(), y: z.number(), width: z.number().nonnegative(), height: z.number().nonnegative() }), naturalWidth: z.number().nonnegative(), naturalHeight: z.number().nonnegative(), opacity: z.number().nullable(), objectFit: z.string() })).optional(),
          renderStyle: z.object({ backgroundImage: z.string().optional(), backgroundOrigin: z.string().optional(), backgroundClip: z.string().optional(), backgroundSize: z.string().optional(), backgroundPosition: z.string().optional(), opacity: z.number().nullable(), position: z.string(), overflowX: z.string(), overflowY: z.string(), clipPath: z.string(), maskImage: z.string(), contain: z.string(), borderBoxWidth: z.number().nullable(), borderBoxHeight: z.number().nullable(), cornerRadii: z.array(z.string()).length(4), wrapperEffects: z.array(z.string()) }).optional(),
          bounds: z.object({ x: z.number(), y: z.number(), width: z.number().nonnegative(), height: z.number().nonnegative() }),
        })),
      }).optional().describe("Collector result; supply either actual or actualPath"),
      tolerance: z.number().min(0).max(10).optional().describe("CSS pixels, default 1; never raise tolerance merely to conceal errors"),
    },
  }, async (args) => result(async () => {
    if (Boolean(args.actual) === Boolean(args.actualPath)) throw new Error("Supply exactly one of actual or actualPath");
    const actual = args.actual ?? JSON.parse(await readFile(args.actualPath!, "utf8")) as ActualLayout;
    const report = await validateFiles(args.designPath, actual, args.tolerance);
    const { layers, failed, reviewRequired, ...summary } = report;
    return { ...summary, failed: failed.slice(0, 30), failedCount: failed.length, reviewRequired: reviewRequired.slice(0, 30), reviewRequiredCount: reviewRequired.length, detail: "Full layer results and pending visual reviews saved at reportPath. passed is automated checks only." };
  }));
  return server;
}
