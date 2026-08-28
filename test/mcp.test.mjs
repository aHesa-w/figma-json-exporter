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
import { node, pluginFixture } from "./plugin-fixture.mjs";

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

const exportData = (id = "fixture") => ({ meta: { schemaVersion: 3, exporterVersion: "3.1.0" }, assets: {}, nodes: [{ id, name: id, type: "FRAME", absoluteBounds: { x: 10, y: 20, width: 100, height: 100 } }] });
const payload = (result) => JSON.parse(result.content[0].text);

test("standalone compiled entry auto-starts shared service; stdio and HTTP expose MCP tools/errors", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const stdio = await f.client();
  const http = await f.client("http");
  assert.equal((await (await fetch(f.base + "/health")).json()).version, "3.1.0");
  for (const client of [stdio, http]) {
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), ["figma_export", "figma_status", "figma_validate_layout"]);
    assert.equal(payload(await client.callTool({ name: "figma_status", arguments: {} })).connected, false);
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
  const fixturePlugin = pluginFixture([node("root", { children: [node("icon", { type: "GROUP", children: [node("vector", { type: "VECTOR" })] }), node("photo", { fills: [{ type: "IMAGE", imageHash: "photo" }] })] })]);
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
  for (const asset of Object.values(saved.assets)) { await access(asset.path); assert.equal((await readFile(asset.path)).length, asset.byteLength); }
  const measured = { coordinateSpace: "root-relative", stable: true, fontsReady: true, brokenImages: [], nodes: [saved.nodes[0], ...saved.nodes[0].children].map((n) => ({ id: n.id, rootId: n.rootId, parentId: n.parentId, visible: true, bounds: n.relativeBounds, tagName: n.assetId ? "IMG" : "DIV", imageSources: n.assetId ? [saved.assets[n.assetId].path] : [] })) };
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
  await access(passed.reportPath);
});
