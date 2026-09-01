# Figma JSON Exporter

[简体中文](README.md) | English

A Figma selection / Pen `.pen` design export tool and local MCP server. The MCP name and the `figma_*` tool names stay unchanged. The MCP is implemented entirely in TypeScript, pre-compiled and bundled into `dist/mcp-server.js`; it only needs Node.js 22 or newer at runtime and never invokes Go, a TypeScript compiler or a package manager.

## Build

```bash
npm ci
npm run build
```

The build runs type checking first, then bundles the service and its runtime dependencies into a single JS file. `dist/` is not committed to Git; rebuild after a fresh install or any source change. The compiled artifact can be copied to another directory and run standalone without `src/` or `node_modules/` next to it.

The project's `.npmrc` uses the public npm registry, does not depend on an internal mirror, and does not modify the global npm configuration.

```bash
node /absolute/path/to/figma-json-exporter/dist/mcp-server.js
```

**stdio MCP** is the default. The entry first checks for a local shared service: when none is running, it launches a background HTTP/WebSocket service from the same compiled artifact, then accepts agent calls over stdio. Multiple agents reuse one service; export requests are serialized and isolated by `requestId`.

This "local service" still handles MCP and WebSocket traffic — it is not a static file server that only serves downloads. Starting it never compiles source and never depends on any model vendor.

## MCP configuration

Both `mcp-config.json` and `mcp-config.stdio.json` use the compiled entry; replace the path with a local absolute path:

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

- `figma_status`: checks the Figma plugin by default; with `mode: "pen"` it checks a local `.pen` file and lists its top-level nodes.
- `figma_export`: exports the current Figma selection by default; with `mode: "pen"` it exports selected nodes from a `.pen` file. Both modes persist the full design, assets, plans and a model-free starter preview first. MCP returns a compact roots/counts/files summary by default; pass `responseMode: "full"` only when the complete design JSON is explicitly needed in context.
- `figma_assess_preview`: mandatory pre-implementation gate. The model must open `previewHtmlPath`, read `previewCssPath` and `generationManifestPath`, then submit preview decisions to preserve plus targeted gaps/actions and affected layer IDs. It returns the `previewAssessmentPath` required by baseline validation.
- `figma_guidance`: progressively loads implementation/inference standards by tag. Pass the `guidanceTags` carried by semantic-plan containers/repeat groups/interaction candidates, or stage tags (`workflow`/`baseline`/`flow`/`style`), layer-property tags (`image`/`gradient`/`text`/`clipping`/`mask`/`paint`) or `subagent`; omit tags to list every available tag.
- `figma_validate_layout`: compares browser-measured rectangles against the design JSON and returns per-layer deltas plus a full report path; `mode` can assert the design source.

For Streamable HTTP, start it locally first:

```bash
node dist/mcp-server.js --transport=http
# or npm run serve / ./figma-export.sh serve
```

Then use `http://127.0.0.1:3456/mcp` from `mcp-config.http.json`. The protocol is implemented by the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x).

## Figma plugin

1. In Figma Desktop open Plugins → Development → Import plugin from manifest.
2. Choose `manifest.json` in this directory.
3. Select the design nodes and run the JSON Exporter plugin.
4. Either click "Export" manually, or let the agent call MCP after the plugin connects to the local service.

The plugin needs `manifest.json`, `code.js` and `ui.html`. The UI's "Start" button only re-detects and reconnects the service; the local process is started by the JS entry. "Close" stops the shared service, which is re-detected and restarted the next time a stdio client starts.

## Pen mode (tool names unchanged)

Pen mode reads a local `.pen` JSON directly — it does not depend on the Figma plugin and does not require the Pen editor to stay resident. The agent first obtains the current file path and selected node IDs from Pen/Pencil, then calls the existing tools:

```json
{ "mode": "pen", "penPath": "/absolute/path/design.pen" }
```

```json
{
  "mode": "pen",
  "penPath": "/absolute/path/design.pen",
  "nodeIds": ["screen-id"],
  "outputDir": "/absolute/path/exports"
}
```

Omitting `nodeIds` exports all non-reusable top-level nodes. The current editor selection is transient state that a static service cannot infer from the file itself, so the agent must pass the selected IDs via `nodeIds`; never interpret "current selection" as guessing some frame.

The adapter supports Pen 2.x JSON, default/node theme variables, in-file component instances and descendant overrides, fixed layout, horizontal/vertical Auto Layout, `fit_content`/`fill_container`, hidden/zero-opacity node filtering, text, image fills, colors, linear gradients, clipping, opacity, corner radii, strokes and effects. Image URLs must be local paths relative to the `.pen` file, copied into the bundle on export; PNG/JPEG/GIF/WebP/SVG are all acceptable as image fills.

