import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { renderStyle, flowStyle } from "./plugin-fixture.mjs";
async function loadTS(file) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(file, import.meta.url))], bundle: true, platform: "node", format: "esm", write: false });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
const { flowPlan, validateFlow } = await loadTS("../src/flow.ts");
const { validateFiles } = await loadTS("../src/assets.ts");
const design = () => ({ meta: { schemaVersion: 3, exporterVersion: "3.5.0" }, assets: {}, nodes: [{ id: "root", type: "FRAME", name: "root", absoluteBounds: { x: 0, y: 0, width: 100, height: 100 }, children: [{ id: "child", name: "child", type: "TEXT", absoluteBounds: { x: 10, y: 10, width: 20, height: 20 } }] }] });
const actual = () => ({ collectorVersion: 5, sampleId: randomUUID(), collectedAt: new Date().toISOString(), viewport: { width: 1200, height: 900, devicePixelRatio: 1 }, coordinateSpace: "root-relative", stable: true, fontsReady: true, brokenImages: [], nodes: [
  { id: "root", rootId: "root", parentId: null, visible: true, bounds: { x: 0, y: 0, width: 100, height: 100 }, renderStyle: renderStyle(), flowStyle: flowStyle({ display: "flex" }) },
  { id: "child", rootId: "root", parentId: "root", visible: true, bounds: { x: 10, y: 10, width: 20, height: 20 }, renderStyle: renderStyle(), flowStyle: flowStyle() },
] });
async function files(t, d = design()) {
  const directory = await mkdtemp(join(tmpdir(), "figma-flow-")), path = join(directory, "design.json");
  const prior = process.env.FIGMA_VALIDATION_DIR;
  process.env.FIGMA_VALIDATION_DIR = join(directory, "validation");
  t.after(async () => { if (prior === undefined) delete process.env.FIGMA_VALIDATION_DIR; else process.env.FIGMA_VALIDATION_DIR = prior; await rm(directory, { recursive: true, force: true }); });
  await writeFile(path, JSON.stringify(d));
  return { path, directory };
}
async function fresh() { await delay(3); return actual(); }

test("flow plan uses lightweight layout strategy and preserves the two-stage gate", () => {
  const d = design(); d.nodes[0].autoLayout = { mode: "HORIZONTAL", itemSpacing: 10, layoutWrap: "WRAP" };
  const plan = flowPlan(d);
  assert.deepEqual(plan.stages, ["baseline", "flow"]);
  assert.equal(plan.containers[0].suggestion.preferred, "flex-row");
  assert.equal(plan.containers[0].suggestion.necessity, "required");
  assert.equal(plan.containers[0].suggestion.autoLayout.itemSpacing, 10);
  assert.deepEqual(plan.exceptionCandidates, []);
});

test("flow checks reject absolute content, wrapper tricks and missing samples", () => {
  const d = design(), a = actual();
  assert.equal(validateFlow(d, a).passed, true);
  for (const [change, issue] of [
    [{ position: "absolute" }, "out-of-flow-position"], [{ position: "fixed" }, "out-of-flow-position"],
    [{ cssFloat: "left" }, "float"], [{ insets: ["10px", "auto", "auto", "auto"] }, "relative-offset"],
    [{ margins: ["-10px", "0px", "0px", "0px"] }, "negative-margin"],
    [{ translate: "10px" }, "translate-offset"], [{ transform: "matrix(1, 0, 0, 1, 10, 0)" }, "transform-offset"],
  ]) {
    const modified = structuredClone(a); Object.assign(modified.nodes[1].flowStyle, change);
    assert.ok(validateFlow(d, modified).mismatches[0].issues.includes(issue), issue);
  }
  a.nodes[1].flowStyle.wrappers = [flowStyle({ position: "absolute" })];
  assert.ok(validateFlow(d, a).mismatches[0].issues.includes("wrapper[0].out-of-flow-position"));
  delete a.nodes[1].flowStyle;
  assert.ok(validateFlow(d, a).mismatches[0].issues.includes("missing-flow-style"));
});

