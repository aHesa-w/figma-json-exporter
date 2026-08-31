import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, copyFile, rm, readFile, writeFile, access } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHTTPServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PNG, node, clippedNode, pluginFixture, renderStyle, flowStyle } from "./plugin-fixture.mjs";

async function availablePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "figma-mcp-test-"));
  const entry = join(directory, "mcp-server.js");
  // Prove that runtime needs neither repository sources nor node_modules nor Go.
  await copyFile(new URL("../dist/mcp-server.js", import.meta.url), entry);
  const port = await availablePort();
  const base = `http://127.0.0.1:${port}`;
  const clients = [];
  const sockets = [];
  const env = { FIGMA_AGENT_PORT: String(port), FIGMA_EXPORT_DIR: join(directory, "exports"), FIGMA_VALIDATION_DIR: join(directory, "validation"), FIGMA_MCP_START_TIMEOUT_MS: "5000", PATH: directory };
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await Promise.allSettled(clients.map((client) => client.close()));
    await fetch(base + "/control/shutdown", { method: "POST", signal: AbortSignal.timeout(2000) }).catch(() => {});
    for (let i = 0; i < 40; i++) {
      try { await fetch(base + "/health", { signal: AbortSignal.timeout(100) }); }
      catch { break; }
      await delay(25);
    }
    await rm(directory, { recursive: true, force: true });
  });
  async function client(transport = "stdio") {
    const instance = new Client({ name: "test-client", version: "1.0.0" });
    const connection = transport === "stdio"
      ? new StdioClientTransport({ command: process.execPath, args: [entry], cwd: directory, env, stderr: "pipe" })
      : new StreamableHTTPClientTransport(new URL(base + "/mcp"));
    await instance.connect(connection);
    clients.push(instance);
    return instance;
  }
  async function plugin() {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(socket);
    await once(socket, "open");
    return socket;
  }
  return { base, entry, env, client, plugin };
}

const exportData = (id = "fixture") => ({ meta: { schemaVersion: 3, exporterVersion: "3.4.1" }, assets: {}, nodes: [{ id, name: id, type: "FRAME", absoluteBounds: { x: 10, y: 20, width: 100, height: 100 } }] });
const payload = (result) => JSON.parse(result.content[0].text);

test("standalone compiled entry auto-starts shared service; stdio and HTTP expose MCP tools/errors", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const stdio = await f.client();
  const http = await f.client("http");
  assert.equal((await (await fetch(f.base + "/health")).json()).version, "3.8.0");
  for (const client of [stdio, http]) {
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ["figma_export", "figma_guidance", "figma_status", "figma_validate_layout"]);
    assert.equal(payload(await client.callTool({ name: "figma_status", arguments: {} })).connected, false);
    const guidance = payload(await client.callTool({ name: "figma_guidance", arguments: { tags: ["tab", "unknown-tag"] } }));
    assert.equal(guidance.guidance.tab.title, "Tab interaction");
    assert.match(guidance.guidance.tab.guidance, /tablist\/tab\/tabpanel/);
    assert.deepEqual(guidance.missing, ["unknown-tag"]);
    const catalog = payload(await client.callTool({ name: "figma_guidance", arguments: {} }));
    assert.ok(catalog.availableTags.includes("workflow"));
    assert.ok(catalog.availableTags.includes("subagent"));
    const error = await client.callTool({ name: "figma_export", arguments: {} });
    assert.equal(error.isError, true);
    assert.match(error.content[0].text, /not connected/);
  }
  assert.equal((await fetch(f.base + "/export")).status, 503);
});

test("MCP export round trip executes the real plugin filtering logic", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const client = await f.client();
  const socket = await f.plugin();
  const plugin = pluginFixture([node("root", { children: [node("hidden", { visible: false }), node("zero", { opacity: 0 }), node("visible")] })]);
  socket.on("message", async (raw) => {
    const request = JSON.parse(raw.toString());
    socket.send(JSON.stringify(await plugin.request(request.requestId)));
  });
  assert.equal(payload(await client.callTool({ name: "figma_status", arguments: {} })).connected, true);
  const exported = await client.callTool({ name: "figma_export", arguments: {} });
  assert.notEqual(exported.isError, true);
  assert.deepEqual(payload(exported).nodes[0].children.map((n) => n.id), ["visible"]);
});

