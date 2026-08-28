import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG, png, renderStyle } from "./plugin-fixture.mjs";

async function loadTS(file) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(file, import.meta.url))], bundle: true, platform: "node", format: "esm", write: false });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const { prepareDesign, validateLayout, collectLayout } = await loadTS("../src/geometry.ts");
const { parseCSSColor } = await loadTS("../src/rendering.ts");
const { persistExport } = await loadTS("../src/assets.ts");
const layer = (id, x, y, width = 100, height = 100) => ({ id, name: id, type: "FRAME", absoluteBounds: { x, y, width, height } });
const design = () => ({ meta: { schemaVersion: 3, exporterVersion: "3.4.0" }, assets: {}, nodes: [{ ...layer("root", 400.25, -20.5), children: [layer("child", 410.75, -10.25, 20, 30)] }] });
const actual = () => ({ collectorVersion: 4, coordinateSpace: "root-relative", stable: true, fontsReady: true, brokenImages: [], nodes: [
  { id: "root", rootId: "root", parentId: null, visible: true, renderStyle: renderStyle(), bounds: { x: 0, y: 0, width: 100, height: 100 } },
  { id: "child", rootId: "root", parentId: "root", visible: true, renderStyle: renderStyle({ borderBoxWidth: 20, borderBoxHeight: 30 }), bounds: { x: 10.5, y: 10.25, width: 20, height: 30 } },
] });

test("normalization uses each selection root; edge values are computed, not trusted", () => {
  const d = design();
  d.nodes[0].absoluteBounds.right = 9999;
  d.nodes.push(layer("other", -1000, 20, 50, 60));
  const normalized = prepareDesign(d);
  assert.equal(normalized.nodes[0].absoluteBounds.right, 500.25);
  assert.equal(normalized.nodes[0].children[0].relativeBounds.right, 30.5);
  assert.equal(normalized.nodes[1].relativeBounds.x, 0);
  assert.equal(d.nodes[0].absoluteBounds.right, 9999);
});

test("validator measures all edges and accepts only the corrected actual geometry", () => {
  const measured = actual();
  measured.nodes[1].bounds.x += 6;
  measured.nodes[1].bounds.width += 3;
  const failed = validateLayout(design(), measured, 0.5);
  assert.equal(failed.passed, false);
  assert.equal(failed.failed[0].delta.left, 6);
  assert.equal(failed.failed[0].delta.right, 9);
  assert.equal(failed.failed[0].delta.width, 3);
  assert.equal(validateLayout(design(), actual(), 0.5).passed, true);
});

test("missing/duplicate/unexpected IDs and wrong parent mappings fail even with matching boxes", () => {
  const measured = actual();
  measured.nodes[1].parentId = null;
  measured.nodes.push({ ...measured.nodes[0] }, { ...measured.nodes[0], id: "unexpected" });
  const report = validateLayout(design(), measured);
  assert.equal(report.passed, false);
  assert.deepEqual(report.duplicates, ["root"]);
  assert.deepEqual(report.unexpected, ["unexpected"]);
  assert.equal(report.failed.find((n) => n.id === "child").reason, "hierarchy-mismatch");
  measured.nodes = measured.nodes.filter((n) => n.id !== "child");
  assert.deepEqual(validateLayout(design(), measured).missing, ["child"]);
});

test("hidden implementations, unstable layout, missing fonts or broken assets cannot pass", () => {
  for (const change of [
    (a) => { a.nodes[1].visible = false; }, (a) => { a.stable = false; },
    (a) => { a.fontsReady = false; }, (a) => { a.brokenImages = ["missing.png"]; },
  ]) { const a = actual(); change(a); assert.equal(validateLayout(design(), a).passed, false); }
  assert.throws(() => validateLayout(design(), { ...actual(), coordinateSpace: "viewport" }), /root-relative/);
});

