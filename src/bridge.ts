import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { persistExport, type ExportOptions } from "./assets.js";
import { exportPen, penStatus } from "./pen.js";

export const SERVER_NAME = "figma-json-exporter";
export const SERVER_VERSION = "3.12.1";
export const EXPORT_TIMEOUT_MS = 120_000;

export interface Exporter {
  status(signal?: AbortSignal, options?: Pick<ExportOptions, "mode" | "penPath">): Promise<Record<string, unknown>>;
  export(signal?: AbortSignal, options?: ExportOptions): Promise<unknown>;
}

interface ExportJob {
  id: string;
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
  assets: Map<string, Buffer>;
  assetBytes: number;
  options: ExportOptions;
  controller: AbortController;
  completing: boolean;
}

export class Bridge implements Exporter {
  private plugin?: WebSocket;
  private active?: ExportJob;
  private queue: ExportJob[] = [];

  async status(_signal?: AbortSignal, options: Pick<ExportOptions, "mode" | "penPath"> = {}): Promise<Record<string, unknown>> {
    if (options.mode === "pen") return penStatus(options.penPath);
    return { connected: this.plugin?.readyState === WebSocket.OPEN, mode: "figma", pluginName: "Figma JSON Exporter" };
  }

  attach(plugin: WebSocket): void {
    const previous = this.plugin;
    // Fail old work before accepting exports on the replacement connection.
    this.plugin = undefined;
    this.failAll(new Error("Figma plugin reconnected while an export was running"));
    previous?.terminate();
    this.plugin = plugin;
    plugin.on("error", () => plugin.terminate());
    plugin.on("close", () => {
      if (this.plugin !== plugin) return;
      this.plugin = undefined;
      this.failAll(new Error("Figma plugin disconnected"));
    });
    plugin.on("message", (raw) => {
      if (this.plugin !== plugin) return;
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || msg.requestId !== this.active?.id) return;
      const job = this.active!;
      if (job.completing) return;
      if (msg.type === "image") {
        if (typeof msg.hash !== "string" || !msg.hash || !Array.isArray(msg.bytes) || msg.bytes.length > 32 * 1024 * 1024 || !msg.bytes.every((n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255)) {
          this.finish(new Error("Invalid image payload"));
          return;
        }
        if (job.assets.has(msg.hash)) { this.finish(new Error("Duplicate image payload")); return; }
        job.assetBytes += msg.bytes.length;
        if (job.assetBytes > 128 * 1024 * 1024) { this.finish(new Error("Export image payload exceeds 128MB")); return; }
        job.assets.set(msg.hash, Buffer.from(msg.bytes));
        return;
      }
      if (msg.type === "done") {
        if (!msg.data || !Array.isArray(msg.data.nodes)) {
          this.finish(new Error("Figma plugin returned invalid export data"));
        } else {
          job.completing = true;
          void persistExport(msg.data, job.assets, job.options, job.controller.signal).then(
            (data) => { if (this.active === job) this.finish(undefined, data); },
            (error) => { if (this.active === job) this.finish(error); },
          );
        }
      } else if (msg.type === "error") {
        this.finish(new Error(String(msg.message || "Figma export failed")));
      }
    });
  }

  export(signal?: AbortSignal, options: ExportOptions = {}): Promise<unknown> {
    if (options.mode === "pen") return exportPen(signal, options);
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("Export cancelled"));
      if (this.plugin?.readyState !== WebSocket.OPEN) {
        return reject(new Error("Figma plugin is not connected; open Figma and run JSON Exporter"));
      }
      const cancel = (error: Error) => {
        if (this.active === job) this.finish(error);
        else {
          this.queue = this.queue.filter((queued) => queued !== job);
          job.cleanup();
          reject(error);
        }
      };
      const abort = () => cancel(new Error("Export cancelled"));
      const timer = setTimeout(() => cancel(new Error("Export timed out (120s)")), EXPORT_TIMEOUT_MS);
      const job: ExportJob = {
        id: randomUUID(), resolve, reject,
        options, assets: new Map(), assetBytes: 0, controller: new AbortController(), completing: false,
        cleanup: () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); },
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }

  private pump(): void {
    if (this.active || !this.queue.length) return;
    if (this.plugin?.readyState !== WebSocket.OPEN) {
      this.failAll(new Error("Figma plugin is not connected"));
      return;
    }
    const job = this.queue.shift()!;
    this.active = job;
    this.plugin.send(JSON.stringify({ type: "export", requestId: job.id, shapeGroupsAsImages: job.options.shapeGroupsAsImages !== false }), (error) => {
      if (error && this.active === job) this.finish(error);
    });
  }

  private finish(error?: Error, data?: unknown): void {
    const job = this.active;
    if (!job) return;
    this.active = undefined;
    job.cleanup();
    if (error) { job.controller.abort(); job.reject(error); }
    else job.resolve(data);
    this.pump();
  }

  private failAll(error: Error): void {
    const jobs = [...(this.active ? [this.active] : []), ...this.queue];
    this.active = undefined;
    this.queue = [];
    for (const job of jobs) { job.controller.abort(); job.cleanup(); job.reject(error); }
  }

  close(): void {
    const plugin = this.plugin;
    this.plugin = undefined;
    this.failAll(new Error("Figma MCP server is shutting down"));
    plugin?.terminate();
  }
}

export class HTTPExporter implements Exporter {
  constructor(private readonly baseURL: string) {}

  private async request(path: string, signal?: AbortSignal, options?: ExportOptions): Promise<any> {
    const timeout = AbortSignal.timeout(EXPORT_TIMEOUT_MS + 5_000);
    const response = await fetch(this.baseURL + path, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      ...(options ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(options) } : {}),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `Bridge returned HTTP ${response.status}`);
    return body;
  }

  async status(signal?: AbortSignal, options: Pick<ExportOptions, "mode" | "penPath"> = {}): Promise<Record<string, unknown>> {
    const query = new URLSearchParams();
    if (options.mode) query.set("mode", options.mode);
    if (options.penPath) query.set("penPath", options.penPath);
    return this.request("/status" + (query.size ? `?${query}` : ""), signal);
  }

  async export(signal?: AbortSignal, options: ExportOptions = {}): Promise<unknown> {
    const data = await this.request("/export", signal, options);
    if (!data || !Array.isArray(data.nodes)) throw new Error("Bridge returned invalid export data");
    return data;
  }
}
