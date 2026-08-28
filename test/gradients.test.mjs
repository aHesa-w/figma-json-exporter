import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { node, pluginFixture, renderStyle } from "./plugin-fixture.mjs";

async function loadTS(file) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(file, import.meta.url))], bundle: true, platform: "node", format: "esm", write: false });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const { linearGradient, parseLinearGradient, validateGradient } = await loadTS("../src/gradients.ts");
const { validateLayout } = await loadTS("../src/geometry.ts");
const stops = [{ position: 0, color: "rgba(255,0,0,1)" }, { position: 1, color: "rgba(0,0,255,0.5)" }];
const layer = (matrix = [[1, 0, 0], [0, 1, 0]]) => ({ id: "root", name: "root", type: "FRAME", width: 200, height: 100, absoluteBounds: { x: 0, y: 0, width: 200, height: 100 }, fills: [{ type: "GRADIENT_LINEAR", gradientTransform: matrix, gradientStops: stops }] });
const styleFor = (target) => renderStyle({ borderBoxWidth: 200, borderBoxHeight: 100, backgroundImage: target.css, backgroundOrigin: "border-box", backgroundClip: "border-box", backgroundSize: "100% 100%", backgroundPosition: "0% 0%" });

test("linear directions use Figma matrix polarity and CSS angle convention", () => {
  for (const [matrix, angle] of [
    [[[1, 0, 0], [0, 1, 0]], 90],
    [[[0, 1, 0], [-1, 0, 1]], 180],
    [[[-1, 0, 1], [0, -1, 1]], 270],
    [[[0, -1, 1], [1, 0, 0]], 0],
  ]) assert.equal(linearGradient(layer(matrix)).angleDeg, angle);
});

test("rectangular, offset, scaled and sheared gradients preserve the underlying color field", () => {
  for (const matrix of [
    [[Math.SQRT1_2, Math.SQRT1_2, (1 - Math.SQRT2) / 2], [-Math.SQRT1_2, Math.SQRT1_2, 0.5]],
    [[2, 0.5, -0.4], [0.1, 1, 0.2]],
    [[-0.5, 1.5, 0.2], [1, 0, 0]],
  ]) {
    const target = linearGradient(layer(matrix)), theta = target.angleDeg * Math.PI / 180;
    const ux = Math.sin(theta), uy = -Math.cos(theta), length = Math.abs(ux) * 200 + Math.abs(uy) * 100;
    for (const [x, y] of [[0, 0], [40, 25], [100, 50], [200, 100]]) {
      const cssPosition = (0.5 + ((x - 100) * ux + (y - 50) * uy) / length) * 100;
      const t = (cssPosition - target.stops[0].position) / (target.stops[1].position - target.stops[0].position);
      assert.ok(Math.abs(t - (matrix[0][0] * x / 200 + matrix[0][1] * y / 100 + matrix[0][2])) < 1e-10);
    }
    assert.equal(validateGradient(layer(matrix), styleFor(target)).length, 0);
  }
  const diagonal = linearGradient(layer([[1, 1, -0.5], [-1, 1, 0.5]]));
  assert.ok(Math.abs(diagonal.angleDeg - 153.43494882292202) < 1e-9); // Not a naive 135deg.
});

test("CSS angle units, wraparound, defaults and magic-corner keywords are parsed", () => {
  for (const angle of ["90deg", "-270deg", "450deg", "0.25turn", "100grad", `${Math.PI / 2}rad`, "to right"]) {
    const parsed = parseLinearGradient(`linear-gradient(${angle}, rgb(255,0,0), rgb(0,0,255))`, 200, 100);
    assert.ok(Math.abs(parsed.angleDeg - 90) < 1e-8);
  }
  assert.equal(parseLinearGradient("linear-gradient(rgb(255,0,0), rgb(0,0,255))", 200, 100).angleDeg, 180);
  assert.ok(Math.abs(parseLinearGradient("linear-gradient(to bottom right, rgb(255,0,0), rgb(0,0,255))", 200, 100).angleDeg - 153.43494882292202) < 1e-8);
  const automatic = parseLinearGradient("linear-gradient(90deg, rgb(255,0,0) 20px, rgb(0,255,0), rgb(0,0,255) 180px)", 200, 100);
  assert.deepEqual(automatic.stops.map(s => s.position), [10, 50, 90]);
});