Static reading cannot reliably execute scripts, external imports, a font layout engine or all dynamic sizing. Nodes whose size cannot be determined fail explicitly rather than publishing an unreliable result. The agent can first read the exact absolute bounding box from the Pen engine and pass it via `penBounds: [{"id":"...","x":0,"y":0,"width":100,"height":100}]`; rotated or dynamic nodes must supply the corresponding rectangle. `penBounds` is a source-engine computation, not something the agent estimates from a screenshot.

Composite shapes, special fonts, and angular/radial/mesh gradients need the Pen engine to produce the final render. The agent first exports the corresponding node PNG from Pen, then passes `penRasters: [{"id":"node-id","path":"/absolute/node.png","scale":1,"bounds":{"id":"node-id","x":0,"y":0,"width":100,"height":100}}]`. `bounds` can override the image canvas to include outside strokes, shadows or blur; it must contain the node layout box, and the PNG pixel size must equal `bounds × scale`. Such nodes are marked as atomic images in the unified JSON; their child shapes are not re-emitted as DOM. Without a reliable raster, complex gradients fail explicitly instead of being silently dropped.

After export the implementation and validation flow is the same as Figma: read `design.json`/`implementation.json`/`semantic-plan.json`/`style-plan.json`, run the browser collector, call `figma_validate_layout` for baseline, then reflow per `flow-plan.json` and the semantic plan and run flow. `style-plan.json` requires the final artifact to include a real imported CSS file, static layout/visual styles/image placement must not remain in `style` attributes, identical rules must reuse a class name, and repeated declarations must be extracted into foundation or component styles. You may pass `mode: "pen"` in validation parameters; if it disagrees with `design.json`'s source, validation refuses to run.

## Default filtering rules

Manual JSON/ZIP export and MCP export share the same logic:

- Exclude nodes with `visible === false` or whose own `opacity === 0`.
- Excluded nodes' whole subtrees are not traversed or exported, and their dedicated images are neither read nor packed.
- The selected root nodes follow the same rule; when selecting a child of a hidden parent, ancestors outside the selection are also checked.
- Nodes with `opacity > 0` are kept; a node with a transparent fill, no fill, or acting only as a container is not removed for that reason.
- `meta.nodeCount` and `meta.nodeName` count only the actually exported selection root nodes.
- When every selected node is filtered out, a clear error is returned and no empty files are produced.

Filtering does not modify the design. It filters by node properties, not by pixel visibility, and never guesses whether occluded, clipped or off-screen nodes should be removed.

## v3.7: validate restoration first, then reflow and semantic plan

MCP requires two stages by default; the exported absolute coordinates are only comparison references and do not require the final HTML to use absolute positioning everywhere:

1. **baseline**: finish the first restored version and measure every layer's geometry, styles and images. `passed: true` only means the first stage passed; at that point `workflowComplete: false`, so the task is not finished.
2. **Document flow and semantic refactor**: refactor parent-first using `block → inline/inline-block → flex`. CSS Grid is completely disabled: `display:grid/inline-grid` on design nodes or anonymous structural wrappers fails flow and cannot be exempted. Use block flow for ordinary vertical structure, inline flow for simple rows, and Flex/`flex-wrap` for dynamic distribution, fill/stretch or non-overlapping two-dimensional rows. Overlap uses `layered-flow`: meaningful content remains in flow, broad backgrounds become parent paint or pseudo-elements where possible, and positioning is restricted to backgrounds, decorations, source-absolute nodes or leaf shapes. Preserve IDs, hierarchy, repeat structures and safe local interactions; never reproduce layout with per-child coordinate margins.
3. **flow**: rerun the collector, submit fresh data at the same viewport and DPR as the first stage, and reference the first-stage success report. Run all the original geometry/style checks again while also checking document-flow constraints. On failure adjust the page, recollect and retry; only `workflowComplete: true` means both automated stages passed.

Agent call example (replace paths with the real files):

```json
{
  "designPath": "/.../design.json",
  "previewAssessmentPath": "/.../preview-assessment.json",
  "actualPath": "/.../baseline-actual.json",
  "phase": "baseline"
}
```

After getting a successful `reportPath`, refactor and recollect, then call the same `figma_validate_layout`:

```json
{
  "designPath": "/.../design.json",
  "actualPath": "/.../flow-actual.json",
  "phase": "flow",
  "baselineReportPath": "/.../successful-baseline-report.json"
}
```

The second stage cannot omit the successful baseline, cannot reference another design or a modified design file, cannot reuse the baseline sample ID, and cannot submit a sample collected before the baseline passed. Omitting the second-stage tolerance inherits the baseline tolerance; specifying it explicitly cannot relax it. The saved baseline is re-checked automatically; these checks prevent workflow misuse — they are not a cryptographic proof of where the browser sample came from and cannot replace real measurement.