test("existing MCP names support Pen status, selection export, Auto Layout geometry and local image assets", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const client = await f.client();
  const penDir = join(f.env.FIGMA_EXPORT_DIR, "pen-source");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(penDir, { recursive: true }));
  await writeFile(join(penDir, "photo.png"), PNG);
  const penPath = join(penDir, "screen.pen");
  await writeFile(penPath, JSON.stringify({
    version: "2.17",
    themes: { mode: ["light", "dark"] },
    variables: { background: { type: "color", value: [{ value: "#ffffffff", theme: { mode: "light" } }, { value: "#000000ff", theme: { mode: "dark" } }] } },
    children: [
      { type: "frame", id: "button-component", name: "Button", reusable: true, width: 100, height: 30, layout: "horizontal", children: [{ type: "text", id: "button-label", width: 100, height: 30, content: "Default", fill: "#000000ff" }] },
      { type: "frame", id: "screen", name: "Screen", x: 100, y: 200, width: 300, height: 200, layout: "vertical", padding: 10, gap: 5, clip: true, opacity: 0.8, fill: "$background", children: [
      { type: "text", id: "title", width: 280, height: 20, content: "Pen page", fontFamily: "Arial", fontSize: 16, fontWeight: "500", lineHeight: 1.25, fill: "#112233ff" },
      { type: "rectangle", id: "hidden", enabled: false, width: 280, height: 99, fill: "#ff0000" },
      { type: "frame", id: "row", width: "fill_container", height: 50, layout: "horizontal", gap: 10, children: [
        { type: "rectangle", id: "photo", width: 50, height: 50, fill: { type: "image", url: "./photo.png", mode: "fill" } },
        { type: "rectangle", id: "shape", width: 20, height: 50, cornerRadius: [1, 2, 3, 4], fill: { type: "gradient", gradientType: "linear", rotation: 90, colors: [{ color: "#ff0000ff", position: 0 }, { color: "#0000ffff", position: 1 }] } },
      ] },
      { type: "ref", id: "submit", ref: "button-component", descendants: { "button-label": { content: "Submit" } } },
    ] },
      { type: "text", id: "dynamic", x: 500, y: 0, width: "fit_content", height: "fit_content", content: "Engine sized", fill: "#000000ff" },
      { type: "ellipse", id: "complex", x: 700, y: 0, width: 1, height: 1, fill: { type: "gradient", gradientType: "radial", colors: [{ color: "#ffffffff", position: 0 }, { color: "#000000ff", position: 1 }] } },
    ],
  }));
  const status = payload(await client.callTool({ name: "figma_status", arguments: { mode: "pen", penPath } }));
  assert.equal(status.connected, true);
  assert.equal(status.mode, "pen");
  assert.equal(status.topLevelNodes.find(node => node.id === "screen").name, "Screen");
  const exported = await client.callTool({ name: "figma_export", arguments: { mode: "pen", penPath, nodeIds: ["screen"] } });
  assert.notEqual(exported.isError, true, exported.content[0].text);
  const saved = payload(exported);
  assert.equal(saved.meta.sourceMode, "pen");
  assert.equal(saved.meta.sourceVersion, "2.17");
  assert.deepEqual(saved.nodes[0].absoluteBounds, { x: 100, y: 200, width: 300, height: 200, left: 100, top: 200, right: 400, bottom: 400 });
  assert.deepEqual(saved.nodes[0].children.map(node => node.id), ["title", "row", "submit"]);
  assert.deepEqual(saved.nodes[0].children[0].absoluteBounds, { x: 110, y: 210, width: 280, height: 20, left: 110, top: 210, right: 390, bottom: 230 });
  const row = saved.nodes[0].children[1];
  assert.deepEqual(row.absoluteBounds, { x: 110, y: 235, width: 280, height: 50, left: 110, top: 235, right: 390, bottom: 285 });
  assert.equal(row.children[1].gradient.angleDeg, 270);
  assert.match(row.children[1].gradient.css, /^linear-gradient\(270deg/);
  const button = saved.nodes[0].children[2];
  assert.equal(button.id, "submit");
  assert.equal(button.children[0].id, "submit/button-label");
  assert.equal(button.children[0].characters, "Submit", JSON.stringify(button.children[0]));
  const imageId = row.children[0].fills[0].imageHash;
  assert.equal(saved.assets[imageId].mimeType, "image/png");
  await access(saved.assets[imageId].path);
  assert.equal((await readFile(saved.assets[imageId].path)).equals(PNG), true);
  assert.match(saved.meta.exportDirectory, /export-/);
  const unresolved = await client.callTool({ name: "figma_export", arguments: { mode: "pen", penPath, nodeIds: ["dynamic"] } });
  assert.equal(unresolved.isError, true);
  assert.match(unresolved.content[0].text, /unresolved size/);
  const bounded = payload(await client.callTool({ name: "figma_export", arguments: { mode: "pen", penPath, nodeIds: ["dynamic"], penBounds: [{ id: "dynamic", x: 500, y: 0, width: 96.5, height: 24 }] } }));
  assert.equal(bounded.nodes[0].absoluteBounds.width, 96.5);
  const unsupported = await client.callTool({ name: "figma_export", arguments: { mode: "pen", penPath, nodeIds: ["complex"] } });
  assert.equal(unsupported.isError, true);
  assert.match(unsupported.content[0].text, /requires raster export/);
  const rasterized = payload(await client.callTool({ name: "figma_export", arguments: { mode: "pen", penPath, nodeIds: ["complex"], penRasters: [{ id: "complex", path: join(penDir, "photo.png"), scale: 1, bounds: { id: "complex", x: 700, y: 0, width: 1, height: 1 } }] } }));
  assert.equal(rasterized.nodes[0].renderAs, "image");
  assert.equal(rasterized.nodes[0].imageBoundsSource, "pen-engine-raster");
  const wrongMode = await client.callTool({ name: "figma_validate_layout", arguments: { mode: "figma", designPath: saved.meta.designPath, actualPath: join(penDir, "not-read.json") } });
  assert.equal(wrongMode.isError, true);
  assert.match(wrongMode.content[0].text, /does not match design source pen/);
});