test("matching boxes cannot hide a wrong line-height or an omitted image", () => {
  const d = design(), a = actual();
  const child = d.nodes[0].children[0];
  Object.assign(child, { type: "TEXT", fontSize: 33, lineHeight: { unit: "PERCENT", value: 100 } });
  a.nodes[1].textStyle = { fontSize: 33, lineHeight: 100 };
  assert.equal(validateLayout(d, a).failed[0].reason, "line-height-mismatch");
  a.nodes[1].textStyle.lineHeight = 33;
  assert.equal(validateLayout(d, a).passed, true);
  child.renderAs = "image"; child.assetId = "text-image";
  d.assets["text-image"] = { relativePath: "images/custom-font.png" };
  assert.equal(validateLayout(d, a).failed[0].reason, "image-missing-or-wrong-source");
  a.nodes[1].tagName = "IMG"; a.nodes[1].imageSources = ["http://localhost:8000/images/custom-font.png"];
  assert.equal(validateLayout(d, a).passed, true);
  a.nodes[1].imageSources = ["http://localhost:8000/images/wrong.png"];
  assert.equal(validateLayout(d, a).passed, false);
});

test("clipping is checked in both directions and missing styles cannot silently pass", () => {
  const d = design(), a = actual(), root = d.nodes[0], style = a.nodes[0].renderStyle;
  root.clipsContent = true;
  assert.equal(validateLayout(d, a).failed[0].propertyMismatches[0].property, "clipsContent");
  style.overflowX = "hidden";
  assert.equal(validateLayout(d, a).passed, false);
  style.overflowY = "clip";
  assert.equal(validateLayout(d, a).passed, true);
  style.position = "static";
  assert.equal(validateLayout(d, a).failed[0].propertyMismatches[0].property, "clip-containing-block");
  style.position = "relative";
  root.clipsContent = false;
  assert.equal(validateLayout(d, a).passed, false);
  style.overflowX = style.overflowY = "visible";
  assert.equal(validateLayout(d, a).passed, true);
  for (const override of [{ clipPath: "inset(10px)" }, { maskImage: "url(mask.svg)" }, { contain: "paint" }, { wrapperEffects: ["overflowX:hidden"] }]) {
    const bad = structuredClone(a); Object.assign(bad.nodes[0].renderStyle, override);
    assert.equal(validateLayout(d, bad).passed, false);
  }
  delete a.nodes[0].renderStyle;
  assert.equal(validateLayout(d, a).passed, false);
  assert.equal(validateLayout(d, a).collectorCompatible, false);
});

test("opacity has its own tolerance and raster opacity must not be applied twice", () => {
  const d = design(), a = actual(), child = d.nodes[0].children[0];
  child.opacity = 0.5;
  assert.equal(validateLayout(d, a, 10).passed, false);
  a.nodes[1].renderStyle.opacity = 0.5;
  assert.equal(validateLayout(d, a).passed, true);
  Object.assign(child, { renderAs: "image", assetId: "raster", clipsContent: true, cornerRadius: 10, type: "TEXT", fontSize: 99 });
  d.assets.raster = { opacityBaked: true, relativePath: "images/raster.png" };
  Object.assign(a.nodes[1], { tagName: "IMG", imageSources: ["/images/raster.png"] });
  assert.equal(validateLayout(d, a).failed[0].propertyMismatches[0].property, "opacity");
  a.nodes[1].renderStyle.opacity = 1;
  assert.equal(validateLayout(d, a).passed, true); // No duplicate radius, clipping or text-style checks for baked images.
});

test("four distinct corners, percentage radii and CSS overlap scaling are compared", () => {
  const d = design(), a = actual();
  d.nodes[0].cornerRadii = { topLeft: 1, topRight: 2, bottomRight: 3, bottomLeft: 4 };
  assert.equal(validateLayout(d, a).passed, false);
  a.nodes[0].renderStyle.cornerRadii = ["1px", "2px", "3px", "4px"];
  assert.equal(validateLayout(d, a).passed, true);
  delete d.nodes[0].cornerRadii; d.nodes[0].cornerRadius = 999;
  a.nodes[0].renderStyle.cornerRadii = Array(4).fill("50%");
  assert.equal(validateLayout(d, a).passed, true);
  a.nodes[0].renderStyle.cornerRadii[0] = "0px";
  assert.equal(validateLayout(d, a).passed, false);
  d.nodes[0].cornerSmoothing = 0.6;
  const report = validateLayout(d, a);
  assert.equal(report.reviewRequired[0].properties.some((p) => p.property === "cornerSmoothing"), true);
  assert.equal(report.visualAcceptance, "not-verified");
});