**Document-flow convention**: ordinary content and anonymous wrappers inside the selection cannot use absolute/fixed, float, nonzero relative offsets, negative margins or translate/matrix translation to assemble coordinates. Static, offset-free relative, sticky, block/inline layout and semantically approved Flex are allowed; CSS Grid is completely disabled in generated artifacts. This is this tool's conservative implementation convention, not a claim that these CSS features are illegal. [CSS positioning and normal flow](https://www.w3.org/TR/css-position-3/)

The absolute IMG offset used inside an image to preserve outside strokes/shadows is exempt from the document-flow limit; the `data-d2c-id` outer wrapper must still participate in document flow. A non-root node or leaf shape whose source explicitly sets `layoutPositioning: ABSOLUTE` may be exempted item by item via `flowExceptions: [{"id":"...","reason":"specific overlay purpose"}]`; ordinary text/containers cannot be arbitrarily exempted, and anonymous wrappers are not exempted along with them. Exceptions are listed as pending review and cannot mark the whole page as exceptional.

New report fields: `phase`, `workflowComplete`, `baselineReportPath`, `flowMismatches`, `flowExceptions`. After the first stage passes, `nextAction` explicitly requires refactoring and a second stage. `semantic-plan.json` provides source-arrangement suggestions and does not masquerade as source or interaction acceptance; automated acceptance still does not prove pixels, responsive behavior, complete interactions or code quality. MCP enforces constraints and comparisons; HTML/CSS edits and browser execution are done by the agent, which never rewrites the user's page itself.

This service version is **3.12.1**; the Figma plugin remains **3.5.0**. `figma_status` ignores an accidental `penPath` in Figma mode; Pen mode accepts absolute and `~/...` paths, while relative paths return a recoverable tool error instead of MCP `-32602`. The 3.12.0 Grid ban, preview-first gate, styled text and no-soft-wrap behavior remain unchanged; the collector stays at **collectorVersion: 5**.

## Images land on disk first, JSON returns after

Call `figma_export`, optionally passing `outputDir` (absolute path) and `shapeGroupsAsImages` (default `true`). Every export creates a new directory and never overwrites existing files:

```text
export-<uuid>/
  images/                  original and composite-shape PNGs, named by content hash
  design.json              full layer tree, asset manifest and coordinates
  layout.json              per-layer coordinate table plus property check/review list
  implementation.json      per-layer implementation rules, automated checks and pending visual review items
  flow-plan.json           two-stage flow, document-flow refactor suggestions and exception candidates
  semantic-plan.json       readable code order, repeat-structure loop hints, bounded interaction candidates, plus tab selected/unselected state styles and input control type/style inference
  style-plan.json          real-CSS, static-style, reuse and deduplication requirements
  generation-manifest.json container, background, alignment, repeat, fallback and review decisions used by the model-free preview
  preview/
    index.html             starter preview generated from the complete layer tree
    preview.css            static structure, geometry, text, image and paint styles for the preview
  collect-layout.js        a DOM collector loadable by the page
  collector-expression.js  a collector expression executable by browser tools
```

The node tree also keeps fills, strokes, effects, radii, text, fonts, Auto Layout, constraints and component references. The starter preview uses block, inline and wrapping Flex for vertical, horizontal and non-overlapping two-dimensional structures; overlap uses no-Grid `layered-flow`, keeping real content in flow and positioning only obvious background/decorative layers for review. Image bytes travel from the Figma plugin to the local service; the directory is published only after every file is written. Missing images, unknown formats or write failures abort the export.

- `meta.schemaVersion = 3`; `meta.designPath`, `meta.layoutPath`, `meta.semanticPlanPath` etc. are local absolute paths.
- `meta.exporterVersion = "3.5.0"` marks the styled-text-capable plugin as loaded; after upgrading, close and reopen the Figma plugin. The service rejects new exports from old plugins so mixed text cannot silently keep rasterizing; old v3 JSON can still be used for validation diagnostics.
- `assets[assetId]` contains `path`, `relativePath`, `mimeType`, `byteLength`, `sha256`.
- An ordinary image fill's `imageHash` maps to `assets[imageHash]`; shape-image nodes reference assets via `assetId`.
- Manual export can choose ZIP, containing `index.json` and `images/` with relative paths inside the ZIP. The UI ZIP pack still references JSZip on cdnjs; MCP does not depend on that CDN.

### Composite shapes exported as a whole

By default, VECTOR, BOOLEAN_OPERATION, and any GROUP whose visible descendants are all shapes are exported as 2× PNGs. Ordinary layout groups containing TEXT, FRAME or INSTANCE are not rasterized as a whole; text and layout stay as nodes.

