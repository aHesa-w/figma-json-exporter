import assert from "node:assert/strict";
import test from "node:test";
import { node, clippedNode, png, pluginFixture } from "./plugin-fixture.mjs";

test("manual and MCP exports prune invisible roots/subtrees and their images", async () => {
  for (const requestId of [undefined, "mcp-export-1"]) {
    const image = (hash) => [{ type: "IMAGE", imageHash: hash }];
    const fixture = pluginFixture([
      node("hidden-root", { visible: false, fills: image("hidden-root-image") }),
      node("zero-root", { opacity: 0 }),
      node("visible", { children: [
        node("hidden-parent", { visible: false, children: [node("hidden-image", { fills: image("hidden") })] }),
        node("zero-parent", { opacity: 0, children: [node("zero-image", { fills: image("zero") })] }),
        node("visible-image", { opacity: 0.01, fills: image("visible") }),
        node("empty-fill-container", { fills: [{ type: "SOLID", opacity: 0 }], children: [node("text", { type: "TEXT", characters: "Keep me" })] }),
      ] }),
    ]);
    const result = await fixture.request(requestId);
    assert.equal(result.type, "done");
    assert.equal(result.requestId, requestId);
    assert.equal(result.data.meta.nodeCount, 1);
    assert.equal(result.data.meta.nodeName, "visible");
    assert.deepEqual(result.data.nodes.map((n) => n.id), ["visible"]);
    assert.deepEqual(result.data.nodes[0].children.map((n) => n.id), ["visible-image", "empty-fill-container"]);
    assert.equal(result.data.nodes[0].children[1].children[0].characters, "Keep me");
    assert.deepEqual(fixture.imageReads, ["visible"]);
    assert.equal(result.imageCount, 2); // original image plus its cropped/rendered leaf
  }
});

test("direct selections respect hidden or zero-opacity ancestors outside selection", async () => {
  for (const properties of [{ visible: false }, { opacity: 0 }]) {
    const fixture = pluginFixture([node("child", { parent: node("ancestor", properties) }), node("unaffected")]);
    const result = await fixture.request("ancestor-check");
    assert.deepEqual(result.data.nodes.map((n) => n.id), ["unaffected"]);
    assert.equal(result.data.meta.nodeCount, 1);
  }
});

test("all-filtered selections return an explicit error instead of an empty success", async () => {
  const fixture = pluginFixture([node("hidden", { visible: false }), node("zero", { opacity: 0 })]);
  const result = await fixture.request("empty");
  assert.equal(result.type, "error");
  assert.match(result.message, /没有可导出的可见节点/);
  assert.equal(result.requestId, "empty");
  assert.deepEqual(fixture.imageReads, []);
});

test("an empty selection keeps the existing actionable error", async () => {
  const result = await pluginFixture([]).request();
  assert.equal(result.type, "error");
  assert.match(result.message, /请先选中/);
});

test("sync and async serializers agree and missing visibility properties are retained", async () => {
  const fixture = pluginFixture([]);
  const root = node("root", { children: [node("hide", { visible: false }), node("zero", { opacity: 0 }), { id: "minimal", type: "RECTANGLE" }] });
  const sync = fixture.context.serializeNode(root);
  const asyncResult = await fixture.context.serializeNodeAsync(root);
  assert.equal(JSON.stringify(sync), JSON.stringify(asyncResult));
  assert.deepEqual(JSON.parse(JSON.stringify(sync.children)).map((n) => n.id), ["minimal"]);
  assert.equal(fixture.context.serializeNode(node("zero", { opacity: 0 })), null);
  assert.equal(await fixture.context.serializeNodeAsync(node("hidden", { visible: false })), null);
});

