import { readFileSync } from "node:fs";
import vm from "node:vm";
import { deflateSync } from "node:zlib";

const code = readFileSync(new URL("../code.js", import.meta.url), "utf8");

export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
export function png(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const size = Buffer.alloc(4), tail = Buffer.alloc(4); size.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, body, tail]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([PNG.subarray(0, 8), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk("IEND", Buffer.alloc(0))]);
}
// Synthetic browser style samples for protocol/unit tests, not visual evidence.
export const flowStyle = (overrides = {}) => ({ display: "block", position: "relative", cssFloat: "none", insets: Array(4).fill("auto"), margins: Array(4).fill("0px"), transform: "none", translate: "none", wrappers: [], ...overrides });
export const renderStyle = (overrides = {}) => ({ opacity: 1, position: "relative", overflowX: "visible", overflowY: "visible", clipPath: "none", maskImage: "none", contain: "none", borderBoxWidth: 100, borderBoxHeight: 100, cornerRadii: ["0px", "0px", "0px", "0px"], wrapperEffects: [], ...overrides });
let cloneSerial = 0;
function attachNode(node, parent) {
  if (arguments.length > 1) node.parent = parent;
  node.removed ??= false;
  node.appendChild ??= function(child) { this.insertChild((this.children ??= []).length, child); };
  node.insertChild ??= function(index, child) {
    if (!Array.isArray(this.children)) this.children = [];
    if (child.parent?.children) child.parent.children = child.parent.children.filter(item => item !== child);
    this.children.splice(index, 0, child); child.parent = this;
  };
  node.remove ??= function() {
    if (this.parent?.children && !this.parent.retainRemovedChildren) this.parent.children = this.parent.children.filter(item => item !== this);
    this.removed = true; this.parent = null;
  };
  for (const child of node.children ?? []) attachNode(child, node);
  return node;
}
export function node(id, properties = {}) {
  const value = { id, name: id, type: "FRAME", visible: true, opacity: 1, x: 0, y: 0, width: 100, height: 100,
    ...(properties.type === "TEXT" ? { fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 } }], fontName: { family: "Arial", style: "Regular" }, fontSize: 16, letterSpacing: { unit: "PIXELS", value: 0 }, textDecoration: "NONE", lineHeight: { unit: "PIXELS", value: 16 } } : {}),
    get absoluteTransform() { return [[1, 0, this.x], [0, 1, this.y]]; },
    get absoluteRenderBounds() {
      if (this.absoluteBoundingBox) return this.absoluteBoundingBox;
      const t = this.absoluteTransform;
      const points = [[0, 0], [this.width, 0], [0, this.height], [this.width, this.height]].map(([x, y]) => [t[0][0] * x + t[0][1] * y + t[0][2], t[1][0] * x + t[1][1] * y + t[1][2]]);
      const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
      return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    },
    clone() {
      const copied = {};
      for (const key of Object.keys(this)) {
        if (["id", "parent", "removed", "children", "clone", "appendChild", "insertChild", "remove"].includes(key) || typeof this[key] === "function") continue;
        copied[key] = this[key];
      }
      copied.children = (this.children ?? []).map(child => child.clone());
      return node(`${this.id}-copy-${++cloneSerial}`, copied);
    },
    async exportAsync() { const b = this.absoluteBoundingBox ?? this.absoluteRenderBounds; return new Uint8Array(png(Math.ceil(b.width * 2), Math.ceil(b.height * 2))); }, ...properties };
  return attachNode(value);
}

// Model a node culled by its original ancestor, readable only after reparenting
// its clone under an unclipped frame. This is not a live Figma measurement.
export function clippedNode(id, properties, isolatedBounds) {
  return node(id, { ...properties, absoluteRenderBounds: null,
    clone() {
      const clone = node(`${id}-clone`, { ...properties, removed: false, remove() { this.removed = true; } });
      Object.defineProperty(clone, "absoluteRenderBounds", { get() {
        if (!this.parent || this.parent.clipsContent) return null;
        return typeof isolatedBounds === "function" ? isolatedBounds(this) : isolatedBounds;
      } });
      return clone;
    },
    async exportAsync() { throw new Error("Must export the isolated clone, not the clipped original"); },
  });
}

export function pluginFixture(selection, options = {}) {
  const imageReads = [];
  const messages = [];
  let complete;
  const frames = [];
  const pageRoots = [];
  for (const selected of selection) {
    let root = selected;
    while (root.parent && root.parent.type !== "PAGE") root = root.parent;
    if (!pageRoots.includes(root)) pageRoots.push(root);
  }
  const currentPage = attachNode({ id: "page", name: "Page", type: "PAGE", children: pageRoots, selection: [...selection] });
  const figma = {
    root: { documentColorProfile: options.documentColorProfile ?? "SRGB" },
    variables: { async getVariableCollectionByIdAsync(id) { return options.missingVariableCollection ? null : { id }; } },
    mixed: Symbol("mixed"), showUI() {}, closePlugin() {}, async loadFontAsync(font) { if (options.unavailableFont) throw new Error(`Unavailable font ${font.family}`); }, commitUndo() { this.undoCommits = (this.undoCommits ?? 0) + 1; },
    currentPage,
    viewport: { scrollAndZoomIntoView(nodes) { this.lastNodes = nodes; } },
    group(nodes, parent, index = parent.children.length) {
      const bounds = nodes.reduce((box, child) => ({
        left: Math.min(box.left, child.x), top: Math.min(box.top, child.y),
        right: Math.max(box.right, child.x + child.width), bottom: Math.max(box.bottom, child.y + child.height),
      }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
      const group = node(`group-copy-${++cloneSerial}`, { name: "Group", type: "GROUP", x: bounds.left, y: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top, children: [] });
      parent.insertChild(index, group);
      for (const child of nodes) group.appendChild(child);
      return group;
    },
    ungroup(group) {
      const parent = group.parent, index = parent.children.indexOf(group), children = [...group.children];
      group.children = []; group.remove();
      for (let i = 0; i < children.length; i++) parent.insertChild(index + i, children[i]);
      return children;
    },
    createFrame() {
      const frame = { removed: false, retainRemovedChildren: true, children: [], modes: {}, setExplicitVariableModeForCollection(collection, mode) { this.modes[collection.id] = mode; }, resizeWithoutConstraints(w, h) { this.width = w; this.height = h; }, appendChild(child) { this.children.push(child); child.parent = this; }, remove() { this.removed = true; }, async exportAsync(settings) { this.settings = settings; return options.frameExport ? options.frameExport(this) : new Uint8Array(png(Math.ceil(this.width * 2), Math.ceil(this.height * 2))); } };
      frames.push(frame); return frame;
    },
    ui: { postMessage(msg) {
      messages.push(msg);
      if (msg.type === "done" || msg.type === "optimized" || msg.type === "error") complete?.(msg);
    } },
    getImageByHash(hash) {
      imageReads.push(hash);
      return { async getBytesAsync() { return new Uint8Array(PNG); } };
    },
  };
  const context = vm.createContext({ figma, __html__: "" });
  vm.runInContext(code, context);
  return {
    context, messages, imageReads, frames,
    request(requestId, options = {}) {
      return new Promise((resolve, reject) => {
        complete = (message) => resolve(JSON.parse(JSON.stringify(message)));
        figma.ui.onmessage({ type: "export", requestId, ...options }).catch(reject);
      });
    },
    optimize(requestId, request) {
      return new Promise((resolve, reject) => {
        complete = (message) => resolve(JSON.parse(JSON.stringify(message)));
        figma.ui.onmessage({ type: "optimize", requestId, request }).catch(reject);
      });
    },
  };
}
