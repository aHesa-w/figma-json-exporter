import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

async function loadTS(file) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(file, import.meta.url))], bundle: true, platform: "node", format: "esm", write: false });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const { generatePreview } = await loadTS("../src/preview.ts");
const box = (x, y, width, height) => ({ x, y, width, height });
const text = (id, name, x, y, value) => ({ id, name, type: "TEXT", absoluteBounds: box(x, y, 180, 20), characters: value, fontName: { family: "Arial", style: "Regular" }, fontSize: 16, fontWeight: 400, lineHeight: { css: "20px" }, letterSpacing: { css: "0px" }, textAlignHorizontal: "LEFT", textColor: { css: "rgb(17, 17, 17)" }, fills: [{ type: "SOLID", color: "rgb(17, 17, 17)" }] });
const row = (index, y) => ({ id: `row-${index}`, name: `Row ${index}`, type: "FRAME", absoluteBounds: box(20, y, 260, 40), children: [text(`label-${index}`, `Label ${index}`, 30, y + 10, `Item ${index}`)] });
const design = {
  meta: { schemaVersion: 3, exporterVersion: "3.5.0" }, assets: {},
  nodes: [{ id: "root", name: "Preview", type: "FRAME", absoluteBounds: box(0, 0, 300, 300), children: [
    { id: "background", name: "Background", type: "RECTANGLE", absoluteBounds: box(0, 0, 300, 300), fills: [{ type: "SOLID", color: "rgb(255, 255, 255)" }] },
    { id: "list", name: "List", type: "FRAME", absoluteBounds: box(20, 50, 260, 160), children: [row(1, 50), row(2, 90), row(3, 130)] },
    { id: "rotated", name: "Decoration", type: "RECTANGLE", rotation: 12, absoluteBounds: box(270, 270, 20, 20), fills: [{ type: "SOLID", color: "rgb(255, 0, 0)" }] },
  ] }],
};

test("model-free preview preserves the complete tree and emits background, flow and repeat decisions", () => {
  const preview = generatePreview(design);
  assert.equal((preview.html.match(/data-d2c-id=/g) ?? []).length, 10);
  assert.match(preview.html, /data-d2c-root="true"/);
  assert.match(preview.html, /data-d2c-role="background"/);
  assert.equal(preview.html.includes("role=\"tab\""), false);
  assert.equal(preview.manifest.containers.find(item => item.id === "root").primitive, "layered-flow");
  assert.equal(preview.manifest.containers.find(item => item.id === "root").contentFlow, "block-flow");
  assert.deepEqual(preview.manifest.containers.find(item => item.id === "root").backgroundIds, ["background"]);
  assert.equal(preview.manifest.containers.find(item => item.id === "list").primitive, "block-flow");
  assert.equal(preview.manifest.placements.find(item => item.id === "list").alignment, "center");
  assert.deepEqual(preview.manifest.repeatGroups[0].instanceIds, ["row-1", "row-2", "row-3"]);
  assert.match(preview.html, /data-d2c-repeat="Row"/);
  assert.equal(/display:(?:inline-)?grid/.test(preview.css), false);
  assert.match(preview.css, /display:flow-root; position:relative/);
  const backgroundRule = preview.css.match(/\.d2c-n-2 \{([^}]+)\}/)?.[1] ?? "";
  assert.match(backgroundRule, /position:absolute/);
  const contentRule = preview.css.match(/\.d2c-n-3 \{([^}]+)\}/)?.[1] ?? "";
  assert.equal(contentRule.includes("position:absolute"), false);
  assert.equal(preview.html.includes("style="), false);
  assert.equal(preview.manifest.reviewRequired.find(item => item.id === "rotated").reason, "rotated layer uses a CSS rotate fallback");
  assert.ok(preview.manifest.reviewRequired.some(item => item.id === "root" && item.reason.includes("no-Grid layered-flow")));
});

