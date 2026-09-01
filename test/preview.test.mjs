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
  meta: { schemaVersion: 3, exporterVersion: "3.4.1" }, assets: {},
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
  assert.equal(preview.manifest.containers.find(item => item.id === "root").primitive, "grid-overlay");
  assert.deepEqual(preview.manifest.containers.find(item => item.id === "root").backgroundIds, ["background"]);
  assert.equal(preview.manifest.containers.find(item => item.id === "list").primitive, "block-flow");
  assert.equal(preview.manifest.placements.find(item => item.id === "list").alignment, "center");
  assert.deepEqual(preview.manifest.repeatGroups[0].instanceIds, ["row-1", "row-2", "row-3"]);
  assert.match(preview.html, /data-d2c-repeat="Row"/);
  assert.match(preview.css, /display:grid/);
  assert.equal(preview.html.includes("style="), false);
  assert.equal(preview.manifest.reviewRequired.find(item => item.id === "rotated").reason, "rotated layer uses a CSS rotate fallback");
});

test("atomic raster assets do not repaint vector fills or strokes on their rectangular wrappers", () => {
  const atomic = generatePreview({
    meta: { schemaVersion: 3, exporterVersion: "3.4.1" },
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