These nodes are marked `renderAs: "image"` with `assetId` and `collapsedNodeIds` and no longer carry `children`. Implement them as one atomic layer, validate its overall bounds, and do not create DOM for the merged internal paths. The PNG already contains the node's appearance and opacity; do not re-apply the same node's fill, stroke, rotation or opacity — outer container styles must still be preserved. The model-free preview follows the same rule so vector icons and charts do not acquire black/white bounding-box blocks or rectangular outlines. Disable with `shapeGroupsAsImages: false`; manual export has the matching option.

PNG uses Figma's `exportAsync` with `useAbsoluteBounds: true`. v3.3 uses the union of the layout box and visual bounds as the canvas: when it exceeds the layout box, export into a temporary transparent container to preserve outside strokes/shadows, never squeezing the image canvas into the layout box. See [Figma ExportSettings](https://developers.figma.com/docs/plugins/api/ExportSettings/).

### Line height, special fonts and image fills

Text line height keeps the original Figma `unit/value` and provides a directly CSS-usable `lineHeight.css` plus `lineHeight.pixels` when computable:

| Input (font size 32) | `css` | `pixels` |
| --- | --- | --- |
| `PERCENT / 100` | `100%` | `32` |
| `PERCENT / 125.5` | `125.5%` | `40.16` |
| `PIXELS / 100` | `100px` | `100` |
| `AUTO`, Figma CSS returns explicit px | the px Figma returns | the value |
| `AUTO`, no explicit px | `null`, must rasterize | `null` |

Never append `px` to `lineHeight.value` directly. `AUTO` does not fabricate a fixed pixel line height; when mixed styles cannot be expressed safely in one CSS rule, keep the original text and rasterize.

Fonts use an explicit common system-font list (e.g. Arial, Helvetica, PingFang SC/TC/HK, Microsoft YaHei, Segoe UI), not a vendor-name special case. Names are trimmed and compared case-insensitively. Fonts outside the list, fonts missing in Figma, and mixed text styles are automatically exported as PNG, marked `renderAs: "image"` and `rasterReason`, with asset type `text`. `characters` and the original font metadata are kept; use the original text as the image `alt`.

This is a conservative policy and does not guarantee every listed font is installed on every OS; the Figma sandbox cannot read the target browser's font inventory. Rasterization does not modify the design, install or substitute fonts, or require missing fonts to load first — it uses the text appearance Figma already saved. [Figma text docs](https://developers.figma.com/docs/plugins/working-with-text/)

**Image fills are not standalone Figma IMAGE nodes.** v3.1 exports leaf nodes with a visible image fill/stroke as `image-render` PNG by default, with crop, filters, fill opacity and rotation rendered by Figma, while also keeping the original `image-fill`. They and special fonts are independent of the `shapeGroupsAsImages` switch — do not handle only GROUP/VECTOR and then ignore these images.