test("layered preview keeps sectional backdrops out of flow and orders horizontal content visually", () => {
  const preview = generatePreview({
    meta: { schemaVersion: 3, exporterVersion: "3.5.0" }, assets: {},
    nodes: [{ id: "page", name: "Page", type: "FRAME", absoluteBounds: box(0, 0, 300, 500), children: [
      { id: "hero-bg", name: "Hero background", type: "RECTANGLE", absoluteBounds: box(0, 0, 300, 180), fills: [{ type: "SOLID", color: "white" }] },
      { id: "header", name: "Header", type: "FRAME", absoluteBounds: box(0, 0, 300, 60), children: [text("title", "Title", 16, 20, "Title")] },
      { id: "tabs", name: "Tabs", type: "FRAME", absoluteBounds: box(0, 180, 300, 40), children: [
        { id: "tabs-bg", name: "Tabs background", type: "RECTANGLE", absoluteBounds: box(0, 180, 300, 40), fills: [{ type: "SOLID", color: "white" }] },
        { ...text("tab-c", "Tab C", 220, 190, "C"), absoluteBounds: box(220, 190, 40, 20) },
        { ...text("tab-b", "Tab B", 120, 190, "B"), absoluteBounds: box(120, 190, 40, 20) },
        { ...text("tab-a", "Tab A", 20, 190, "A"), absoluteBounds: box(20, 190, 40, 20) },
      ] },
      { id: "content", name: "Content", type: "FRAME", absoluteBounds: box(0, 230, 300, 270), children: [text("body", "Body", 16, 240, "Body")] },
      { id: "footer", name: "Bottom navigation", type: "FRAME", absoluteBounds: box(0, 450, 300, 50), fills: [{ type: "SOLID", color: "white" }], children: [text("footer-label", "Home", 20, 465, "Home")] },
    ] }],
  });
  const page = preview.manifest.containers.find(item => item.id === "page");
  const tabs = preview.manifest.containers.find(item => item.id === "tabs");
  assert.deepEqual(page.backgroundIds, ["hero-bg"]);
  assert.deepEqual(page.overlayIds, ["footer"]);
  assert.equal(page.contentFlow, "block-flow");
  assert.equal(tabs.contentFlow, "inline-flow");
  assert.deepEqual(tabs.childOrder, ["tabs-bg", "tab-a", "tab-b", "tab-c"]);
  assert.match(preview.css.match(/\.d2c-n-2 \{([^}]+)\}/)?.[1] ?? "", /position:absolute/);
  assert.match(preview.css.match(/\.d2c-n-5 \{([^}]+)\}/)?.[1] ?? "", /margin-top:120px/);
  assert.match(preview.css.match(/\.d2c-n-12 \{([^}]+)\}/)?.[1] ?? "", /position:absolute/);
  assert.match(preview.css, /display:block; font-size:0;white-space:nowrap;position:relative/);
  assert.equal(/display:(?:inline-)?grid/.test(preview.css), false);
});

test("atomic raster assets do not repaint vector fills or strokes on their rectangular wrappers", () => {
  const atomic = generatePreview({
    meta: { schemaVersion: 3, exporterVersion: "3.5.0" },
    assets: { icon: { id: "icon", relativePath: "images/icon.png" } },
    nodes: [{ id: "atomic-root", name: "Atomic", type: "FRAME", absoluteBounds: box(0, 0, 40, 40), children: [{
      id: "atomic-icon", name: "Vector icon", type: "VECTOR", renderAs: "image", assetId: "icon", rotation: 90, opacity: 0.5,
      absoluteBounds: box(10, 10, 20, 20), imagePlacement: box(0, 0, 20, 20),
      fills: [{ type: "SOLID", color: "rgb(0, 0, 0)" }], strokes: [{ type: "SOLID", color: "rgb(255, 255, 255)" }], strokeWeight: 2,
    }] }],
  });
  const wrapperRule = atomic.css.match(/\.d2c-n-2 \{([^}]+)\}/)?.[1] ?? "";
  assert.match(atomic.html, /<img class="d2c-asset"[^>]+src="\.\.\/images\/icon\.png">/);
  assert.equal(wrapperRule.includes("background"), false);
  assert.equal(wrapperRule.includes("outline"), false);
  assert.equal(wrapperRule.includes("rotate"), false);
  assert.equal(wrapperRule.includes("opacity"), false);
  assert.equal(atomic.manifest.reviewRequired.some(item => item.id === "atomic-icon"), false);
});