test("absolute edges retain fractional precision and account for a rotated transform", async () => {
  const fixture = pluginFixture([node("root", { absoluteBoundingBox: { x: -10.25, y: 40.75, width: 100.5, height: 200.25 }, children: [
    node("rotated", { width: 10.5, height: 20.25, absoluteTransform: [[0, -1, 20], [1, 0, 60]] }),
  ] })]);
  const result = await fixture.request();
  const root = result.data.nodes[0], child = root.children[0];
  assert.equal(root.absoluteBounds.right, 90.25);
  assert.equal(root.absoluteBounds.bottom, 241);
  assert.deepEqual(child.absoluteBounds, { x: -0.25, y: 60, width: 20.25, height: 10.5, left: -0.25, top: 60, right: 20, bottom: 70.5 });
  assert.equal(child.relativeBounds.left, 10);
  assert.equal(child.relativeBounds.top, 19.25);
  assert.equal(child.parentId, "root");
});

test("pure shape groups and boolean operations become atomic image layers", async () => {
  let rasterCalls = 0;
  const group = node("icon", { type: "GROUP", children: [node("shape", { type: "RECTANGLE" }), node("hidden-shape", { type: "VECTOR", visible: false })] });
  const original = group.exportAsync.bind(group);
  group.exportAsync = async (options) => { rasterCalls++; assert.equal(options.useAbsoluteBounds, true); return original(); };
  const fixture = pluginFixture([node("root", { children: [group, node("boolean", { type: "BOOLEAN_OPERATION" }), node("label-group", { type: "GROUP", children: [node("label", { type: "TEXT", characters: "Keep text" })] })] })]);
  const result = await fixture.request("shapes");
  assert.equal(result.type, "done");
  const [icon, boolean, label] = result.data.nodes[0].children;
  assert.equal(icon.renderAs, "image");
  assert.equal(icon.children, undefined);
  assert.deepEqual(icon.collapsedNodeIds, ["shape"]);
  assert.equal(boolean.renderAs, "image");
  assert.equal(label.renderAs, undefined);
  assert.equal(label.children[0].characters, "Keep text");
  assert.equal(rasterCalls, 0);
  assert.equal(fixture.frames.length, 2);
  assert.ok(fixture.frames.every(frame => frame.removed && frame.children[0].removed));
  assert.equal(result.imageCount, 2);
  assert.equal(result.data.assets[icon.assetId].kind, "shape");
});

test("shape collapsing can be disabled and selected descendants are not duplicated", async () => {
  const child = node("vector", { type: "VECTOR" });
  const root = node("root", { children: [child] });
  child.parent = root;
  const result = await pluginFixture([root, child]).request("raw", { shapeGroupsAsImages: false });
  assert.equal(result.data.nodes.length, 1);
  assert.equal(result.data.nodes[0].children[0].renderAs, undefined);
  assert.equal(result.imageCount, 0);
});

test("raster failures degrade the layer to a DOM subtree, record a warning and still succeed", async () => {
  const fixture = pluginFixture([node("bad", { type: "VECTOR" })], { frameExport() { throw new Error("raster unavailable"); } });
  const result = await fixture.request();
  assert.equal(result.type, "done", result.message);
  assert.equal(result.data.nodes[0].renderAs, undefined);
  assert.equal(result.data.nodes[0].assetId, undefined);
  assert.equal(result.data.nodes[0].collapsedNodeIds, undefined);
  assert.equal(result.data.meta.rasterWarnings.length, 1);
  assert.equal(result.data.meta.rasterWarnings[0].id, "bad");
  assert.equal(result.data.meta.rasterWarnings[0].action, "degraded-to-dom");
  assert.match(result.data.meta.rasterWarnings[0].message, /raster unavailable/);
  assert.equal(fixture.frames[0].removed, true);
  assert.equal(fixture.frames[0].children[0].removed, true);
});

test("line-height retains percent/pixel/AUTO units and emits ready-to-use CSS", async () => {
  const inputs = [{ unit: "PERCENT", value: 100 }, { unit: "PERCENT", value: 125.5 }, { unit: "PIXELS", value: 100 }, { unit: "AUTO" }];
  const result = await pluginFixture(inputs.map((lineHeight, i) => node(String(i), { type: "TEXT", fontSize: 32, lineHeight }))).request();
  assert.deepEqual(result.data.nodes.map(n => n.lineHeight.css), ["100%", "125.5%", "100px", null]);
  assert.deepEqual(result.data.nodes.map(n => n.lineHeight.pixels), [32, 40.16, 100, null]);
  assert.equal(result.imageCount, 1);
  assert.equal(result.data.nodes[3].rasterReason, "unresolved-auto-line-height");
});