test("text metrics, direction-aware alignment and decoration cannot hide behind a matching box", () => {
  const d = design(), a = actual(), child = d.nodes[0].children[0];
  Object.assign(child, { type: "TEXT", fontSize: 20, fontWeight: 600, fontName: { family: "Arial", style: "Italic" }, letterSpacing: { unit: "PERCENT", value: 2 }, textAlignHorizontal: "RIGHT", textDecoration: "UNDERLINE" });
  a.nodes[1].textStyle = { fontSize: 20, lineHeight: 20, fontWeight: 600, fontStyle: "italic", letterSpacing: 0.4, textAlign: "start", direction: "rtl", textDecorationLine: "underline" };
  assert.equal(validateLayout(d, a).passed, true);
  for (const [prop, value] of Object.entries({ fontSize: 16, fontWeight: 400, fontStyle: "normal", letterSpacing: 0, textAlign: "left", textDecorationLine: "none" })) {
    const bad = structuredClone(a); bad.nodes[1].textStyle[prop] = value;
    assert.equal(validateLayout(d, bad).passed, false, prop);
  }
});

test("old collectors fail globally and unsupported properties remain explicitly unverified", () => {
  const d = design(), a = actual();
  delete a.collectorVersion;
  assert.equal(validateLayout(d, a).passed, false);
  a.collectorVersion = 4;
  const incomplete = structuredClone(a);
  incomplete.nodes[0].renderStyle = { wrapperEffects: [] };
  assert.equal(validateLayout(d, incomplete).collectorCompatible, false);
  Object.assign(d.nodes[0], { effects: [{ type: "DROP_SHADOW", visible: true }], blendMode: "MULTIPLY", autoLayout: { layoutWrap: "WRAP" } });
  d.nodes[0].children[0].isMask = true;
  const report = validateLayout(d, a);
  assert.equal(report.passed, true); // Automated-only pass is not visual acceptance.
  assert.equal(report.visualAcceptance, "not-verified");
  assert.deepEqual(report.reviewRequired[0].properties.map((p) => p.property), ["effects", "isMask/maskType", "blendMode", "layout/resizing", "stacking-order"]);
});

test("resolved AUTO and real text foreground colors are hard checks, including text-fill overrides", () => {
  const d = design(), a = actual(), child = d.nodes[0].children[0];
  Object.assign(child, { type: "TEXT", lineHeight: { unit: "AUTO", source: "figma-css", pixels: 24.5 }, textColor: { rgba: { r: 1, g: 0, b: 0, a: 0.004 } } });
  a.nodes[1].textStyle = { fontSize: 20, lineHeight: 24.5, color: "rgba(255, 0, 0, 0.004)", textFillColor: "rgb(100% 0% 0% / 0.4%)" };
  assert.equal(validateLayout(d, a).passed, true);
  for (const change of [
    n => n.textStyle.lineHeight = null,
    n => n.textStyle.color = "rgb(0,0,0)",
    n => n.textStyle.textFillColor = "transparent",
    n => delete n.textStyle.color,
  ]) { const bad = structuredClone(a); change(bad.nodes[1]); assert.equal(validateLayout(d, bad).passed, false); }
  child.lineHeight = { unit: "AUTO", css: "normal", pixels: null };
  assert.equal(validateLayout(d, a).passed, false);
  assert.deepEqual(parseCSSColor("rgb(10% 20% 30% / 50%)"), [0.1, 0.2, 0.3, 0.5]);
  assert.equal(parseCSSColor("color(display-p3 1 0 0)"), null);
});