test("layered charts position atomic paint paths and textual callouts without consuming flow", () => {
  const preview = generatePreview({
    meta: { schemaVersion: 3, exporterVersion: "3.5.0" }, assets: { path: { id: "path", relativePath: "images/path.png" } },
    nodes: [{ id: "chart", name: "Chart", type: "FRAME", absoluteBounds: box(0, 0, 300, 160), children: [
      { id: "plot", name: "Plot", type: "FRAME", absoluteBounds: box(0, 0, 300, 160), children: [] },
      { id: "path", name: "Path", type: "VECTOR", renderAs: "image", assetId: "path", absoluteBounds: box(0, 40, 300, 80) },
      { id: "tooltip", name: "Tooltip", type: "FRAME", absoluteBounds: box(120, 30, 90, 80), children: [text("tooltip-label", "Value", 130, 40, "Value")] },
    ] }],
  });
  const chart = preview.manifest.containers.find(item => item.id === "chart");
  assert.deepEqual(chart.overlayIds, ["tooltip"]);
  assert.equal(preview.manifest.placements.find(item => item.id === "path").role, "decoration");
  assert.equal(preview.manifest.placements.find(item => item.id === "tooltip").role, "overlay");
  assert.match(preview.css.match(/\.d2c-n-3 \{([^}]+)\}/)?.[1] ?? "", /position:absolute/);
  assert.match(preview.css.match(/\.d2c-n-4 \{([^}]+)\}/)?.[1] ?? "", /position:absolute/);
});