An image container with children still keeps its layout hierarchy; the `imageHash` in its `fills/strokes` must map to `assets[imageHash]` and be painted, never an empty container. Export keeps `imageTransform`, `scaleMode`, `scalingFactor`, `rotation`, `filters` and gradient matrices; do not treat CROP as arbitrary centered cover. [Figma Paint definition](https://developers.figma.com/docs/plugins/api/Paint/)

All `renderAs: "image"` nodes should be handled before branches like `type === "TEXT"` and use the corresponding local file. Do not re-paint original text, fills or effects on the image, or re-apply node opacity.

## v3.5.0: mixed text ranges

When a TEXT node only has expressible per-range differences in color, weight, size, family, line height, letter spacing, case or decoration, the plugin uses Figma `getStyledTextSegments` to export contiguous character ranges. The preview emits child `<span>` elements and external CSS without inline styles. DOM text defaults to `white-space: pre`: explicit source newlines are preserved, browser soft wrapping caused by container width is disabled, and child segments inherit the same rule. Every segment must use a portable system font, one solid text fill and resolvable typography. Gradient/image text fills, text strokes, mixed paragraph properties, unknown fonts, per-range AUTO leading or incomplete ranges keep the PNG fallback rather than losing visual semantics for selectable DOM text.

## v3.4.1: empty visual bounds recovery

Figma's `absoluteRenderBounds` may be `null`; this alone must not be treated as corrupt layer data. Previously treating it as a failure condition blocked the export of some instance children clipped by ancestors. The new version first re-measures rasterized nodes via an unclipped clone: preserving the original layout, absolute transform, opacity and inherited variable modes, it recovers the canvas before computing the image offset, and keeps the original parent clipping relationship without deleting out-of-frame nodes. [Figma visual bounds definition](https://developers.figma.com/docs/plugins/api/node-properties/#absoluterenderbounds)

This release adds simulated clipping/instance-child and MCP disk-persistence regressions; it did not regenerate pages and did not verify pixel results for a specific design file. After upgrading, reopen the Figma plugin and restart the MCP service to load 3.4.1; the collection protocol remains version 4.

## v3.4: gradient direction and stop validation

A single linear gradient with a normal blend mode stays as an editable node. MCP provides `layer.gradient` in `design.json` and `layout.json`: `angleDeg`, converted `stops`, full `css` and the background paint-box settings. Implement with `gradient.css` as `background-image` and apply its `backgroundOrigin/Clip/Size/Position/Repeat` — do not just read the angle from the matrix or swap the color order.

- CSS angle and stop percentages are computed from the Figma gradient matrix, node-local width/height, scale and offset. A rectangle layer's angle cannot reuse the square result directly; translation/scaling cannot be dropped. Stops may fall outside 0–100%; paint.opacity is folded into stop alpha exactly once.
- The new collector reads the actual computed `backgroundImage`, `backgroundOrigin`, `backgroundClip`, `backgroundSize`, `backgroundPosition`. It validates angle (with 360° wraparound, 0.1° tolerance), stop count/position/color/alpha and the paint box; a correct direction with reversed colors also fails. Stop-position tolerance is 0.001 percentage point, RGB 1/255, alpha 0.001 — not relaxed with geometric tolerance.
- The current automated convention is a single, non-repeating `linear-gradient` on the ID-bearing element with border-box origin/clip and full background size. Browser-computed RGB/RGBA, angle units/direction keywords, and percentage/px/omitted-position stops are supported. Unsupported CSS forms fail explicitly — no inference that arbitrary multi-backgrounds, pseudo-elements or other paint methods are equivalent.
- Radial, angular, diamond gradients, gradient strokes, multi-layer gradient blends and P3 gradients are exported as images as a whole; complex gradient containers with children are also merged, trading internal editability for the composed appearance. This policy is unaffected by `shapeGroupsAsImages`. Complex gradients that cannot be validated in old JSON report `gradient-unsupported` and cannot pass by skipping.

Direction uses node-local coordinates; pixel appearance after rotation/flip, background composition and interpolation still needs visual review. Image gradients check the resource and position, and do not separately reverse-engineer pixel gradient angles; `passed` still only means automated checks passed. Implementation references: [Figma official gradient matrix example](https://github.com/figma/mcp-server-guide/blob/main/skills/figma-use/references/plugin-api-patterns.md), [CSS linear gradient spec](https://drafts.csswg.org/css-images-3/#linear-gradients).

## v3.3: AUTO, text color and expanded image bounds

- **AUTO line height**: the original `unit: AUTO` is kept; `normal`, the font size, a fixed 1.2×, or the text box height are not treated as a definite line height. The node's `getCSSAsync()` explicit px value is attempted; on success it outputs `source: "figma-css"` plus `css/pixels`. When it returns normal, a percentage, a variable, or fails to read, the text is rasterized under `unresolved-auto-line-height`. An explicit value participates in line-height validation; unresolved AUTO cannot pass as ordinary text.
- **Text color**: provides `textColor.css/rgba`; use CSS `color`, not background-color. A single visible solid fill keeps fractional RGB and full alpha, paint.opacity folded exactly once, node opacity applied separately. No visible fill outputs transparent, not black by default. Gradients, multi-layer fills, mixed colors and text strokes rasterize; the collector checks both computed `color` and `-webkit-text-fill-color` to prevent the latter from overriding. RGB tolerance 1/255, alpha 0.001, independent of geometric tolerance.
- **Color space**: the document color profile is recorded; PNG explicitly exports as sRGB. Display P3 text takes the image path rather than treating unconverted channels as sRGB CSS; this does not guarantee preserving every out-of-sRGB color. Other wide-gamut fills/compositions still need visual review.
- **Image bounds**: `absoluteBounds` is still the layout box; `imageBounds` is the union of the layout box and `absoluteRenderBounds`; `imagePlacement` is the image's offset and size relative to its own layer; `relativeImageBounds` is used for browser image-position comparison. This is not simply width/height plus 2× strokeWeight — it uses the actual visual bounds Figma provides, covering OUTSIDE/CENTER strokes, shadow spread/offset, blur, italic glyph overhang and out-of-frame child shapes. [Figma layout box vs visual bounds](https://developers.figma.com/docs/plugins/api/node-properties/#absoluterenderbounds)

For example, layout box `100×50` with visual content extending 4px on each side: the outer layer stays `100×50`, the image is `108×58`, left/top are `-4px`, and the 2× PNG is `216×116`. Implementation structure:

```html
<div data-d2c-id="layer-id" style="position:absolute;width:100px;height:50px;overflow:visible">
  <img data-d2c-asset="node-layer-id" src="images/original-hash.png" alt=""
       style="position:absolute;left:-4px;top:-4px;width:108px;height:58px;object-fit:fill">
</div>
```

The layer's own opacity/strokes/shadows are already baked into the image and must not be applied again. Outer ancestor clipping and opacity must still be preserved. Validation no longer checks only the outer box — it also checks resource ownership, the image rectangle, pixel size and image opacity; squeezing an enlarged image back into the original box, missing the negative offset, or clipping the shadow at the layer container all fail. Both manual JSON/ZIP and MCP include the image-offset metadata.

When the canvas must expand, the plugin temporarily creates a transparent FRAME, inserts a node clone preserving the original absolute transform and inherited variable modes, and exports only its content; success or failure both clean up the clone/container in `finally` and never persist changes to the original node. When the original node's visual bounds are empty or invalid, re-measure the clone in an unclipped temporary container first, recover, then determine the image canvas; never use the layout box to impersonate visual bounds. `renderBounds` keeps the original API value and `imageBoundsSource: "isolated-clone"` marks the recovery source (the asset has the matching `boundsSource`). Even if the recovered bounds happen to equal the layout box, export the clone anyway to avoid reusing an original node affected by ancestor clipping. It errors explicitly only when the clone still has no reliable visual bounds, variable modes cannot be preserved, size changes after cloning, or the PNG pixel size mismatches. PNG size allows at most 1 physical pixel of rasterization rounding — not a license for arbitrary scaling. The service re-checks size before persisting.

This round only optimized code and simulated API/protocol regression tests; it did not regenerate design pages or perform real Figma image acceptance. Real Figma behavior for temporary-clone export, backdrop-related blending/background blur, nested masks and pixel appearance still require actual review; matching size does not prove matching pixels.

## v3.2: properties cannot be silently ignored

Previously `clipsContent` existed in JSON but did not participate in browser acceptance, so a missing clip could still get `passed: true`. Now export, MCP instructions and the validation report all constrain it explicitly:

| Property | New handling |
| --- | --- |
| `clipsContent` | compare both computed overflow axes; true must clip, false must be visible. Check for extra clip-path, mask, paint containment to avoid accidentally adding clipping |
| Clipping container positioning | a clipping container with children must use non-static positioning (usually `position: relative`) to keep absolutely positioned children's containing block inside the container; this is this tool's conservative implementation convention |
| `opacity` | compare the node's computed opacity within 0.005; an `opacityBaked` image's element opacity must be 1, while parent opacity is still checked separately |
| Four-corner radii | compare each corner separately, parse CSS px/% and corner-overlap scaling, cannot be replaced by a single radius; smooth radii go to visual review |
| Font size, weight, italic, letter spacing, horizontal alignment, decoration | compare real computed styles. Font size, letter spacing and radius error no more than `min(tolerance, 0.1)` px; weight and enum values cannot pass via geometric tolerance |
| Intermediate wrappers | between two ID-bearing nodes inside the selection, unlabelled wrappers must not add clipping, change opacity or add filter-like appearance effects; the outer layout hosting the selection on the page is outside this check |

`clipsContent` is exported only for node types that support it; false does not mean "delete out-of-container children". Clipping controls whether content beyond the frame boundary is shown, and does not change children's original coordinates or hierarchy. [Figma node properties](https://developers.figma.com/docs/plugins/api/node-properties/#clipscontent), [CSS overflow](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/overflow). true may use hidden/clip/auto/scroll, but scroll behavior still needs separate validation. Clipping and text styles must be on the actual element carrying `data-d2c-id`; this tool does not try to infer the equivalence of arbitrary wrappers, pseudo-elements or complex CSS.

Letter spacing also keeps its unit and adds `letterSpacing.css/pixels`: font size 20 with `PERCENT: 2` outputs `0.02em` / `0.4` — do not append `px`, and do not write CSS `2%` directly. Mixed weight, letter spacing, decoration, case, paragraph spacing and fills are additionally detected; such mixed text is rasterized as a whole under the existing fidelity policy.

This round also exports `maskType`, `cornerSmoothing`, per-edge stroke widths, caps/joins/dashes, paint/effect blendMode, shadow-through setting, layout wrap/row spacing, child absolute positioning/stretch/grow, HUG/FILL, min/max sizes, reverse stacking, whether strokes count into layout, and text auto-resize, truncation, max lines, case and paragraph/list properties. The original meaning of 0, false and null is kept — defaults are not guessed from them. Not all of these are directly acceptable as CSS numeric values, and it does not claim to cover Figma's entire API.

Each layer's `implementation` and the separate `implementation.json` split into `checks` (automated), `rules` (implementation conventions) and `review` (not yet automated):

- Fills/gradients/image crops, strokes/dashes, shadows/blur, blend modes, masks, smooth radii, rotation/flip, stacking occlusion, responsive layout, text content/wrapping/truncation/vertical alignment are all listed as review items per node and must not be silently dropped.
- A mask is not ordinary clipping. A single mask node's PNG cannot replace its effect on sibling nodes; the whole masking relationship must be implemented and reviewed.
- Rasterized nodes no longer re-require their internal radii, clipping and text styles, but still validate image reference, opacity and outer relationships. Baked asset appearance does not mean parent effects are baked too.
- A SOLID paint's `color` already folds paint.opacity — do not multiply the same fill opacity again; node opacity and fill opacity are different layers. Complex paint/effect appearance still needs review.

The validation report adds `propertyMismatches` (field, expected, actual), `collectorCompatible`, `reviewRequired` and `visualAcceptance: "not-verified"`. `passed: true` **only means automated checks passed** — it cannot claim review items, pixels or interactions passed; MCP responses list at most 30 review layers and the full list is saved at `reportPath`. Missing new-collector information fails; submitting only rectangles cannot sneak through. Old v3 JSON can be used for diagnosis, but the report notes that new properties may be incomplete.

## Layer coordinates and the acceptance flow

Every exported layer has three rectangle sets, all with `x/y/width/height/left/top/right/bottom`:

| Field | Coordinate space | Purpose |
| --- | --- | --- |
| `absoluteBounds` | design-canvas absolute coordinates | Figma prefers `absoluteBoundingBox`; Pen uses static layout or explicit `penBounds`, both keeping decimals |
| `relativeBounds` | minus each selection root's absolute origin | compared with the browser result |
| `localBounds` | minus the parent's absolute bounding-box origin | locates parent-child hierarchy errors |

`right = x + width`, `bottom = y + height` are computed in code. `rootId` and `parentId` identify layer ownership. `absoluteTransform` and `relativeTransform` are kept for rotation/transform implementation; `localBounds` is the difference of axis-aligned bounding boxes, **not** the rotated parent's local transform coordinates — do not use it to replace every transform matrix. `renderBounds` stores visual bounds separately and must not be mixed with the DOM layout box. Shadows etc. are not part of `absoluteBoundingBox`; see [Figma node properties](https://developers.figma.com/docs/plugins/api/node-properties/).

The agent should run in this order:

1. Figma mode: select the full artboard and open the plugin; Pen mode: obtain the `.pen` path and selected node IDs. After `figma_export`, stop before coding: open `previewHtmlPath`, read `previewCssPath` and `generationManifestPath`, and assess them as the first implementation candidate. Call `figma_assess_preview` with preview strengths to preserve, targeted gaps/actions and affected layer IDs, retaining the returned `previewAssessmentPath`. Never restart from a blank page or bypass the preview with a full `design.json` generation pass.
2. Copy or continue from the preview HTML/CSS structure and inspect detailed JSON/plans only for nodes identified by assessment or validation. Keep **every exported layer's** `data-d2c-id="source-layer-id"` and `data-d2c-root` on selection roots. Do not replace exported images with characters or guessed icons.
3. Load the page in a real browser and wait for fonts, images and stable layout. Execute the contents of `collector-expression.js`, or load `collect-layout.js` and call `await window.collectFigmaLayout()`, saving the return value as `actual-layout.json`.
4. Call `figma_validate_layout({ designPath: "/.../design.json", previewAssessmentPath: "/.../preview-assessment.json", actualPath: "/.../actual-layout.json", phase: "baseline", tolerance: 1 })`. Baseline fails without an accepted assessment receipt for the current design. You may also pass the `actual` object directly — exactly one of the two.
5. Per the report fix parents first, then children, modify the real page code, rerender, recollect, then validate again. By default all six boundary/size errors must be within **1 CSS px**; missing/duplicate/extra IDs, hierarchy errors, hidden implementations, image failures or unstable layout cannot pass.
6. After baseline passes, refactor into document flow per `flow-plan.json` and adjust source order, repeat structures and safe local interactions per `semantic-plan.json`; recollect and validate with `phase: "flow"` and the successful `baselineReportPath`, iterating until `workflowComplete: true`. Then perform independent visual and interaction review.

The collector is read-only and never modifies the page; it reads real `getBoundingClientRect()` and `getComputedStyle()`, subtracting the browser root node's rectangle origin, so page centering and page scrolling do not directly cause a global shift. Multiple selection roots are normalized separately; what is validated is each selection's internal layout, not how different selections are arranged across the page. **Do not use CSS zoom/global scaling to fit the acceptance viewport**, because scaled rectangles change their size.

MCP returns `passed`, `maxError`, `failed` (parent-first, at most 30 in the response), `failedCount`, `missing`, `duplicates`, `unexpected` and `reportPath`. The full report contains the measured data and each layer's expected, actual and six deltas.

v3.1 also checks explicit line height and image references:

- For non-rasterized text, read the browser computed line height and compare with PIXELS or `fontSize × PERCENT / 100`, reporting `line-height-mismatch`.
- For image nodes, check the actual `IMG` and asset filename; for ordinary image fills, check the actual CSS background reference, reporting `image-missing-or-wrong-source`. Keep the exported filename when copying assets for cross-directory verification. Current reference checking targets file URLs and does not support renaming images or converting to data URIs while still claiming the reference passes.
- The new collector must be used; it returns `collectorVersion: 5`, `sampleId`, `collectedAt`, `flowStyle`, `tagName`, `imageSources`, `assetImages`, `textStyle` and `renderStyle` (with gradient background styles). Old collectors or samples missing properties cannot pass.

Reference checking is not a browser-side content hash or pixel check: a same-name file replaced, a background image network failure, or occlusion still need separate validation — it cannot be treated as full visual acceptance.

**Boundary:** the service is responsible for export and numeric comparison; browser execution and HTML/CSS fixes are done by the agent; calling export alone does not fix the page. MCP instructions require repeated measurement until passing, but cannot force every agent to comply. Never fabricate measured values from design values, modify targets, or relax thresholds to pass. When the browser is unavailable or fixes do not converge, report not-accepted explicitly and never claim completion. Geometry passing does not mean pixels, fonts, occlusion, clipping or interactions match — those need separate checks.

## Local service configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `FIGMA_AGENT_HOST` | `127.0.0.1` | listen address, loopback only |
| `FIGMA_AGENT_PORT` | `3456` | HTTP/MCP/WebSocket port |
| `FIGMA_MCP_BRIDGE_URL` | derived from host/port | local HTTP origin used by stdio; auto-start uses it too |
| `FIGMA_MCP_START_TIMEOUT_MS` | `30000` | milliseconds to wait for the shared service to start |
| `FIGMA_AGENT_URL` | `http://localhost:3456` | shell CLI query address |
| `FIGMA_EXPORT_DIR` | `~/Downloads/figma-json-exporter` | default export parent directory, overridable by `outputDir` |
| `FIGMA_VALIDATION_DIR` | `~/Downloads/figma-json-exporter/validation` | validation report directory |

The plugin UI and manifest's development network permission are pinned to `localhost:3456`. When changing the port, update `ui.html` and `manifest.json` accordingly. The service has no account authentication and must not be exposed to the public internet via reverse proxy or port forwarding.

Reserved endpoints: `/health`, `/status`, `/export`, `/mcp`, `/ws`, `POST /control/shutdown`.

## Upgrade and migration

The old Go implementation and `mcp-entry.js` are removed. Update the MCP config to `dist/mcp-server.js`, stop the old service first, then reconnect the client and reload the Figma plugin. The entry path does not change when upgrading v2 to v3, but you must rebuild, stop the old shared service, reconnect MCP and reopen the plugin to load the new export protocol and the third tool. Old plugin JSON is rejected to avoid a successful export with missing images/coordinates. If the old service still occupies the port, the entry reports a version mismatch and will not silently connect to the old implementation.

## Verification

```bash
npm test
```

Tests cover type checking, standalone compiled-artifact runs, stdio/HTTP calls, service start and shutdown, concurrency isolation, disconnect recovery, node filtering, composite shapes, decimal coordinates, assets-persist-first, missing-image failures, and validation pass/fail paths. Plugin and DOM unit tests use mock APIs and do not replace real Figma/browser acceptance; never treat preset rectangles in tests as a pass result for a real page.

## File structure

```text
src/main.ts         entry, liveness check, background start and stdio
src/server.ts       HTTP/MCP/WebSocket local service
src/mcp.ts          MCP tool definitions
src/bridge.ts       request queueing, correlation and stdio-HTTP bridge
src/assets.ts       atomic image/JSON persistence and validation reports
src/geometry.ts     coordinate normalization, DOM collection and per-layer comparison
src/flow.ts         document-flow plan and second-stage constraints
src/semantics.ts    readable source order, repeat structures and safe-interaction inference plan
src/rendering.ts    per-layer property constraints, style comparison and visual review list
dist/mcp-server.js  compiled artifact, run directly with node
code.js             Figma sandbox export and visibility filtering
ui.html             plugin UI, download and WebSocket bridge
test/               compiled-artifact integration tests and filtering tests
```