test("wrong direction, reversed stops, alpha, offsets and missing gradients fail hard", () => {
  const n = layer(), target = linearGradient(n), style = styleFor(target);
  assert.equal(validateGradient(n, style).length, 0);
  for (const [css, property] of [
    [target.css.replace("90deg", "270deg"), "gradient-direction"],
    [target.css.replace("255,0,0,1", "0,0,255,1"), "gradient-stops[0]"],
    [target.css.replace("0,0,255,0.5", "0,0,255,1"), "gradient-stops[1]"],
    [target.css.replace(" 0%", " 10%"), "gradient-stops[0]"],
    ["none", "gradient-missing-or-unsupported"],
    [`${target.css}, ${target.css}`, "gradient-missing-or-unsupported"],
    [target.css.replace("linear-gradient", "repeating-linear-gradient"), "gradient-missing-or-unsupported"],
  ]) assert.equal(validateGradient(n, { ...style, backgroundImage: css })[0].property, property);
  assert.equal(validateGradient(n, { ...style, backgroundSize: "50% 100%" })[0].property, "gradient-paint-box");
  const design = { meta: { schemaVersion: 3, exporterVersion: "3.4.1" }, assets: {}, nodes: [n] };
  const actual = { collectorVersion: 4, coordinateSpace: "root-relative", stable: true, fontsReady: true, nodes: [{ id: "root", rootId: "root", parentId: null, visible: true, bounds: n.absoluteBounds, renderStyle: { ...style, backgroundImage: target.css.replace("90deg", "180deg") } }] };
  assert.equal(validateLayout(design, actual, 10).passed, false); // Geometry tolerance cannot relax angular checks.
});

test("paint opacity is multiplied into stop alpha once and invalid matrices are rejected", () => {
  const n = layer(); n.fills[0].opacity = 0.2;
  assert.deepEqual(linearGradient(n).stops.map(s => s.color[3]), [0.2, 0.1]);
  n.fills[0].gradientStops = [{ position: 0, color: "rgba(255,0,0,1e-7)" }, stops[1]];
  assert.equal(linearGradient(n).stops[0].color[3], 2e-8);
  assert.equal(validateGradient(n, styleFor(linearGradient(n))).length, 0);
  n.fills[0].gradientTransform = [[0, 0, 0], [0, 0, 0]];
  assert.equal(linearGradient(n), null);
  assert.equal(validateGradient(n, renderStyle())[0].property, "gradient-unsupported");
});

test("complex gradient containers/strokes rasterize while simple linear fills retain children", async () => {
  const paint = { type: "GRADIENT_LINEAR", gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } }] };
  const result = await pluginFixture([
    node("linear", { fills: [paint], children: [node("child")] }),
    ...["GRADIENT_RADIAL", "GRADIENT_ANGULAR", "GRADIENT_DIAMOND"].map(type => node(type, { fills: [{ ...paint, type }], children: [node(`${type}-child`)] })),
    node("multi", { fills: [paint, paint] }),
    node("stroke", { strokes: [paint] }),
    node("hidden", { fills: [{ ...paint, visible: false }] }),
  ]).request();
  assert.equal(result.type, "done", result.message);
  assert.equal(result.data.nodes[0].children.length, 1);
  for (const n of result.data.nodes.slice(1, 6)) { assert.equal(n.renderAs, "image"); assert.equal(n.rasterReason, "complex-gradient"); assert.equal(n.children, undefined); }
  assert.equal(result.data.nodes[6].renderAs, undefined);
});