test("multi-row content groups into stacked inline rows instead of one wrapping flex line", () => {
  const card = (id, x, y) => ({ id, name: id, type: "FRAME", absoluteBounds: box(x, y, 60, 40), children: [text(`${id}-label`, id, x + 8, y + 10, id)] });
  const preview = generatePreview({
    meta: { schemaVersion: 3, exporterVersion: "3.5.0" }, assets: {},
    nodes: [{ id: "grid", name: "Grid", type: "FRAME", absoluteBounds: box(0, 0, 200, 160), children: [
      card("a", 0, 0), card("b", 80, 0), card("c", 0, 60), card("d", 80, 60),
    ] }],
  });
  const container = preview.manifest.containers.find(item => item.id === "grid");
  assert.equal(container.contentFlow, "flex-row");
  assert.deepEqual(container.contentRows, [["a", "b"], ["c", "d"]]);
  assert.equal(/display:(?:inline-)?grid/.test(preview.css), false);
  assert.equal((preview.html.match(/class="d2c-row /g) ?? []).length, 2);
  // Rows stack with a vertical gap derived from row bottoms (60 - 40 = 20px).
  assert.match(preview.css, /\.d2c-row-1 \{ display:block; font-size:0; white-space:nowrap; margin-top:0px; \}/);
  assert.match(preview.css, /\.d2c-row-2 \{ display:block; font-size:0; white-space:nowrap; margin-top:20px; \}/);
  // The first item of row 2 is positioned by its row, not an absolute y margin.
  const rowTwoFirst = preview.css.match(/\.d2c-n-6 \{([^}]+)\}/)?.[1] ?? "";
  assert.equal(rowTwoFirst.includes("margin-top:60px"), false);
  assert.match(rowTwoFirst, /margin-top:0px/);
});

test("row grouping uses vertical midlines, not top edges", () => {
  const preview = generatePreview({
    meta: { schemaVersion: 3, exporterVersion: "3.5.0" }, assets: {},
    nodes: [{ id: "row", name: "Row", type: "FRAME", absoluteBounds: box(0, 0, 200, 80), children: [
      { id: "tall", name: "Tall", type: "FRAME", absoluteBounds: box(0, 0, 60, 60), children: [text("tall-label", "Tall", 8, 20, "Tall")] },
      { id: "short", name: "Short", type: "FRAME", absoluteBounds: box(80, 20, 60, 20), children: [text("short-label", "Short", 88, 22, "Short")] },
    ] }],
  });
  const container = preview.manifest.containers.find(item => item.id === "row");
  assert.equal(container.contentFlow, "inline-flow");
  assert.deepEqual(container.contentRows, [["tall", "short"]]);
  assert.equal((preview.html.match(/class="d2c-row /g) ?? []).length, 0);
});

test("rasterized text is an absolute atomic paint layer, not flow content", () => {
  // A gradient title that Figma rasterized (renderAs=image) still carries its
  // characters. It must be treated as a decoration at its exported coordinates,
  // otherwise it gets pulled into block flow and covered by the button background.
  const preview = generatePreview({
    meta: { schemaVersion: 3, exporterVersion: "3.5.0" }, assets: {},
    nodes: [{ id: "btn", name: "btn", type: "GROUP", absoluteBounds: box(0, 0, 200, 220), children: [
      { id: "bg", name: "Rounded rectangle", type: "RECTANGLE", absoluteBounds: box(0, 34, 197, 182), renderAs: "image", assetId: "bg" },
      { id: "title", name: "做任务 赚钱", type: "TEXT", absoluteBounds: box(18, 0, 163, 109), characters: "做任务 赚钱", renderAs: "image", assetId: "title", fontName: { family: "Arial", style: "Regular" }, fontSize: 51, fontWeight: 400, lineHeight: { css: "51px" }, letterSpacing: { css: "0px" }, textAlignHorizontal: "CENTER", textColor: { css: "rgb(255,255,255)" } },
    ] }],
  });
  assert.equal(preview.manifest.placements.find(p => p.id === "title").role, "decoration");
  const titleClass = preview.html.match(/class="d2c-node ([^"]+)" data-d2c-id="title"/)?.[1];
  const rule = preview.css.match(new RegExp(`\\.${titleClass} \\{([^}]+)\\}`))?.[1] ?? "";
  assert.match(rule, /position:absolute/);
  assert.match(rule, /top:0px/);
  assert.match(rule, /left:18px/);
});

test("rotated overlapping layers use unrotated size and center-based position", () => {
  const preview = generatePreview({
    meta: { schemaVersion: 3, exporterVersion: "3.5.0" }, assets: {},
    nodes: [{ id: "fan", name: "fan", type: "GROUP", absoluteBounds: box(0, 0, 197, 152), children: [
      { id: "base", name: "base", type: "FRAME", absoluteBounds: box(0, 0, 152, 152), children: [text("base-t", "b", 0, 0, "b")] },
      { id: "tilt", name: "tilt", type: "FRAME", absoluteBounds: box(0, 0, 151.87, 151.87), width: 115.03, height: 115.03, rotation: 24, children: [text("tilt-t", "t", 0, 0, "t")] },
    ] }],
  });
  const cls = (id) => preview.html.match(new RegExp(`class="d2c-node ([^"]+)" data-d2c-id="${id}"`))?.[1];
  const rule = (id) => preview.css.match(new RegExp(`\\.${cls(id)} \\{([^}]+)\\}`))?.[1] ?? "";
  assert.match(rule("tilt"), /width:115\.03px/);
  assert.match(rule("tilt"), /height:115\.03px/);
  assert.match(rule("tilt"), /left:18\.42px/);
  assert.match(rule("tilt"), /top:18\.42px/);
  assert.match(rule("tilt"), /rotate:24deg/);
});

test("ellipse layers render as a full inscribed oval via border-radius:50%", () => {
  const preview = generatePreview({
    meta: { schemaVersion: 3, exporterVersion: "3.5.0" }, assets: {},
    nodes: [{ id: "btn", name: "btn", type: "FRAME", absoluteBounds: box(0, 0, 96, 96), children: [
      { id: "circle", name: "椭圆形", type: "ELLIPSE", absoluteBounds: box(0, 0, 96, 96), fills: [{ type: "SOLID", color: "rgba(0,0,0,0.2)" }] },
    ] }],
  });
  const cls = preview.html.match(/class="d2c-node ([^"]+)" data-d2c-id="circle"/)?.[1];
  const rule = preview.css.match(new RegExp(`\\.${cls} \\{([^}]+)\\}`))?.[1] ?? "";
  assert.match(rule, /border-radius:50%/);
});

test("overlapping content children keep exported coordinates instead of spreading inline", () => {
  // Three overlapping card instances in a single visual row. Inline flow would
  // spread them side by side; they must stay absolutely positioned on top of
  // each other.
  const card = (id, x, y) => ({ id, name: id, type: "FRAME", absoluteBounds: box(x, y, 152, 152), children: [text(`${id}-label`, id, x, y, id)] });
  const preview = generatePreview({
    meta: { schemaVersion: 3, exporterVersion: "3.5.0" }, assets: {},
    nodes: [{ id: "fan", name: "fan", type: "GROUP", absoluteBounds: box(0, 0, 197, 152), children: [
      card("left", 0, 0), card("center", 28, 5), card("right", 45, 0),
    ] }],
  });
  for (const id of ["left", "center", "right"]) {
    const cls = preview.html.match(new RegExp(`class="d2c-node ([^"]+)" data-d2c-id="${id}"`))?.[1];
    const rule = preview.css.match(new RegExp(`\\.${cls} \\{([^}]+)\\}`))?.[1] ?? "";
    assert.match(rule, /position:absolute/);
  }
  const centerRule = preview.css.match(/\.d2c-n-[0-9]+ \{([^}]*position:absolute[^}]*left:28px[^}]*)\}/)?.[0] ?? "";
  assert.ok(centerRule.includes("left:28px"));
});

