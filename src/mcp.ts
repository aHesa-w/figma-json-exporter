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
    instructions: "Export visible Figma layers and local image assets first. Implement every exported layer using data-d2c-id matching its Figma ID; mark selection roots with data-d2c-root. Composite image nodes are atomic leaves. Preserve exact target geometry. Wait for fonts/images, run the exported DOM collector, then call figma_validate_layout. Fix parent layout errors first and repeat real browser measurement until passed=true. Never fabricate measurements or alter target bounds to pass. If blocked or not converging, report failed checks; geometry success does not prove visual/interaction fidelity.",
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
    description: "Export visible Figma selection with exact absolute and root-relative layer edges. Writes images, composite shape PNGs, design.json, layout.json and DOM collector to a unique local directory BEFORE returning paths. Use local assets rather than recreating icons. Reload the plugin after upgrading to schema v3.",
    inputSchema: {
      outputDir: z.string().refine(isAbsolute, "Use an absolute directory").optional().describe("Parent directory for a new export bundle; defaults to ~/Downloads/figma-json-exporter. Existing files are not overwritten."),
      shapeGroupsAsImages: z.boolean().optional().describe("Default true: collapse pure shape groups, boolean operations and vectors into PNG image layers."),
    },
  }, async (args, extra) => result(() => exporter.export(extra.signal, args)));
  server.registerTool("figma_validate_layout", {
    description: "Compare actual browser DOM rectangles with an exported design.json. Returns pass/fail, missing/duplicate/unexpected IDs, hierarchy mismatches, per-layer left/top/right/bottom/width/height deltas and a saved full report. Fix failed layers parent-first, rerender and repeat until passed; do not claim completion on failure. Actual data must come from the exported collector, not estimates.",
    inputSchema: {
      designPath: z.string().refine(isAbsolute),
      actualPath: z.string().refine(isAbsolute).optional().describe("Absolute path to JSON returned by the exported DOM collector"),
      actual: z.object({
        coordinateSpace: z.literal("root-relative"), stable: z.boolean(), fontsReady: z.boolean(),
        brokenImages: z.array(z.string()).optional(),
        viewport: z.object({ width: z.number(), height: z.number(), devicePixelRatio: z.number() }).optional(),
        nodes: z.array(z.object({ id: z.string(), rootId: z.string().nullable(), parentId: z.string().nullable(), visible: z.boolean(), bounds: z.object({ x: z.number(), y: z.number(), width: z.number().nonnegative(), height: z.number().nonnegative() }) })),
      }).optional().describe("Collector result; supply either actual or actualPath"),
      tolerance: z.number().min(0).max(10).optional().describe("CSS pixels, default 1; never raise tolerance merely to conceal errors"),
    },
  }, async (args) => result(async () => {
    if (Boolean(args.actual) === Boolean(args.actualPath)) throw new Error("Supply exactly one of actual or actualPath");
    const actual = args.actual ?? JSON.parse(await readFile(args.actualPath!, "utf8")) as ActualLayout;
    const report = await validateFiles(args.designPath, actual, args.tolerance);
    const { layers, failed, ...summary } = report;
    return { ...summary, failed: failed.slice(0, 30), failedCount: failed.length, detail: "Full layer results saved at reportPath" };
  }));
  return server;
}