test("image layout and expanded paint bounds are independent and neither can be faked", () => {
  const d = design(), a = actual(), child = d.nodes[0].children[0];
  Object.assign(child, { renderAs: "image", assetId: "raster", imageBounds: { x: 406.75, y: -14.25, width: 28, height: 38 } });
  d.assets.raster = { relativePath: "images/raster.png", opacityBaked: true, pixelWidth: 56, pixelHeight: 76 };
  Object.assign(a.nodes[1], { tagName: "DIV", assetImages: [{ assetId: "raster", src: "/images/raster.png", bounds: { x: 6.5, y: 6.25, width: 28, height: 38 }, naturalWidth: 56, naturalHeight: 76, opacity: 1, objectFit: "fill" }] });
  const normalized = prepareDesign(d).nodes[0].children[0];
  assert.equal(normalized.imagePlacement.x, -4);
  assert.equal(normalized.relativeBounds.width, 20);
  assert.equal(validateLayout(d, a).passed, true);
  for (const change of [
    n => n.assetImages[0].bounds.x += 4,
    n => n.assetImages[0].bounds.width = 20,
    n => n.assetImages[0].naturalWidth = 40,
    n => n.assetImages[0].opacity = 0.5,
    n => n.assetImages[0].objectFit = "contain",
    n => n.assetImages.push(n.assetImages[0]),
    n => n.renderStyle.overflowX = "hidden",
  ]) { const bad = structuredClone(a); change(bad.nodes[1]); assert.equal(validateLayout(d, bad).passed, false); }
});

test("raster publication verifies PNG pixels against the full canvas and rejects cropped bytes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "raster-canvas-test-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const d = design(), child = d.nodes[0].children[0];
  Object.assign(child, { renderAs: "image", assetId: "raster", imageBounds: { x: 406.75, y: -14.25, width: 28, height: 38 } });
  d.assets.raster = { bounds: child.imageBounds, scale: 2, opacityBaked: true };
  await assert.rejects(persistExport(d, new Map([["raster", png(40, 60)]]), { outputDir: dir }), /pixel size\/bounds mismatch/);
  assert.deepEqual(await readdir(dir), []);
  const saved = await persistExport(d, new Map([["raster", png(56, 76)]]), { outputDir: dir });
  assert.equal(saved.assets.raster.pixelWidth, 56);
  const layout = JSON.parse(await readFile(saved.meta.layoutPath));
  assert.equal(layout[1].imagePlacement.x, -4);
});

test("asset export is atomic, preserves actual formats and never uses untrusted IDs as paths", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "figma-assets-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const d = design();
  d.nodes[0].children[0].renderAs = "image";
  d.nodes[0].children[0].assetId = "../../escape";
  d.assets["../../escape"] = { kind: "shape" };
  const saved = await persistExport(d, new Map([["../../escape", PNG]]), { outputDir: dir });
  const image = saved.assets["../../escape"];
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.byteLength, PNG.length);
  assert.deepEqual(await readFile(image.path), PNG);
  assert.equal(image.relativePath.includes(".."), false);
  const disk = JSON.parse(await readFile(saved.meta.designPath, "utf8"));
  assert.equal(disk.assets["../../escape"].path, image.path);
  assert.equal(disk.nodes[0].children[0].relativeBounds.left, 10.5);
  const expression = await readFile(saved.meta.collectorExpressionPath, "utf8");
  assert.match(expression, /getBoundingClientRect/);
  const requirements = JSON.parse(await readFile(saved.meta.implementationPath, "utf8"));
  assert.equal(requirements.layers[1].checks.includes("image-reference"), true);
  const layout = JSON.parse(await readFile(saved.meta.layoutPath, "utf8"));
  assert.deepEqual(layout[1].implementation, disk.nodes[0].children[0].implementation);
  assert.deepEqual((await readdir(dir)).filter((n) => n.startsWith(".export")), []);
});

test("missing or invalid image bytes leave no published export or staging directory", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "figma-assets-failure-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const d = design(); d.assets.image = { kind: "image-fill" };
  await assert.rejects(persistExport(d, new Map(), { outputDir: dir }), /Missing image bytes/);
  await assert.rejects(persistExport(d, new Map([["image", Buffer.from("bad")]]), { outputDir: dir }), /invalid image/);
  assert.deepEqual(await readdir(dir), []);
  await assert.rejects(persistExport(design(), new Map(), { outputDir: "relative" }), /absolute/);
  const oldPlugin = design(); delete oldPlugin.meta.exporterVersion;
  await assert.rejects(persistExport(oldPlugin, new Map(), { outputDir: dir }), /Close and reopen/);
});