test("regression: 通顶 mobile screen keeps document content in flow with backgrounds positioned", () => {
  const preview = generatePreview({
    meta: { schemaVersion: 3, exporterVersion: "3.5.0" }, assets: {},
    nodes: [{ id: "21:641", name: "通顶", type: "FRAME", absoluteBounds: box(0, 0, 414, 911), children: [
      { id: "21:644", name: "背景", type: "RECTANGLE", absoluteBounds: box(0, 0, 414, 285), fills: [{ type: "SOLID", color: "rgb(255,255,255)" }] },
      { id: "21:645", name: "Group 2147230974", type: "GROUP", absoluteBounds: box(0, 0, 414, 365), renderAs: "image", assetId: "g2147230974" },
      { id: "21:653", name: "互动顶bar", type: "FRAME", absoluteBounds: box(0, 0, 414, 88), children: [text("21:653-label", "bar", 0, 0, "bar")] },
      { id: "21:656", name: "Frame 1", type: "FRAME", absoluteBounds: box(17, 115, 135, 94), children: [text("21:656-label", "f1", 17, 115, "f1")] },
      { id: "21:785", name: "tab", type: "GROUP", absoluteBounds: box(0, 231, 414, 40), children: [text("21:785-label", "tab", 0, 231, "tab")] },
      { id: "21:798", name: "Group 2147230967", type: "GROUP", absoluteBounds: box(235, 88, 201, 196), renderAs: "image", assetId: "g2147230967" },
      { id: "21:822", name: "Frame 2147227602", type: "FRAME", absoluteBounds: box(8, 280, 398, 589), children: [text("21:822-label", "content", 8, 280, "content")] },
      { id: "21:980", name: "bot备份", type: "FRAME", absoluteBounds: box(0, 833, 414, 78), children: [text("21:980-label", "bot", 0, 833, "bot")] },
    ] }],
  });
  const container = preview.manifest.containers.find(item => item.id === "21:641");
  assert.equal(container.primitive, "layered-flow");
  assert.equal(container.contentFlow, "block-flow");
  assert.deepEqual(container.backgroundIds, ["21:644", "21:645"]);
  assert.deepEqual(container.overlayIds, ["21:980"]);
  assert.deepEqual(container.contentRows, [["21:653"], ["21:656"], ["21:785"], ["21:822"]]);
  // Content (the header/frame/tab/body) stays in normal block flow.
  const cls = (id) => preview.html.match(new RegExp(`class="d2c-node ([^"]+)" data-d2c-id="${id}"`))?.[1];
  const rule = (id) => preview.css.match(new RegExp(`\\.${cls(id)} \\{([^}]+)\\}`))?.[1] ?? "";
  assert.equal(rule("21:653").includes("position:absolute"), false);
  assert.equal(rule("21:822").includes("position:absolute"), false);
  // The background stays absolutely positioned at the top.
  assert.match(rule("21:644"), /position:absolute/);
});