test("multiple clients reuse one service and exports are serialized with request isolation", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const first = await f.client();
  const second = await f.client();
  const socket = await f.plugin();
  const requests = [];
  let outstanding = 0;
  let maxOutstanding = 0;
  socket.on("message", (raw) => {
    const request = JSON.parse(raw.toString());
    requests.push(request.requestId);
    outstanding++;
    maxOutstanding = Math.max(maxOutstanding, outstanding);
    socket.send(JSON.stringify({ type: "done", requestId: "stale-id", data: exportData() }));
    setTimeout(() => {
      outstanding--;
      socket.send(JSON.stringify({ type: "done", requestId: request.requestId, data: exportData(request.requestId) }));
    }, 30);
  });
  const results = await Promise.all([first, second, first].map((client) => client.callTool({ name: "figma_export", arguments: {} })));
  assert.equal(maxOutstanding, 1);
  assert.equal(new Set(requests).size, 3);
  assert.deepEqual(results.map((result) => payload(result).nodes[0].id).sort(), requests.sort());
});

test("disconnect fails active and queued requests, then reconnect restores exports", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const client = await f.client();
  const socket = await f.plugin();
  const received = once(socket, "message");
  const pending = [client.callTool({ name: "figma_export", arguments: {} }), client.callTool({ name: "figma_export", arguments: {} })];
  await received;
  socket.terminate();
  for (const result of await Promise.all(pending)) assert.equal(result.isError, true);
  const next = await f.plugin();
  next.on("message", (raw) => {
    const request = JSON.parse(raw.toString());
    next.send(JSON.stringify({ type: "done", requestId: request.requestId, data: exportData() }));
  });
  assert.notEqual((await client.callTool({ name: "figma_export", arguments: {} })).isError, true);
});