test("whitelisted families stay selectable text through missing fonts; others rasterize", async () => {
  const result = await pluginFixture([
    node("system", { type: "TEXT", fontName: { family: " PingFang SC ", style: "Regular" } }),
    node("baidu", { type: "TEXT", characters: "保留原文", fontName: { family: "Baidu Number Plus ", style: "Regular" } }),
    node("baidu-missing", { type: "TEXT", hasMissingFont: true, fontName: { family: "baidu number", style: "Medium" } }),
    node("pingfang-missing", { type: "TEXT", hasMissingFont: true, fontName: { family: "PingFang HK", style: "Medium" } }),
    ...["Douyin Sans", "MF YuanHei(Noncommercial)", "Unknown Future Font"].map(family => node(family, { type: "TEXT", characters: "保留原文", fontName: { family, style: "Regular" } })),
    node("missing-unknown", { type: "TEXT", hasMissingFont: true, fontName: { family: "Mystery Sans", style: "Regular" } }),
    node("mixed", { type: "TEXT", characters: "ab", fontName: "Symbol(mixed)", getRangeAllFontNames() { return [{ family: "Arial", style: "Regular" }, { family: "Unknown", style: "Regular" }]; } }),
  ]).request();
  assert.equal(result.type, "done");
  for (const n of result.data.nodes.slice(0, 4)) assert.equal(n.renderAs, undefined);
  assert.equal(result.data.nodes[1].characters, "保留原文");
  for (const n of result.data.nodes.slice(4)) {
    assert.equal(n.renderAs, "image");
    assert.equal(result.data.assets[n.assetId].kind, "text");
  }
  assert.equal(result.data.nodes[7].rasterReason, "missing-font");
  assert.equal(result.data.nodes[8].rasterReason, "non-system-font");
});

test("image paint leaves export both original bytes and rendered crop; containers retain children", async () => {
  const paint = { type: "IMAGE", imageHash: "photo", scaleMode: "CROP", imageTransform: [[2, 0, -.1], [0, 2, -.2]], filters: { exposure: .5 } };
  const result = await pluginFixture([
    node("leaf", { fills: [paint] }),
    node("container", { fills: [paint], children: [node("text", { type: "TEXT" })] }),
    node("hidden-paint", { fills: [{ ...paint, visible: false }] }),
  ]).request("images", { shapeGroupsAsImages: false });
  assert.equal(result.type, "done");
  const [leaf, container, hidden] = result.data.nodes;
  assert.equal(leaf.renderAs, "image");
  assert.deepEqual(leaf.fills[0].imageTransform, paint.imageTransform);
  assert.deepEqual(leaf.fills[0].filters, paint.filters);
  assert.equal(result.data.assets[leaf.assetId].kind, "image-render");
  assert.equal(result.data.assets.photo.kind, "image-fill");
  assert.equal(container.renderAs, undefined);
  assert.equal(container.children.length, 1);
  assert.equal(hidden.renderAs, undefined);
});

test("rendering properties retain clipping, zero/false values, strokes, masks and layout semantics", async () => {
  const paint = { type: "SOLID", color: { r: 1, g: 0, b: 0 }, blendMode: "MULTIPLY" };
  const properties = { clipsContent: true, maskType: "ALPHA", cornerSmoothing: 0, strokeTopWeight: 1, strokeRightWeight: 2, strokeBottomWeight: 3, strokeLeftWeight: 4, strokeCap: "ROUND", strokeJoin: "BEVEL", strokeMiterLimit: 4, dashPattern: [4, 2], layoutAlign: "STRETCH", layoutGrow: 0, layoutPositioning: "ABSOLUTE", layoutSizingHorizontal: "FILL", layoutSizingVertical: "HUG", minWidth: 0, maxWidth: null, minHeight: 10, maxHeight: 100, overflowDirection: "NONE", itemReverseZIndex: false, strokesIncludedInLayout: true };
  const result = await pluginFixture([node("root", { ...properties, strokes: [paint], effects: [{ type: "DROP_SHADOW", radius: 4, blendMode: "MULTIPLY", showShadowBehindNode: false }], layoutMode: "HORIZONTAL", layoutWrap: "WRAP", counterAxisSpacing: 12, counterAxisAlignContent: "SPACE_BETWEEN", children: [node("outside", { x: 150, clipsContent: false })] })]).request();
  const root = result.data.nodes[0];
  for (const [key, value] of Object.entries(properties)) assert.deepEqual(root[key], value, key);
  assert.equal(root.strokes[0].blendMode, "MULTIPLY");
  assert.equal(root.effects[0].showShadowBehindNode, false);
  assert.equal(root.effects[0].blendMode, "MULTIPLY");
  assert.equal(root.autoLayout.layoutWrap, "WRAP");
  assert.equal(root.autoLayout.counterAxisSpacing, 12);
  assert.equal(root.autoLayout.counterAxisAlignContent, "SPACE_BETWEEN");
  assert.equal(root.children[0].x, 150); // Clipping does not delete off-frame children.
  assert.equal(root.children[0].clipsContent, false);
});