test("regression: 首页 layered root keeps overlapping content at exported coordinates instead of collapsing it", () => {
  // Reduced copy of the real "首页" root (35:1399): a free-form screen whose
  // content is scattered across 7 overlapping horizontal bands plus one
  // background, two overlays and four atomic raster decorations. No document
  // flow can reproduce the overlapping bands, so every child must keep its
  // exported x/y instead of collapsing into a stacked flow.
  const solid = [{ type: "SOLID", color: "rgb(255, 255, 255)" }];
  const leaf = (id, name, type, x, y, w, h, extra = {}) => ({ id, name, type, absoluteBounds: box(x, y, w, h), ...extra });
  const content = (id, name, type, x, y, w, h) => leaf(id, name, type, x, y, w, h, { children: [text(`${id}-label`, `${name} label`, x, y, name)] });
  const preview = generatePreview({
    meta: { schemaVersion: 3, exporterVersion: "3.5.0" }, assets: {},
    nodes: [{ id: "35:1399", name: "首页", type: "FRAME", absoluteBounds: box(0, 0, 1242, 2688), children: [
      leaf("35:1400", "Rectangle 279336925", "RECTANGLE", 0, 290, 1242, 1409, { fills: solid }),
      leaf("35:1401", "Mask group", "GROUP", 0, 290, 1242, 1409, { renderAs: "image", assetId: "mask" }),
      leaf("35:1404", "image 2793", "RECTANGLE", 177, 1014, 535.92, 515.38, { renderAs: "image", assetId: "image" }),
      leaf("35:1405", "Rectangle 279336926", "RECTANGLE", 0, 0, 1242, 290, { fills: solid }),
      leaf("35:1406", "Rectangle 279336923", "RECTANGLE", 0, 1663, 1242, 1025, { fills: solid }),
      leaf("35:1407", "马", "GROUP", -50, 706, 1242, 629, { renderAs: "image", assetId: "horse" }),
      content("35:1424", "状态栏", "INSTANCE", 2564, 423, 1242, 288),
      content("35:1425", "状态栏", "INSTANCE", 0, 0, 1242, 288),
      content("35:1426", "金额", "GROUP", 275, 317, 692, 75),
      content("35:1442", "Group 2147228798", "GROUP", 0, 1455, 1242, 2923),
      content("35:1445", "Group 2147228922", "FRAME", 66, 1150, 1110, 513),
      content("35:1552", "Group 2147228795", "GROUP", 963, 428, 228, 228.42),
      content("35:1566", "资产区", "GROUP", 51, 428, 874, 228),
      leaf("35:1611", "底部", "RECTANGLE", 0, 2455, 1242, 233, { renderAs: "image", assetId: "bottom" }),
      content("35:1631", "Group 2147228918", "GROUP", 69, 1370, 191, 73.58),
      content("35:1643", "Group 2147228923", "GROUP", 982, 1370, 191, 73.58),
      content("35:1654", "收起态", "INSTANCE", 1006, 678, 185, 182),
      { ...text("35:1655", "每天返回活动即可获得10张套马券", 329, 1636, "每天返回活动即可获得10张套马券"), absoluteBounds: box(329, 1636, 585, 39) },
      leaf("35:1656", "菜单", "INSTANCE", 51, 307, 96, 96),
      leaf("35:1657", "音效", "INSTANCE", 1095, 307, 96, 96),
    ] }],
  });
  const container = preview.manifest.containers.find(item => item.id === "35:1399");
  assert.equal(container.primitive, "layered-flow");
  assert.equal(container.contentFlow, "flex-row");
  assert.deepEqual(container.backgroundIds, ["35:1405"]);
  assert.deepEqual(container.overlayIds, ["35:1406", "35:1655"]);
  assert.equal(container.contentRows.length, 7);
  assert.deepEqual(container.contentRows[0], ["35:1425"]);
  assert.deepEqual(container.contentRows[1], ["35:1656", "35:1426", "35:1657"]);
  assert.deepEqual(container.contentRows[2], ["35:1566", "35:1552", "35:1424"]);
  assert.deepEqual(container.contentRows[3], ["35:1654"]);
  assert.deepEqual(container.contentRows[4], ["35:1400"]);
  assert.deepEqual(container.contentRows[5], ["35:1631", "35:1445", "35:1643"]);
  assert.deepEqual(container.contentRows[6], ["35:1442"]);
  assert.equal(/display:(?:inline-)?grid/.test(preview.css), false);
  // Overlapping rows cannot be expressed in flow: content must keep its exported
  // coordinates as an absolute layout instead of being collapsed into one line.
  const classOf = (id) => {
    const match = preview.html.match(new RegExp(`class="d2c-node ([^"]+)" data-d2c-id="${id}"`));
    return match ? match[1] : null;
  };
  const rule = (id) => preview.css.match(new RegExp(`\\.${classOf(id)} \\{([^}]+)\\}`))?.[1] ?? "";
  // 金额 (35:1426) sits at x=275,y=317 in the design and must stay there.
  assert.match(rule("35:1426"), /position:absolute/);
  assert.match(rule("35:1426"), /left:275px/);
  assert.match(rule("35:1426"), /top:317px/);
  // 状态栏 (35:1425) is a full-width content band at the top, not a pushed inline item.
  assert.match(rule("35:1425"), /position:absolute/);
  assert.match(rule("35:1425"), /top:0px/);
});