test("REST abort removes queued work and does not interfere with an active export", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const client = await f.client();
  const socket = await f.plugin();
  const received = once(socket, "message");
  const first = client.callTool({ name: "figma_export", arguments: {} });
  const [raw] = await received;
  const request = JSON.parse(raw.toString());
  let sent = 0;
  socket.on("message", () => sent++);
  const controller = new AbortController();
  const aborted = fetch(f.base + "/export", { signal: controller.signal });
  await delay(40);
  controller.abort();
  await assert.rejects(aborted);
  await delay(40);
  socket.send(JSON.stringify({ type: "done", requestId: request.requestId, data: exportData() }));
  assert.notEqual((await first).isError, true);
  await delay(40);
  assert.equal(sent, 0);
});

test("compiled HTTP entry supports shutdown and rejects non-local bind addresses", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const child = spawn(process.execPath, [f.entry, "--transport=http"], { env: f.env, stdio: "pipe" });
  const exited = once(child, "exit");
  t.after(() => child.kill());
  let healthy = false;
  for (let i = 0; i < 80; i++) {
    try { healthy = (await fetch(f.base + "/health")).ok; } catch {}
    if (healthy) break;
    await delay(50);
  }
  assert.equal(healthy, true);
  assert.equal((await fetch(f.base + "/control/shutdown")).status, 405);
  assert.equal((await fetch(f.base + "/control/shutdown", { method: "POST" })).status, 202);
  assert.equal((await exited)[0], 0);
  const invalid = spawn(process.execPath, [f.entry, "--transport=http"], { env: { ...f.env, FIGMA_AGENT_HOST: "0.0.0.0" }, stdio: "pipe" });
  let stderr = "";
  invalid.stderr.on("data", (chunk) => { stderr += chunk; });
  assert.equal((await once(invalid, "exit"))[0], 1);
  assert.match(stderr, /only supports loopback/);
});

test("simultaneous stdio startups converge on a single shared service", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const clients = await Promise.all([f.client(), f.client(), f.client()]);
  for (const client of clients) {
    assert.equal(payload(await client.callTool({ name: "figma_status", arguments: {} })).connected, false);
  }
  assert.equal((await fetch(f.base + "/health")).status, 200);
});

test("replacing a connected plugin fails old work and accepts the replacement", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const client = await f.client();
  const original = await f.plugin();
  const received = once(original, "message");
  const pending = client.callTool({ name: "figma_export", arguments: {} });
  await received;
  const replacement = await f.plugin();
  const failed = await pending;
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /reconnected/);
  replacement.on("message", (raw) => {
    const request = JSON.parse(raw.toString());
    replacement.send(JSON.stringify({ type: "done", requestId: request.requestId, data: exportData("replacement") }));
  });
  assert.equal(payload(await client.callTool({ name: "figma_export", arguments: {} })).nodes[0].id, "replacement");
});

test("entry detects an old service without terminating or silently reusing it", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const old = createHTTPServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "ok", name: "figma-json-exporter", version: "1.1.0" }));
  });
  old.listen(Number(new URL(f.base).port), "127.0.0.1");
  await once(old, "listening");
  t.after(() => { old.closeAllConnections(); old.close(); });
  const child = spawn(process.execPath, [f.entry], { env: f.env, stdio: "pipe" });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  assert.equal((await once(child, "exit"))[0], 1);
  assert.match(stderr, /incompatible service/);
  assert.equal((await (await fetch(f.base + "/health")).json()).version, "1.1.0");
});