test("letter spacing has unit-safe CSS and extended mixed text is rasterized", async () => {
  const text = node("text", { type: "TEXT", fontSize: 20, letterSpacing: { unit: "PERCENT", value: 2 }, textAutoResize: "HEIGHT", textTruncation: "ENDING", maxLines: 2, textCase: "UPPER", paragraphSpacing: 10, paragraphIndent: 0 });
  const result = await pluginFixture([text, ...["fontWeight", "letterSpacing", "textDecoration", "textCase", "paragraphSpacing", "fills"].map(prop => node(prop, { type: "TEXT", [prop]: "Symbol(mixed)" }))]).request();
  const [first, ...mixed] = result.data.nodes;
  assert.deepEqual(first.letterSpacing, { unit: "PERCENT", value: 2, css: "0.02em", pixels: 0.4 });
  for (const prop of ["textAutoResize", "textTruncation", "maxLines", "textCase", "paragraphSpacing", "paragraphIndent"]) assert.equal(first[prop], text[prop]);
  assert.equal(first.renderAs, undefined);
  for (const n of mixed) assert.equal(n.rasterReason, "mixed-text-style");
});

test("AUTO uses only explicit Figma CSS pixels; unavailable or ambiguous metrics rasterize", async () => {
  const values = ["24.5px", "normal", "120%", "1.2", "var(--leading)", "", "0px"];
  const result = await pluginFixture(values.map((value, i) => node(String(i), { type: "TEXT", height: 300, lineHeight: { unit: "AUTO" }, async getCSSAsync() { return { "line-height": value }; } }))).request();
  assert.equal(result.type, "done");
  const [resolved, ...unresolved] = result.data.nodes;
  assert.equal(resolved.lineHeight.unit, "AUTO");
  assert.equal(resolved.lineHeight.value, null);
  assert.equal(resolved.lineHeight.pixels, 24.5);
  assert.equal(resolved.lineHeight.source, "figma-css");
  assert.equal(resolved.renderAs, undefined);
  for (const n of unresolved) { assert.equal(n.rasterReason, "unresolved-auto-line-height"); assert.equal(n.lineHeight.css, null); }
});

test("text color preserves fractional RGB and small alpha once, with complex paints rasterized", async () => {
  const solid = { type: "SOLID", color: { r: 0.1234, g: 0.2, b: 0.3, a: 0.5 }, opacity: 0.008 };
  const result = await pluginFixture([
    node("color", { type: "TEXT", opacity: 0.5, fills: [solid, { ...solid, visible: false }] }),
    node("none", { type: "TEXT", fills: [] }),
    node("multi", { type: "TEXT", fills: [solid, solid] }),
    node("gradient", { type: "TEXT", fills: [{ type: "GRADIENT_LINEAR", gradientStops: [] }] }),
  ]).request();
  const [color, none, multi, gradient] = result.data.nodes;
  assert.equal(color.textColor.css, "rgba(31.467,51,76.5,0.004)");
  assert.equal(color.textColor.rgba.a, 0.004);
  assert.equal(color.fills[0].opacityIncludedInColor, true);
  assert.equal(none.textColor.rgba.a, 0);
  assert.equal(multi.rasterReason, "complex-text-paint");
  assert.equal(gradient.rasterReason, "complex-text-paint");
  const wide = await pluginFixture([node("wide", { type: "TEXT" })], { documentColorProfile: "DISPLAY_P3" }).request();
  assert.equal(wide.data.nodes[0].rasterReason, "wide-gamut-text");
  assert.equal(wide.data.assets[wide.data.nodes[0].assetId].colorProfile, "SRGB");
});