test("the standalone DOM collector normalizes page centering without mutating layout", async () => {
  const root = { dataset: { d2cId: "root" }, querySelectorAll: () => [], parentElement: null, hasAttribute: () => true, getBoundingClientRect: () => ({ x: 500, y: 20, width: 100, height: 100 }), closest() { return root; } };
  const child = { dataset: { d2cId: "child" }, querySelectorAll: () => [], parentElement: root, getBoundingClientRect: () => ({ x: 510.5, y: 30.25, width: 20, height: 30 }), closest() { return root; } };
  const context = vm.createContext({
    document: { fonts: { ready: Promise.resolve(), status: "loaded" }, images: [], querySelectorAll: () => [root, child] },
    getComputedStyle: () => ({ backgroundImage: "linear-gradient(90deg, rgb(255, 0, 0), rgb(0, 0, 255))", backgroundOrigin: "border-box", backgroundClip: "border-box", backgroundSize: "100% 100%", backgroundPosition: "0% 0%", display: "block", visibility: "visible", opacity: "1", position: "relative", overflowX: "visible", overflowY: "visible", clipPath: "none", maskImage: "none", contain: "none", width: "100px", height: "100px", boxSizing: "border-box", fontSize: "16px", fontWeight: "400", fontStyle: "normal", lineHeight: "0px", letterSpacing: "normal", borderTopLeftRadius: "0px", borderTopRightRadius: "0px", borderBottomRightRadius: "0px", borderBottomLeftRadius: "0px" }),
    requestAnimationFrame: (cb) => setImmediate(cb), innerWidth: 1200, innerHeight: 900, devicePixelRatio: 1,
  });
  const measured = await vm.runInContext(`(${collectLayout.toString()})()`, context);
  assert.equal(validateLayout(design(), JSON.parse(JSON.stringify(measured)), 0).passed, true);
  assert.equal(measured.nodes[1].textStyle.lineHeight, 0);
  assert.equal(measured.nodes[1].textStyle.letterSpacing, 0);
  assert.equal(measured.collectorVersion, 4);
  for (const key of ["backgroundImage", "backgroundOrigin", "backgroundClip", "backgroundSize", "backgroundPosition"]) assert.equal(measured.nodes[0].renderStyle[key], context.getComputedStyle()[key]);
  const wrapper = { parentElement: root, hasAttribute: () => false, closest: () => root };
  child.parentElement = wrapper;
  const originalStyle = context.getComputedStyle;
  context.getComputedStyle = (el) => ({ ...originalStyle(el), ...(el === wrapper ? { opacity: "0.5", overflowX: "hidden" } : {}) });
  const wrapped = await vm.runInContext(`(${collectLayout.toString()})()`, context);
  assert.deepEqual(Array.from(wrapped.nodes[1].renderStyle.wrapperEffects), ["overflowX:hidden", "opacity:0.5"]);
  assert.equal(validateLayout(design(), JSON.parse(JSON.stringify(wrapped))).passed, false);
  child.parentElement = root;
  const img = { tagName: "IMG", dataset: { d2cAsset: "raster" }, currentSrc: "/images/raster.png", naturalWidth: 56, naturalHeight: 76, complete: true, decode: () => Promise.resolve(), closest: () => child, getBoundingClientRect: () => ({ x: 506.5, y: 26.25, width: 28, height: 38 }) };
  root.querySelectorAll = child.querySelectorAll = () => [img];
  context.document.images = [img];
  context.getComputedStyle = () => ({ ...originalStyle(), color: "rgba(255, 0, 0, 0.004)", webkitTextFillColor: "transparent", objectFit: "fill" });
  const owned = await vm.runInContext(`(${collectLayout.toString()})()`, context);
  assert.equal(owned.nodes[0].assetImages.length, 0); // Cannot borrow a child's asset to satisfy a parent.
  assert.equal(owned.nodes[1].assetImages[0].bounds.x, 6.5);
  assert.equal(owned.nodes[1].assetImages[0].naturalWidth, 56);
  assert.equal(owned.nodes[1].textStyle.color, "rgba(255, 0, 0, 0.004)");
  assert.equal(owned.nodes[1].textStyle.textFillColor, "transparent");
});