test("MCP returns real local image paths only after bytes are written, and validates subsequent DOM measurements", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const client = await f.client();
  const socket = await f.plugin();
  const fixturePlugin = pluginFixture([node("root", { clipsContent: true, opacity: 0.6, cornerRadius: 12, fills: [{ type: "GRADIENT_LINEAR", gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 1, a: 0.5 } }] }], children: [node("icon", { type: "GROUP", children: [node("vector", { type: "VECTOR" })] }), clippedNode("photo", { fills: [{ type: "IMAGE", imageHash: "photo" }] }, { x: -4, y: -6, width: 112, height: 116 }), node("text", { type: "TEXT", lineHeight: { unit: "AUTO" }, async getCSSAsync() { return { "line-height": "21.5px" }; } })] })]);
  socket.on("message", async (raw) => {
    const request = JSON.parse(raw.toString());
    await fixturePlugin.request(request.requestId);
    for (const message of fixturePlugin.messages) socket.send(JSON.stringify(message));
  });
  const outputDir = join(f.env.FIGMA_EXPORT_DIR, "中文图片");
  const exported = await client.callTool({ name: "figma_export", arguments: { outputDir } });
  assert.notEqual(exported.isError, true, exported.content[0].text);
  const saved = payload(exported);
  assert.equal(saved.meta.exportDirectory.startsWith(outputDir + "/"), true);
  assert.equal(Object.keys(saved.assets).length, 3);
  assert.equal(saved.nodes[0].gradient.angleDeg, 90);
  const layout = JSON.parse(await readFile(saved.meta.layoutPath, "utf8"));
  assert.deepEqual(layout[0].gradient, saved.nodes[0].gradient);
  const recovered = saved.nodes[0].children[1];
  assert.equal(recovered.imageBoundsSource, "isolated-clone");
  assert.equal(recovered.imagePlacement.x, -4);
  assert.equal(recovered.imagePlacement.y, -6);
  assert.equal(saved.assets[recovered.assetId].pixelWidth, 224);
  assert.equal(saved.assets[recovered.assetId].pixelHeight, 232);
  assert.equal(layout.find(n => n.id === "photo").imageBoundsSource, "isolated-clone");
  const plan = JSON.parse(await readFile(saved.meta.flowPlanPath, "utf8"));
  assert.deepEqual(plan.stages, ["baseline", "flow"]);
  const semantic = JSON.parse(await readFile(saved.meta.semanticPlanPath, "utf8"));
  assert.equal(semantic.summary.containerCount, 1);
  assert.match(semantic.instructions, /semantic-plan\.json/);
  const styles = JSON.parse(await readFile(saved.meta.stylePlanPath, "utf8"));
  assert.equal(styles.outputContract.cssFileRequired, true);
  assert.equal(styles.outputContract.staticInlineStyles, "forbidden");
  for (const asset of Object.values(saved.assets)) { await access(asset.path); assert.equal((await readFile(asset.path)).length, asset.byteLength); }
  const measured = { sampleId: "mcp-baseline", collectedAt: new Date().toISOString(), viewport: { width: 1200, height: 900, devicePixelRatio: 1 }, collectorVersion: 5, coordinateSpace: "root-relative", stable: true, fontsReady: true, brokenImages: [], nodes: [saved.nodes[0], ...saved.nodes[0].children].map((n) => ({ id: n.id, rootId: n.rootId, parentId: n.parentId, visible: true, bounds: n.relativeBounds, tagName: n.assetId ? "IMG" : "DIV", imageSources: n.assetId ? [saved.assets[n.assetId].path] : [], textStyle: n.type === "TEXT" ? { fontSize: n.fontSize, lineHeight: n.lineHeight.pixels, fontWeight: n.fontWeight, fontStyle: "normal", letterSpacing: 0, textAlign: "left", direction: "ltr", textDecorationLine: "none", color: n.textColor.css, textFillColor: n.textColor.css } : undefined, assetImages: n.assetId ? [{ assetId: n.assetId, src: saved.assets[n.assetId].path, bounds: n.relativeImageBounds, naturalWidth: saved.assets[n.assetId].pixelWidth, naturalHeight: saved.assets[n.assetId].pixelHeight, opacity: 1, objectFit: "fill" }] : [], renderStyle: renderStyle(n.id === "root" ? { ...n.gradient, backgroundImage: n.gradient.css, opacity: 0.6, overflowX: "hidden", overflowY: "hidden", cornerRadii: Array(4).fill("12px") } : {}) })) };
  // Synthetic measurements exercise the MCP comparison API, not browser rendering.
  measured.nodes[1].bounds = { ...measured.nodes[1].bounds, x: 10 };
  const failed = payload(await client.callTool({ name: "figma_validate_layout", arguments: { designPath: saved.meta.designPath, actual: measured } }));
  assert.equal(failed.passed, false);
  assert.equal(failed.failed[0].id, "icon");
  measured.nodes[1].bounds.x = 0;
  const actualPath = join(saved.meta.exportDirectory, "synthetic-actual.json");
  await writeFile(actualPath, JSON.stringify(measured));
  const passed = payload(await client.callTool({ name: "figma_validate_layout", arguments: { designPath: saved.meta.designPath, actualPath } }));
  assert.equal(passed.passed, true);
  assert.equal(passed.visualAcceptance, "not-verified");
  assert.equal(passed.workflowComplete, false);
  assert.equal(passed.phase, "baseline");
  await access(passed.reportPath);
  // Exercise inline schema retention as well as the actualPath route above.
  const inlinePassed = payload(await client.callTool({ name: "figma_validate_layout", arguments: { designPath: saved.meta.designPath, actual: measured } }));
  assert.equal(inlinePassed.passed, true);
  measured.nodes[0].renderStyle.overflowY = "visible";
  const propertyFailed = payload(await client.callTool({ name: "figma_validate_layout", arguments: { designPath: saved.meta.designPath, actual: measured } }));
  assert.equal(propertyFailed.passed, false);
  assert.equal(propertyFailed.failed[0].propertyMismatches[0].property, "clipsContent");
  measured.nodes[0].renderStyle.overflowY = "hidden";
  measured.nodes[3].textStyle.color = "rgb(255, 0, 0)";
  const wrongColor = payload(await client.callTool({ name: "figma_validate_layout", arguments: { designPath: saved.meta.designPath, actual: measured } }));
  assert.equal(wrongColor.passed, false);
  assert.equal(wrongColor.failed[0].propertyMismatches[0].property, "textColor.color");
  measured.nodes[3].textStyle.color = saved.nodes[0].children[2].textColor.css;
  measured.nodes[0].renderStyle.backgroundImage = saved.nodes[0].gradient.css.replace("90deg", "180deg");
  const wrongGradient = payload(await client.callTool({ name: "figma_validate_layout", arguments: { designPath: saved.meta.designPath, actual: measured } }));
  assert.equal(wrongGradient.passed, false);
  assert.equal(wrongGradient.failed[0].propertyMismatches[0].property, "gradient-direction");
  measured.nodes[0].renderStyle.backgroundImage = saved.nodes[0].gradient.css;
  const flowArgs = { designPath: saved.meta.designPath, actual: measured, phase: "flow", baselineReportPath: passed.reportPath };
  const reused = await client.callTool({ name: "figma_validate_layout", arguments: flowArgs });
  assert.equal(reused.isError, true);
  assert.match(reused.content[0].text, /new browser sample/);
  await delay(3);
  measured.sampleId = "mcp-new-flow-sample";
  measured.collectedAt = new Date().toISOString();
  for (const n of measured.nodes) n.flowStyle = flowStyle();
  measured.nodes[3].renderStyle.position = measured.nodes[3].flowStyle.position = "absolute";
  const absoluteFlow = payload(await client.callTool({ name: "figma_validate_layout", arguments: flowArgs }));
  assert.equal(absoluteFlow.passed, false);
  assert.equal(absoluteFlow.flowMismatches[0].id, "text");
  measured.nodes[3].renderStyle.position = measured.nodes[3].flowStyle.position = "relative";
  const flowPassed = payload(await client.callTool({ name: "figma_validate_layout", arguments: flowArgs }));
  assert.equal(flowPassed.phase, "flow");
  assert.equal(flowPassed.workflowComplete, true);
  await writeFile(actualPath, JSON.stringify(measured));
  const fileFlow = payload(await client.callTool({ name: "figma_validate_layout", arguments: { designPath: saved.meta.designPath, actualPath, phase: "flow", baselineReportPath: passed.reportPath } }));
  assert.equal(fileFlow.workflowComplete, true);
  const missingBaseline = await client.callTool({ name: "figma_validate_layout", arguments: { designPath: saved.meta.designPath, actual: measured, phase: "flow" } });
  assert.equal(missingBaseline.isError, true);
});
