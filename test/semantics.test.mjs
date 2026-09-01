import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

async function loadTS(file) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(file, import.meta.url))], bundle: true, platform: "node", format: "esm", write: false });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const { semanticPlan } = await loadTS("../src/semantics.ts");
const bounds = (x, y, width = 20, height = 20) => ({ x, y, width, height });
const layer = (id, name, x, y, children = [], properties = {}) => ({ id, name, type: "FRAME", absoluteBounds: bounds(x, y), children, ...properties });
const card = (id, number, x, y) => layer(id, `Skill Row ${number}`, x, y, [
  { id: `${id}-name`, name: "Skill Name", type: "TEXT", characters: `Skill ${number}`, absoluteBounds: bounds(x, y) },
]);
const design = (children) => ({ meta: { schemaVersion: 3, exporterVersion: "3.5.0" }, assets: {}, nodes: [layer("root", "Page", 0, 0, children)] });

test("semantic plan emits top-to-bottom then left-to-right code order independent of design order", () => {
  const plan = semanticPlan(design([
    card("third", 3, 0, 40),
    card("second", 2, 40, 0),
    card("first", 1, 0, 0),
  ]));
  const root = plan.containers.find(container => container.id === "root");
  assert.deepEqual(root.designOrder, ["third", "second", "first"]);
  assert.deepEqual(root.codeOrder, ["first", "second", "third"]);
  assert.equal(root.orderPolicy, "visual-reading-order");
  assert.equal(root.layoutStrategy.preferred, "flex-row");
  assert.match(root.layoutStrategy.reason, /Grid is forbidden/);
  assert.equal(plan.summary.reorderedContainerCount, 1);
});

test("layout strategy prefers lightweight block and inline flow before flex", () => {
  const vertical = semanticPlan(design([
    card("one", 1, 0, 0), card("two", 2, 0, 30), card("three", 3, 0, 60),
  ])).containers.find(container => container.id === "root");
  assert.equal(vertical.layoutStrategy.preferred, "block-flow");
  assert.equal(vertical.layoutStrategy.necessity, "lightweight-default");

  const horizontalDesign = design([layer("one", "One", 0, 0), layer("two", "Two", 30, 0)]);
  horizontalDesign.nodes[0].autoLayout = { mode: "HORIZONTAL", primaryAxisAlignItems: "MIN", layoutWrap: "NO_WRAP" };
  assert.equal(semanticPlan(horizontalDesign).containers.find(container => container.id === "root").layoutStrategy.preferred, "inline-flow");

  horizontalDesign.nodes[0].autoLayout = { mode: "HORIZONTAL", primaryAxisAlignItems: "SPACE_BETWEEN", layoutWrap: "NO_WRAP" };
  const flex = semanticPlan(horizontalDesign).containers.find(container => container.id === "root").layoutStrategy;
  assert.equal(flex.preferred, "flex-row");
  assert.equal(flex.necessity, "required");
});

test("overlapping siblings retain paint order instead of unsafe visual sorting", () => {
  const plan = semanticPlan(design([
    layer("foreground", "Foreground", 10, 10),
    layer("background", "Background", 0, 0, [], { absoluteBounds: bounds(0, 0, 100, 100) }),
  ]));
  const root = plan.containers.find(container => container.id === "root");
  assert.equal(root.orderPolicy, "preserve-design-paint-order");
  assert.equal(root.layoutStrategy.preferred, "layered-flow");
  assert.match(root.layoutStrategy.reason, /keep content in normal flow/);
  assert.deepEqual(root.codeOrder, root.designOrder);
});

test("three structurally repeated siblings receive framework and plain HTML loop guidance", () => {
  const plan = semanticPlan(design([
    card("one", 1, 0, 0), card("two", 2, 0, 30), card("three", 3, 0, 60),
  ]));
  assert.equal(plan.repeatGroups.length, 1);
  const repeat = plan.repeatGroups[0];
  assert.equal(repeat.component, "SkillRow");
  assert.deepEqual(repeat.instanceIds, ["one", "two", "three"]);
  assert.match(repeat.frameworkLoop, /skillRows\.map/);
  assert.match(repeat.loopComment.start, /d2c-repeat/);
  assert.match(repeat.loopComment.end, /d2c-repeat-end/);
  assert.equal(repeat.keySource, "data-d2c-id");
});

test("interaction inference separates safe local, callback-only and blocked behavior", () => {
  const plan = semanticPlan(design([
    layer("tabs", "Details Tab", 0, 0),
    layer("search", "Search", 0, 30),
    layer("configure", "Configure Button", 0, 60),
    layer("delete", "Delete Button", 0, 90),
    layer("cn-search", "搜索框", 0, 120),
    layer("cn-delete", "删除按钮", 0, 150),
    { id: "label", name: "Button Label", type: "TEXT", absoluteBounds: bounds(0, 180) },
  ]));
  const byId = new Map(plan.interactions.map(candidate => [candidate.id, candidate]));
  assert.equal(byId.get("tabs").autonomy, "safe-local");
  assert.equal(byId.get("search").kind, "search");
  assert.equal(byId.get("configure").autonomy, "callback-only");
  assert.equal(byId.get("delete").autonomy, "blocked");
  assert.equal(byId.get("cn-search").kind, "search");
  assert.equal(byId.get("cn-delete").autonomy, "blocked");
  assert.equal(byId.has("label"), false);
  assert.equal(plan.summary.safeLocalInteractionCount, 3);
});