test("styled text ranges render as selectable spans with external CSS", () => {
  const preview = generatePreview({
    meta: { schemaVersion: 3, exporterVersion: "3.5.0" }, assets: {},
    nodes: [{ id: "text-root", name: "Text", type: "FRAME", absoluteBounds: box(0, 0, 240, 40), children: [{
      ...text("mixed-text", "Mixed", 0, 0, "Get 10 tickets"),
      styledTextSegments: [
        { start: 0, end: 4, characters: "Get ", fontName: { family: "Arial", style: "Regular" }, fontSize: 16, fontWeight: 400, lineHeight: { css: "20px" }, letterSpacing: { css: "0px" }, textDecoration: "NONE", textCase: "ORIGINAL", textColor: { css: "rgb(17, 17, 17)" } },
        { start: 4, end: 6, characters: "10", fontName: { family: "Arial", style: "Bold" }, fontSize: 16, fontWeight: 700, lineHeight: { css: "20px" }, letterSpacing: { css: "0px" }, textDecoration: "NONE", textCase: "ORIGINAL", textColor: { css: "rgb(255, 51, 0)" } },
        { start: 6, end: 14, characters: " tickets", fontName: { family: "Arial", style: "Regular" }, fontSize: 16, fontWeight: 400, lineHeight: { css: "20px" }, letterSpacing: { css: "0px" }, textDecoration: "NONE", textCase: "ORIGINAL", textColor: { css: "rgb(17, 17, 17)" } },
      ],
    }] }],
  });
  assert.equal((preview.html.match(/class="d2c-text-segment/g) ?? []).length, 3);
  assert.match(preview.html, /data-d2c-text-start="4" data-d2c-text-end="6">10<\/span>/);
  assert.match(preview.css, /\.d2c-n-2-text-2 \{[^}]*font-weight:700[^}]*color:rgb\(255, 51, 0\)/);
  const textRule = preview.css.match(/\.d2c-n-2 \{([^}]+)\}/)?.[1] ?? "";
  assert.match(textRule, /white-space:pre/);
  assert.match(textRule, /overflow-wrap:normal/);
  assert.match(textRule, /word-break:normal/);
  assert.equal(textRule.includes("pre-wrap"), false);
  assert.equal(textRule.includes("anywhere"), false);
  assert.match(preview.css, /\.d2c-text-segment \{ white-space:inherit; \}/);
  assert.equal(preview.html.includes("style="), false);
});
