import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "./plugin-fixture.mjs";

async function loadTS(file) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(file, import.meta.url))], bundle: true, platform: "node", format: "esm", write: false });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const { prepareDesign, validateLayout, collectLayout } = await loadTS("../src/geometry.ts");
const { persistExport } = await loadTS("../src/assets.ts");
const layer = (id, x, y, width = 100, height = 100) => ({ id, name: id, type: "FRAME", absoluteBounds: { x, y, width, height } });
const design = () => ({ meta: { schemaVersion: 3 }, assets: {}, nodes: [{ ...layer("root", 400.25, -20.5), children: [layer("child", 410.75, -10.25, 20, 30)] }] });
const actual = () => ({ coordinateSpace: "root-relative", stable: true, fontsReady: true, brokenImages: [], nodes: [
  { id: "root", rootId: "root", parentId: null, visible: true, bounds: { x: 0, y: 0, width: 100, height: 100 } },
  { id: "child", rootId: "root", parentId: "root", visible: true, bounds: { x: 10.5, y: 10.25, width: 20, height: 30 } },
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
});

test("the standalone DOM collector normalizes page centering without mutating layout", async () => {
  const root = { dataset: { d2cId: "root" }, parentElement: null, getBoundingClientRect: () => ({ x: 500, y: 20, width: 100, height: 100 }), closest() { return root; } };
  const child = { dataset: { d2cId: "child" }, parentElement: root, getBoundingClientRect: () => ({ x: 510.5, y: 30.25, width: 20, height: 30 }), closest() { return root; } };
  const context = vm.createContext({
    document: { fonts: { ready: Promise.resolve(), status: "loaded" }, images: [], querySelectorAll: () => [root, child] },
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    requestAnimationFrame: (cb) => setImmediate(cb), innerWidth: 1200, innerHeight: 900, devicePixelRatio: 1,
  });
  const measured = await vm.runInContext(`(${collectLayout.toString()})()`, context);
  assert.equal(validateLayout(design(), JSON.parse(JSON.stringify(measured)), 0).passed, true);
});
