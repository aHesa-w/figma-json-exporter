# Figma JSON Exporter

English | [简体中文](README.md)

Export the current Figma selection or a Pen `.pen` file as structured JSON, assets and an inspectable HTML preview. A local MCP server provides export, structure optimization and layout validation tools.

## Features

- Export hierarchy, geometry, text, fills, strokes, gradients, images and font metadata.
- Generate `design.json`, a semantic plan, an asset manifest and an HTML/CSS preview.
- Create and optimize a copy of a Figma selection from a model-authored plan without changing the original.
- Validate implementation geometry against browser-measured rectangles.
- Experimental export of Pen `.pen` files without the Figma plugin.

## Requirements

- Node.js 22+
- Figma Desktop (Figma mode only)

## Install and build

```bash
npm ci
npm run build
```

The bundled service is written to `dist/mcp-server.js`. `dist/` is not committed, so rebuild after installation or source changes.

## MCP configuration

stdio is the default transport. Replace the path with an absolute local path:

```json
{
  "mcpServers": {
    "figma-json-exporter": {
      "command": "node",
      "args": ["/absolute/path/to/figma-json-exporter/dist/mcp-server.js"]
    }
  }
}
```

Streamable HTTP is also available:

```bash
node dist/mcp-server.js --transport=http
```

The MCP endpoint is `http://127.0.0.1:3456/mcp`; see `mcp-config.http.json` for an example.

## Install the Figma plugin

1. In Figma Desktop, open Plugins → Development → Import plugin from manifest.
2. Select this project's `manifest.json`.
3. Keep `manifest.json`, `code.js` and `ui.html` in the same directory.
4. Run the plugin and connect it to the local service.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `figma_status` | Check the Figma plugin connection, or inspect a Pen file and list top-level nodes. |
| `figma_export` | Export the current selection or Pen nodes and generate design data, assets and a starter preview. |
| `figma_optimize_selection` | Create and optimize a copy to the right of the original from an allowlisted node-ID plan. |
| `figma_assess_preview` | Record preview decisions and produce the prerequisite file for layout validation. |
| `figma_guidance` | Load implementation rules by workflow or layer-property tag. |
| `figma_validate_layout` | Compare browser-measured rectangles with design data and write per-layer deltas. |

## Recommended workflow

### Export and implement

1. Call `figma_status` to confirm the connection.
2. Call `figma_export` to read the current selection.
3. Open `previewHtmlPath`, then read `previewCssPath` and `generationManifestPath`.
4. Call `figma_assess_preview` to record preview decisions.
5. Implement from the preview, preserve `data-d2c-id`, and do not use CSS Grid.
6. Call `figma_validate_layout` to establish a baseline.
7. Refactor into healthy document flow or Flex layout, then validate again.

`workflowComplete: true` means the automated gates are complete; the final visual result still requires human inspection.

### Optimize a Figma selection

1. Keep the target selection unchanged and call `figma_export`.
2. Build a node-ID-only plan from the latest hierarchy and absolute geometry.
3. Call `figma_optimize_selection` to create the optimized copy.

The optimizer removes invisible or fully ancestor-clipped nodes, establishes page architecture first, then orders siblings from their top-left position. Use:

- `rootArchitectureNodeIds` to keep page-shell nodes such as status bars, main content and bottom bars at the root.
- `floatingNodeIds` to keep independent overlays and collapsed controls at the root and preserve overlay priority.

The original selection is untouched. Unsafe plans involving instance internals, masks, non-contiguous sibling groups or stale selections are rejected. One Undo removes the created copy.

## Pen mode

> **Experimental:** Pen export is still incomplete and currently intended for validation and limited use cases. It does not yet guarantee full fidelity for every `.pen` node, layout, font, gradient or dynamic behavior. Prefer Figma mode for production workflows.

Pen mode reads local `.pen` JSON directly and does not require the Figma plugin:

```json
{
  "mode": "pen",
  "penPath": "/absolute/path/design.pen",
  "nodeIds": ["screen-id"]
}
```

Use `penBounds` and `penRasters` when exact supplemental geometry or raster assets are needed. Unsupported dynamic content fails explicitly instead of silently degrading.

## Export bundle

Each export creates an isolated directory containing:

```text
export-<request-id>/
├── design.json
├── semantic-plan.json
├── generation-manifest.json
├── assets/
└── preview/
    ├── index.html
    └── styles.css
```

The default response is a compact summary with file paths. Use `responseMode: "full"` only when the complete node JSON is needed in context.

## Important constraints

- Generated previews and downstream implementations must not use CSS Grid. Express overlap with document flow, Flex and controlled positioning.
- Image fills are content and are not treated as ordinary shapes during parent merging.
- Complex vectors, images, fonts or effects may be exported as assets to preserve visual fidelity.
- The shared service listens only on loopback. Clients reuse it and export requests are serialized.

## Development

```bash
npm test
```

## License

[MIT](LICENSE)
