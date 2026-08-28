import { readFileSync } from "node:fs";
import vm from "node:vm";

const code = readFileSync(new URL("../code.js", import.meta.url), "utf8");

export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
export function node(id, properties = {}) {
  return { id, name: id, type: "FRAME", visible: true, opacity: 1, x: 0, y: 0, width: 100, height: 100,
    async exportAsync() { return new Uint8Array(PNG); }, ...properties };
}

export function pluginFixture(selection) {
  const imageReads = [];
  const messages = [];
  let complete;
  const figma = {
    mixed: Symbol("mixed"), showUI() {}, closePlugin() {},
    currentPage: { selection },
    ui: { postMessage(msg) {
      messages.push(msg);
      if (msg.type === "done" || msg.type === "error") complete?.(msg);
    } },
    getImageByHash(hash) {
      imageReads.push(hash);
      return { async getBytesAsync() { return new Uint8Array(PNG); } };
    },
  };
  const context = vm.createContext({ figma, __html__: "" });
  vm.runInContext(code, context);
  return {
    context, messages, imageReads,
    request(requestId, options = {}) {
      return new Promise((resolve, reject) => {
        complete = (message) => resolve(JSON.parse(JSON.stringify(message)));
        figma.ui.onmessage({ type: "export", requestId, ...options }).catch(reject);
      });
    },
  };
}