test("outside/center strokes, shadows, blur and glyph overhang use an expanded isolated canvas", async () => {
  for (const properties of [
    { type: "VECTOR", strokeAlign: "OUTSIDE", strokeWeight: 4 },
    { type: "VECTOR", strokeAlign: "CENTER", strokeWeight: 8 },
    { type: "VECTOR", effects: [{ type: "DROP_SHADOW", radius: 8 }] },
    { type: "VECTOR", effects: [{ type: "LAYER_BLUR", radius: 8 }] },
    { type: "TEXT", fontName: { family: "Custom", style: "Italic" } },
    { type: "TEXT", strokeAlign: "OUTSIDE", strokes: [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }] },
  ]) {
    const source = node("outset", { ...properties, x: 10.25, y: 20.5, width: 100, height: 50, absoluteRenderBounds: { x: 6.25, y: 16.5, width: 112, height: 62 } });
    const fixture = pluginFixture([source]);
    const result = await fixture.request();
    assert.equal(result.type, "done", result.message);
    const exported = result.data.nodes[0], canvas = fixture.frames[0];
    assert.equal(exported.absoluteBounds.width, 100);
    assert.equal(exported.imageBounds.width, 112);
    assert.equal(exported.imageBounds.x, 6.25);
    assert.equal(canvas.width, 112);
    assert.equal(canvas.height, 62);
    assert.deepEqual(Array.from(canvas.children[0].relativeTransform[0]), [1, 0, 4]);
    assert.deepEqual(Array.from(canvas.children[0].relativeTransform[1]), [0, 1, 4]);
    assert.equal(canvas.settings.colorProfile, "SRGB");
    assert.equal(canvas.removed, true);
    assert.equal(canvas.children[0].removed, true);
    assert.equal(source.width, 100);
    assert.equal(source.x, 10.25);
  }
});

test("partially clipped render bounds are remeasured before exporting outside strokes", async () => {
  const source = clippedNode("partial-outside", {
    type: "RECTANGLE", x: 40, y: 60, width: 80, height: 80,
    fills: [{ type: "IMAGE", imageHash: "photo", visible: true }],
    strokes: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, visible: true }],
    strokeAlign: "OUTSIDE", strokeWeight: 3,
  }, { x: 37, y: 57, width: 86, height: 86 });
  // Figma may expose only the portion surviving an ancestor clip. Unioning
  // this with layout still misses the bottom outside stroke.
  source.absoluteRenderBounds = { x: 37, y: 57, width: 86, height: 43 };
  const fixture = pluginFixture([source]);
  const result = await fixture.request();
  assert.equal(result.type, "done", result.message);
  const exported = result.data.nodes[0];
  assert.equal(exported.renderBounds.height, 43);
  assert.deepEqual(exported.imagePlacement, { x: -3, y: -3, width: 86, height: 86, left: -3, top: -3, right: 83, bottom: 83 });
  assert.equal(exported.imageBoundsSource, "isolated-clone");
  assert.equal(result.data.assets[exported.assetId].pixelHeight, 172);

  const child = node("outside-child", { type: "VECTOR", strokes: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }], strokeAlign: "OUTSIDE", strokeWeight: 3 });
  const group = clippedNode("partial-group", { type: "GROUP", width: 150, height: 80, children: [child] }, { x: -3, y: -3, width: 156, height: 86 });
  group.absoluteRenderBounds = { x: -3, y: -3, width: 156, height: 43 };
  const grouped = pluginFixture([group]);
  const groupedResult = await grouped.request();
  assert.equal(groupedResult.type, "done", groupedResult.message);
  assert.equal(groupedResult.data.nodes[0].rasterReason, "composite-shape");
  assert.equal(groupedResult.data.nodes[0].imageBounds.height, 86);
  assert.equal(groupedResult.data.nodes[0].imageBoundsSource, "isolated-clone");
});

