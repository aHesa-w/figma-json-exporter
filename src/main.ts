#!/usr/bin/env node
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HTTPExporter, SERVER_NAME, SERVER_VERSION } from "./bridge.js";
import { createMCPServer } from "./mcp.js";
import { isLoopback, startServer } from "./server.js";

function positiveInteger(value: string, name: string, max = Number.MAX_SAFE_INTEGER): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) throw new Error(`Invalid ${name}: ${value}`);
  return number;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let mode = "stdio";
  let bridgeOverride = process.env.FIGMA_MCP_BRIDGE_URL;
  for (const arg of args) {
    if (arg.startsWith("--transport=")) mode = arg.slice("--transport=".length);
    else if (arg.startsWith("--bridge-url=")) bridgeOverride = arg.slice("--bridge-url=".length);
    else if (["http", "serve", "stdio"].includes(arg)) mode = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  const host = process.env.FIGMA_AGENT_HOST || "127.0.0.1";
  const port = positiveInteger(process.env.FIGMA_AGENT_PORT || "3456", "FIGMA_AGENT_PORT", 65535);
  if (mode === "http" || mode === "serve") {
    const service = await startServer(host, port);
    console.error(`Figma JSON Exporter ${SERVER_VERSION}: http://${host}:${port}/mcp`);
    process.once("SIGINT", () => void service.close());
    process.once("SIGTERM", () => void service.close());
    return;
  }
  if (mode !== "stdio") throw new Error("Transport must be http or stdio");
  const url = new URL(bridgeOverride || `http://${host === "::1" ? "[::1]" : host}:${port}`);
  const bridgeHost = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || !isLoopback(bridgeHost) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("FIGMA_MCP_BRIDGE_URL must be a local HTTP origin, for example http://127.0.0.1:3456");
  }
  const bridgeURL = url.origin;
  const timeout = positiveInteger(process.env.FIGMA_MCP_START_TIMEOUT_MS || "30000", "FIGMA_MCP_START_TIMEOUT_MS");
  async function healthy(): Promise<boolean> {
    let response: Response;
    try { response = await fetch(bridgeURL + "/health", { signal: AbortSignal.timeout(800) }); }
    catch { return false; }
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.name !== SERVER_NAME || body?.status !== "ok" || body?.version !== SERVER_VERSION) {
      throw new Error(`Port is occupied by an incompatible service at ${bridgeURL}; stop the old server first`);
    }
    return true;
  }
  if (!await healthy()) {
    // Execute this prebuilt bundle; never invoke a compiler/package manager at runtime.
    const child = spawn(process.execPath, [__filename, "--transport=http"], {
      detached: true, stdio: "ignore",
      env: { ...process.env, FIGMA_AGENT_HOST: bridgeHost, FIGMA_AGENT_PORT: url.port || "80" },
    });
    let spawnError: Error | undefined;
    child.on("error", (error) => { spawnError = error; });
    child.unref();
    const deadline = Date.now() + timeout;
    try {
      while (!await healthy()) {
        if (spawnError) throw spawnError;
        if (Date.now() >= deadline) throw new Error(`Local MCP server did not become healthy within ${timeout}ms`);
        await delay(100);
      }
    } catch (error) {
      child.kill();
      throw error;
    }
  }
  const mcp = createMCPServer(new HTTPExporter(bridgeURL));
  await mcp.connect(new StdioServerTransport());
  process.stdin.once("end", () => void mcp.close());
  process.once("SIGINT", () => void mcp.close().then(() => process.exit(0)));
  process.once("SIGTERM", () => void mcp.close().then(() => process.exit(0)));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
