import { createServer, type ServerResponse } from "node:http";
import { WebSocketServer } from "ws";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Bridge, SERVER_NAME, SERVER_VERSION } from "./bridge.js";
import { createMCPServer } from "./mcp.js";
import type { ExportOptions } from "./assets.js";
import { isAbsolute } from "node:path";

export function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "::ffff:127.0.0.1";
}

export async function startServer(host: string, port: number) {
  if (!isLoopback(host)) throw new Error("This local MCP server only supports loopback listen addresses");
  const bridge = new Bridge();
  const websocket = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 * 1024 });
  const sessions = new Set<ReturnType<typeof createMCPServer>>();
  const json = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };
  const server = createServer(async (req, res) => {
    try {
      // Reject foreign Host headers (including browser DNS rebinding).
      const target = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (!isLoopback(target.hostname.replace(/^\[|\]$/g, ""))) {
        json(res, 403, { error: "Only localhost requests are allowed" });
        return;
      }
      const path = target.pathname;
      if (path === "/mcp") {
        // Stateless HTTP requires a separate transport/server for each request.
        const mcp = createMCPServer(bridge);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        sessions.add(mcp);
        res.on("close", () => { sessions.delete(mcp); void mcp.close(); });
        await mcp.connect(transport);
        await transport.handleRequest(req, res);
        return;
      }
      if (path === "/control/shutdown") {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
        if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
        if (req.method !== "POST") { res.setHeader("Allow", "POST, OPTIONS"); json(res, 405, { error: "Method not allowed" }); return; }
        if (!isLoopback(req.socket.remoteAddress || "")) { json(res, 403, { error: "Shutdown is only allowed from localhost" }); return; }
        json(res, 202, { status: "shutting_down" });
        setTimeout(() => void close(), 50);
        return;
      }
      if (!["/health", "/status", "/export"].includes(path)) { json(res, 404, { error: "Not found" }); return; }
      const methods = path === "/export" ? ["GET", "POST"] : ["GET"];
      if (!methods.includes(req.method || "")) { res.setHeader("Allow", methods.join(", ")); json(res, 405, { error: "Method not allowed" }); return; }
      if (path === "/health") json(res, 200, { status: "ok", name: SERVER_NAME, version: SERVER_VERSION });
      else if (path === "/status") json(res, 200, { connected: await bridge.connected(), pluginName: "Figma JSON Exporter" });
      else {
        const controller = new AbortController();
        res.on("close", () => controller.abort());
        let options: ExportOptions = {};
        if (req.method === "POST") {
          const chunks: Buffer[] = [];
          let byteLength = 0;
          for await (const chunk of req) {
            byteLength += chunk.length;
            if (byteLength > 16_384) throw new Error("Export options exceed 16KB");
            chunks.push(chunk);
          }
          const body = Buffer.concat(chunks).toString("utf8");
          if (body) options = JSON.parse(body);
          if (!options || typeof options !== "object" || Array.isArray(options) || (options.outputDir !== undefined && (typeof options.outputDir !== "string" || !isAbsolute(options.outputDir))) || (options.shapeGroupsAsImages !== undefined && typeof options.shapeGroupsAsImages !== "boolean")) throw new Error("Invalid export options");
        }
        json(res, 200, await bridge.export(controller.signal, options));
      }
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes("not connected") ? 503 : message.includes("timed out") ? 504 : 500;
      json(res, status, { error: message });
    }
  });
  server.headersTimeout = 10_000;
  server.on("upgrade", (req, socket, head) => {
    try {
      const hostHeader = new URL(`http://${req.headers.host || "localhost"}`).hostname.replace(/^\[|\]$/g, "");
      if (req.url !== "/ws" || !isLoopback(hostHeader)) { socket.destroy(); return; }
    } catch { socket.destroy(); return; }
    // Figma's sandbox may have a null origin; this bridge is loopback only.
    websocket.handleUpgrade(req, socket, head, (connection) => bridge.attach(connection));
  });
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    return closing ??= (async () => {
      bridge.close();
      for (const client of websocket.clients) client.terminate();
      await Promise.allSettled([...sessions].map((session) => session.close()));
      await new Promise<void>((resolve) => websocket.close(() => resolve()));
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    })();
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.removeListener("error", reject); resolve(); });
  });
  return { close, server };
}