test("input controls are inferred with semantic element and style", () => {
  const inputField = (id, name, x, properties = {}) => layer(id, name, x, 0, [
    { id: `${id}-placeholder`, name: "Placeholder", type: "TEXT", characters: "Enter value", absoluteBounds: bounds(x + 4, 6), textColor: { css: "rgba(180,180,180,1)" }, fontSize: 14, fontWeight: 400 },
  ], { fills: [{ type: "SOLID", color: "rgba(255,255,255,1)", visible: true, opacity: 1 }], strokes: [{ type: "SOLID", color: "rgba(218,220,224,1)", visible: true, opacity: 1 }], strokeWeight: 1, cornerRadius: 8, ...properties });
  const plan = semanticPlan(design([
    inputField("email", "Email", 0),
    inputField("pw", "Password", 30),
    inputField("tf", "Text Field", 60),
    inputField("dd", "Dropdown", 90),
    layer("search", "Search", 120, 0),
  ]));
  const byId = new Map(plan.interactions.map(candidate => [candidate.id, candidate]));
  const email = byId.get("email");
  assert.equal(email.kind, "input");
  assert.equal(email.inputInference.controlType, "email");
  assert.equal(email.inputInference.semanticElement, "input[type=email]");
  assert.equal(email.inputInference.style.background, "rgba(255,255,255,1)");
  assert.equal(email.inputInference.style.borderColor, "rgba(218,220,224,1)");
  assert.equal(email.inputInference.style.borderWidth, 1);
  assert.equal(email.inputInference.style.borderRadius, 8);
  assert.equal(email.inputInference.style.placeholderColor, "rgba(180,180,180,1)");
  assert.equal(email.inputInference.placeholder.text, "Enter value");
  assert.equal(byId.get("pw").inputInference.controlType, "password");
  assert.equal(byId.get("pw").inputInference.semanticElement, "input[type=password]");
  assert.equal(byId.get("tf").inputInference.controlType, "text");
  assert.equal(byId.get("dd").kind, "filter");
  assert.equal(byId.get("dd").inputInference.controlType, "select");
  assert.equal(byId.get("dd").inputInference.semanticElement, "select");
  assert.equal(byId.get("search").kind, "search");
  assert.equal(byId.get("search").inputInference.controlType, "search");
  assert.deepEqual(email.guidanceTags, ["input", "input-email"]);
  assert.deepEqual(byId.get("search").guidanceTags, ["search"]);
  assert.deepEqual(byId.get("dd").guidanceTags, ["select"]);
  assert.equal(plan.summary.inputControlCount, 5);
});

test("tab groups infer selected state and per-state styles", () => {
  const tab = (id, name, x, textColor, properties = {}) => layer(id, name, x, 0, [
    { id: `${id}-label`, name, type: "TEXT", characters: name, absoluteBounds: bounds(x, 0), textColor: { css: textColor }, fontSize: 14, fontWeight: 400 },
  ], properties);
  const plan = semanticPlan(design([
    tab("tab1", "Tab 1", 0, "rgba(95,99,104,1)"),
    tab("tab2", "Tab 2", 60, "rgba(95,99,104,1)"),
    tab("tab3", "Tab 3", 120, "rgba(26,115,232,1)", { strokes: [{ type: "SOLID", color: "rgba(26,115,232,1)", visible: true, opacity: 1 }], strokeWeight: 2 }),
  ]));
  const tabs = plan.interactions.filter(candidate => candidate.kind === "tab");
  assert.equal(tabs.length, 3);
  const byId = new Map(tabs.map(candidate => [candidate.id, candidate]));
  const selected = tabs.find(candidate => candidate.tabInference.selected);
  assert.equal(selected.id, "tab3");
  assert.equal(byId.get("tab1").tabInference.groupId, selected.tabInference.groupId);
  assert.equal(selected.tabInference.selectedEvidence.includes("highest visual prominence"), true);
  assert.equal(selected.tabInference.stateStyles.selected.textColor, "rgba(26,115,232,1)");
  assert.equal(selected.tabInference.stateStyles.selected.indicatorColor, "rgba(26,115,232,1)");
  assert.equal(selected.tabInference.stateStyles.unselected.textColor, "rgba(95,99,104,1)");
  assert.equal(byId.get("tab1").tabInference.selected, false);
  assert.deepEqual(byId.get("tab1").guidanceTags, ["tab"]);
  assert.equal(plan.summary.tabGroupCount, 1);
});

test("containers and repeat groups expose guidanceTags for progressive loading", () => {
  const plan = semanticPlan(design([
    card("one", 1, 0, 0), card("two", 2, 0, 30), card("three", 3, 0, 60),
  ]));
  const root = plan.containers.find(container => container.id === "root");
  assert.deepEqual(root.guidanceTags, ["block-flow", "visual-reading-order"]);
  assert.deepEqual(plan.repeatGroups[0].guidanceTags, ["repeat"]);
});