test("gradient masks remain composable nodes instead of standalone rasters", async () => {
  const mask = node("gradient-mask", {
    type: "VECTOR", isMask: true, maskType: "ALPHA",
    fills: [{ type: "GRADIENT_LINEAR", visible: true, gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops: [
      { position: 0, color: { r: 1, g: 1, b: 1, a: 0 } },
      { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } },
    ] }],
    absoluteRenderBounds: null,
  });
  const fixture = pluginFixture([mask], { documentColorProfile: "DISPLAY_P3" });
  const result = await fixture.request();
  assert.equal(result.type, "done", result.message);
  assert.equal(result.data.nodes[0].renderAs, undefined);
  assert.equal(result.data.nodes[0].isMask, true);
  assert.equal(result.data.nodes[0].fills[0].type, "GRADIENT_LINEAR");
  assert.equal(fixture.frames.length, 0);
});

test("expanded export failures and unrecoverable visual bounds degrade to DOM and clean up temporary nodes", async () => {
  const source = node("bad", { type: "VECTOR", absoluteRenderBounds: { x: -4, y: -4, width: 108, height: 108 } });
  const fixture = pluginFixture([source], { frameExport() { throw new Error("export failed"); } });
  const result = await fixture.request();
  assert.equal(result.type, "done", result.message);
  assert.equal(result.data.nodes[0].renderAs, undefined);
  assert.match(result.data.meta.rasterWarnings[0].message, /export failed/);
  assert.equal(fixture.frames[0].removed, true);
  assert.equal(fixture.frames[0].children[0].removed, true);
  const recovery = pluginFixture([node("missing", { type: "VECTOR", absoluteRenderBounds: null })]);
  const missing = await recovery.request();
  assert.equal(missing.type, "done", missing.message);
  assert.match(missing.data.meta.rasterWarnings[0].message, /Cannot recover absoluteRenderBounds.*missing.*unclipped clone/);
  assert.equal(missing.data.nodes[0].renderAs, undefined);
  assert.equal(recovery.frames[0].removed, true);
  assert.equal(recovery.frames[0].children[0].removed, true);
});

test("clipped instance children recover paint bounds without losing layout, alpha or theme modes", async () => {
  for (const requestId of [undefined, "mcp-recover-bounds"]) {
    const source = clippedNode("I35:1424;2452:9685", { type: "TEXT", fontName: { family: "Custom", style: "Italic" }, x: 150.25, y: 250.5, width: 100, height: 50, opacity: 0.6, resolvedVariableModes: { colors: "dark" } }, (clone) => {
      assert.equal(clone.parent.clipsContent, false);
      assert.equal(clone.parent.modes.colors, "dark");
      assert.equal(clone.opacity, 0.6);
      assert.equal(clone.relativeTransform[0][2] + clone.parent.x, 150.25);
      assert.equal(clone.relativeTransform[1][2] + clone.parent.y, 250.5);
      return { x: 146.25, y: 244.5, width: 112, height: 66 };
    });
    const root = node("clipping-root", { x: 10, y: 20, clipsContent: true, children: [source] });
    source.parent = root;
    const fixture = pluginFixture([root]);
    const result = await fixture.request(requestId);
    assert.equal(result.type, "done", result.message);
    const exported = result.data.nodes[0].children[0], asset = result.data.assets[exported.assetId];
    assert.equal(exported.renderBounds, null); // Retain the original API result.
    assert.equal(exported.imageBoundsSource, "isolated-clone");
    assert.equal(asset.boundsSource, "isolated-clone");
    assert.equal(exported.absoluteBounds.x, 150.25);
    assert.equal(exported.relativeBounds.x, 140.25);
    assert.equal(exported.imagePlacement.x, -4);
    assert.equal(exported.imagePlacement.y, -6);
    assert.equal(exported.relativeImageBounds.x, 136.25);
    assert.equal(exported.relativeImageBounds.y, 224.5);
    assert.equal(asset.pixelWidth, 224);
    assert.equal(asset.pixelHeight, 132);
    assert.equal(result.data.nodes[0].clipsContent, true);
    const frame = fixture.frames[0];
    assert.equal(frame.x + frame.children[0].relativeTransform[0][2], 150.25);
    assert.equal(frame.y + frame.children[0].relativeTransform[1][2], 250.5);
    assert.equal(frame.clipsContent, true);
    assert.equal(frame.removed, true);
    assert.equal(frame.children[0].removed, true);
    assert.equal(source.parent, root);
    assert.equal(source.absoluteRenderBounds, null);
  }
});

