import assert from "node:assert/strict";
import test from "node:test";
import { node, pluginFixture } from "./plugin-fixture.mjs";

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
    assert.equal(result.imageCount, 1);
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
  const original = group.exportAsync;
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
  assert.equal(rasterCalls, 1);
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

test("raster failures do not silently return an incomplete successful export", async () => {
  const result = await pluginFixture([node("bad", { type: "VECTOR", async exportAsync() { throw new Error("raster unavailable"); } })]).request();
  assert.equal(result.type, "error");
  assert.match(result.message, /raster unavailable/);
});