test("flow exceptions are explicit, bounded and cannot exempt wrappers or ordinary text", () => {
  const d = design(), a = actual();
  for (const id of ["root", "child", "unknown"]) assert.throws(() => validateFlow(d, a, [{ id, reason: "overlay" }]), /Invalid flow exception/);
  d.nodes[0].children[0].type = "RECTANGLE";
  a.nodes[1].flowStyle.position = a.nodes[1].renderStyle.position = "absolute";
  const exceptions = [{ id: "child", reason: "Decorative overlay behind the content" }];
  const result = validateFlow(d, a, exceptions);
  assert.equal(result.passed, true);
  assert.equal(result.exceptions[0].reviewRequired, true);
  assert.throws(() => validateFlow(d, a, [...exceptions, ...exceptions]), /Invalid flow exception/);
  a.nodes[1].flowStyle.wrappers = [flowStyle({ position: "absolute" })];
  assert.equal(validateFlow(d, a, exceptions).passed, false);
});

test("baseline success is not completion; a fresh flow sample must pass both style and flow checks", async t => {
  const { path } = await files(t), before = actual();
  for (const n of before.nodes) n.flowStyle.position = n.renderStyle.position = "absolute";
  const baseline = await validateFiles(path, before);
  assert.equal(baseline.passed, true); assert.equal(baseline.workflowComplete, false);
  assert.match(baseline.nextAction, /refactor/);
  const options = { phase: "flow", baselineReportPath: baseline.reportPath };
  const after = await fresh();
  after.nodes[1].flowStyle.position = after.nodes[1].renderStyle.position = "absolute";
  const positioned = await validateFiles(path, after, 1, options);
  assert.equal(positioned.passed, false); assert.equal(positioned.workflowComplete, false);
  assert.equal(positioned.flowMismatches[0].id, "child");
  after.nodes[1].flowStyle.position = after.nodes[1].renderStyle.position = "relative";
  after.nodes[1].bounds.x = 99;
  assert.equal((await validateFiles(path, after, 1, options)).passed, false);
  after.nodes[1].bounds.x = 10;
  const passed = await validateFiles(path, after, 1, options);
  assert.equal(passed.workflowComplete, true); assert.equal(passed.visualAcceptance, "not-verified");
  const saved = JSON.parse(await readFile(passed.reportPath, "utf8"));
  assert.equal(saved.phase, "flow"); assert.equal(saved.baselineReportPath, baseline.reportPath);
  assert.deepEqual(saved.actual, after);
});

test("flow cannot skip or reuse baseline, change viewport, or relax tolerance", async t => {
  const { path } = await files(t), before = actual();
  await assert.rejects(validateFiles(path, before, 1, { phase: "flow" }), /requires baselineReportPath/);
  const baseline = await validateFiles(path, before, 0.5), options = { phase: "flow", baselineReportPath: baseline.reportPath };
  await assert.rejects(validateFiles(path, before, 0.5, options), /new browser sample/);
  const after = await fresh();
  await assert.rejects(validateFiles(path, after, 1, options), /tolerance/);
  assert.equal((await validateFiles(path, after, undefined, options)).tolerance, 0.5);
  after.viewport.width = 1000;
  await assert.rejects(validateFiles(path, after, 0.5, options), /same viewport/);
  after.viewport.width = 1200; after.collectedAt = before.collectedAt;
  await assert.rejects(validateFiles(path, after, 0.5, options), /new browser sample/);
});