test("recovered bounds equal to layout still export the unclipped clone", async () => {
  const fixture = pluginFixture([clippedNode("clipped-vector", { type: "VECTOR" }, { x: 0, y: 0, width: 100, height: 100 })]);
  const result = await fixture.request();
  assert.equal(result.type, "done", result.message);
  assert.equal(result.data.nodes[0].imagePlacement.x, 0);
  assert.equal(fixture.frames.length, 1);
  assert.equal(fixture.frames[0].removed, true);
});

test("recovery preserves rotated zero-height shapes and rejects clipped PNG dimensions", async () => {
  const source = clippedNode("rotated-line", { type: "VECTOR", width: 100, height: 0, absoluteTransform: [[0, -1, 20], [1, 0, 30]] }, { x: 18, y: 28, width: 4, height: 104 });
  const fixture = pluginFixture([source]);
  const result = await fixture.request();
  assert.equal(result.type, "done", result.message);
  assert.equal(result.data.nodes[0].absoluteBounds.width, 0);
  assert.equal(result.data.nodes[0].imageBounds.width, 4);
  assert.deepEqual(Array.from(fixture.frames[0].children[0].relativeTransform[0]), [0, -1, 2]);
  assert.deepEqual(Array.from(fixture.frames[0].children[0].relativeTransform[1]), [1, 0, 2]);
  const bad = pluginFixture([source], { frameExport: () => new Uint8Array(png(1, 1)) });
  const failed = await bad.request();
  assert.equal(failed.type, "done", failed.message);
  assert.match(failed.data.meta.rasterWarnings[0].message, /Raster pixel size/);
  assert.equal(failed.data.nodes[0].renderAs, undefined);
  assert.equal(bad.frames[0].removed, true);
  assert.equal(bad.frames[0].children[0].removed, true);
});

test("invalid or throwing recovered bounds degrade to DOM without dropping the layer", async () => {
  for (const visual of [null, { x: NaN, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: -1, height: 100 }, () => { throw new Error("API unavailable"); }]) {
    const fixture = pluginFixture([clippedNode("unrecoverable", { type: "VECTOR" }, visual)]);
    const result = await fixture.request();
    assert.equal(result.type, "done", result.message);
    assert.equal(result.data.nodes[0].renderAs, undefined);
    assert.equal(result.data.meta.rasterWarnings.length, 1);
    assert.equal(result.data.meta.rasterWarnings[0].id, "unrecoverable");
    assert.equal(fixture.frames[0].removed, true);
    assert.equal(fixture.frames[0].children[0].removed, true);
  }
});

test("expanded raster keeps inherited variable modes and degrades when color context is unresolvable", async () => {
  const source = node("theme", { type: "VECTOR", resolvedVariableModes: { colors: "dark" }, absoluteRenderBounds: { x: -4, y: -4, width: 108, height: 108 } });
  const fixture = pluginFixture([source]);
  assert.equal((await fixture.request()).type, "done");
  assert.equal(fixture.frames[0].modes.colors, "dark");
  const failed = pluginFixture([source], { missingVariableCollection: true });
  const result = await failed.request();
  assert.equal(result.type, "done", result.message);
  assert.equal(result.data.meta.rasterWarnings.length, 1);
  assert.match(result.data.meta.rasterWarnings[0].message, /Cannot preserve variable mode/);
  assert.equal(result.data.nodes[0].renderAs, undefined);
  assert.equal(failed.frames[0].removed, true);
});