test("failed, changed-design and non-baseline reports cannot unlock the flow stage", async t => {
  const { path } = await files(t), before = actual();
  before.nodes[1].bounds.x = 99;
  const failed = await validateFiles(path, before);
  await assert.rejects(validateFiles(path, await fresh(), 1, { phase: "flow", baselineReportPath: failed.reportPath }), /successful baseline/);
  before.nodes[1].bounds.x = 10;
  const baseline = await validateFiles(path, before), options = { phase: "flow", baselineReportPath: baseline.reportPath };
  const complete = await validateFiles(path, await fresh(), 1, options);
  await assert.rejects(validateFiles(path, await fresh(), 1, { phase: "flow", baselineReportPath: complete.reportPath }), /successful baseline/);
  await writeFile(path, JSON.stringify({ ...design(), changed: true }));
  await assert.rejects(validateFiles(path, await fresh(), 1, options), /design digest/);
});

test("flow hard constraint rejects every Grid and Flex that layoutStrategy does not justify", () => {
  const make = (texts, autoLayout) => ({ meta: { schemaVersion: 3, exporterVersion: "3.5.0" }, assets: {}, nodes: [{ id: "root", type: "FRAME", name: "root", autoLayout, absoluteBounds: { x: 0, y: 0, width: 100, height: 100 }, children: texts.map((b, i) => ({ id: `t${i}`, name: `t${i}`, type: "TEXT", absoluteBounds: b })) }] });
  const sample = (display) => ({ collectorVersion: 5, sampleId: randomUUID(), collectedAt: new Date().toISOString(), viewport: { width: 1200, height: 900, devicePixelRatio: 1 }, coordinateSpace: "root-relative", stable: true, fontsReady: true, brokenImages: [], nodes: [
    { id: "root", rootId: "root", parentId: null, visible: true, bounds: { x: 0, y: 0, width: 100, height: 100 }, renderStyle: renderStyle(), flowStyle: flowStyle({ display }) },
    ...[0, 1, 2].map(i => ({ id: `t${i}`, rootId: "root", parentId: "root", visible: true, bounds: { x: 0, y: i * 20, width: 10, height: 10 }, renderStyle: renderStyle(), flowStyle: flowStyle() })),
  ] });
  // Vertical, non-overlapping children → block-flow (lightweight-default).
  const vertical = make([{ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 20, width: 10, height: 10 }, { x: 0, y: 40, width: 10, height: 10 }]);
  assert.equal(validateFlow(vertical, sample("grid")).passed, false);
  assert.ok(validateFlow(vertical, sample("grid")).mismatches[0].issues.some(i => i.includes("grid-forbidden")));
  assert.ok(validateFlow(vertical, sample("flex")).mismatches[0].issues.some(i => i.includes("flex-not-justified")));
  assert.equal(validateFlow(vertical, sample("block")).passed, true);
  // Horizontal SPACE_BETWEEN → flex-row (required): flex justified, grid still not.
  const horizontal = make([{ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 0, width: 10, height: 10 }, { x: 40, y: 0, width: 10, height: 10 }], { mode: "HORIZONTAL", primaryAxisAlignItems: "SPACE_BETWEEN" });
  assert.equal(validateFlow(horizontal, sample("flex")).passed, true);
  assert.ok(validateFlow(horizontal, sample("grid")).mismatches[0].issues.some(i => i.includes("grid-forbidden")));
  const twoDimensional = make([{ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 0, width: 10, height: 10 }, { x: 0, y: 20, width: 10, height: 10 }]);
  assert.equal(validateFlow(twoDimensional, sample("flex")).passed, true);
  assert.ok(validateFlow(twoDimensional, sample("grid")).mismatches[0].issues.some(i => i.includes("grid-forbidden")));
  const wrapperGrid = sample("block");
  wrapperGrid.nodes[0].flowStyle.wrappers = [flowStyle({ display: "grid" })];
  assert.ok(validateFlow(vertical, wrapperGrid).mismatches[0].issues.includes("wrapper[0].grid-forbidden"));
  const leafGrid = sample("block");
  leafGrid.nodes[1].flowStyle.display = "inline-grid";
  assert.ok(validateFlow(vertical, leafGrid).mismatches.find(item => item.id === "t0").issues.some(i => i.includes("grid-forbidden")));
});
