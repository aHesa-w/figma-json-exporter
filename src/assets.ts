import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { collectLayout, flattenLayers, prepareDesign, validateLayout, type ActualLayout } from "./geometry.js";

export interface ExportOptions { outputDir?: string; shapeGroupsAsImages?: boolean }
export interface AssetBytes { id: string; bytes: Buffer }

export function imageFormat(bytes: Buffer): { extension: string; mimeType: string } {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { extension: "png", mimeType: "image/png" };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { extension: "jpg", mimeType: "image/jpeg" };
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString())) return { extension: "gif", mimeType: "image/gif" };
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return { extension: "webp", mimeType: "image/webp" };
  throw new Error("Unsupported or invalid image bytes; export aborted instead of returning broken paths");
}

export async function persistExport(input: unknown, assets: Map<string, Buffer>, options: ExportOptions, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const design = prepareDesign(input);
  if (design.meta.exporterVersion !== "3.1.0") throw new Error("Figma plugin v3.1.0 is required for font/image rasterization and unit-safe line-height. Close and reopen JSON Exporter, then export again");
  const output = options.outputDir ?? process.env.FIGMA_EXPORT_DIR ?? join(homedir(), "Downloads", "figma-json-exporter");
  if (!isAbsolute(output)) throw new Error("outputDir must be an absolute local directory");
  const layers = flattenLayers(design);
  const required = new Set(Object.keys(design.assets));
  for (const layer of layers) {
    if (layer.assetId) required.add(layer.assetId);
    if (layer.renderAs === "image") continue;
    for (const property of ["fills", "strokes"]) {
      const paints = layer[property];
      if (!Array.isArray(paints)) continue;
      for (const paint of paints) if (paint.type === "IMAGE" && paint.visible !== false && paint.opacity !== 0 && paint.imageHash) required.add(paint.imageHash);
    }
  }
  for (const id of required) if (!assets.has(id)) throw new Error(`Missing image bytes: ${id}. Reload the plugin; no export was published`);
  await mkdir(output, { recursive: true });
  const exportId = randomUUID();
  const directory = join(output, `export-${exportId}`);
  const staging = await mkdtemp(join(output, ".export-staging-"));
  const imagePaths: Record<string, string> = {};
  try {
    await mkdir(join(staging, "images"));
    for (const id of required) {
      signal?.throwIfAborted();
      const bytes = assets.get(id)!;
      const format = imageFormat(bytes);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const relativePath = `images/${hash}.${format.extension}`;
      await writeFile(join(staging, relativePath), bytes);
      const path = join(directory, relativePath);
      imagePaths[id] = path;
      design.assets[id] = { ...design.assets[id], id, path, relativePath, ...format, byteLength: bytes.length, sha256: hash };
    }
    design.images = imagePaths;
    design.meta.exportId = exportId;
    design.meta.exportDirectory = directory;
    design.meta.designPath = join(directory, "design.json");
    design.meta.layoutPath = join(directory, "layout.json");
    design.meta.collectorPath = join(directory, "collect-layout.js");
    design.meta.collectorExpressionPath = join(directory, "collector-expression.js");
    design.meta.validation = { attribute: "data-d2c-id", rootAttribute: "data-d2c-root", coordinateSpace: "root-relative", tolerance: 1, required: true };
    await writeFile(join(staging, "layout.json"), JSON.stringify(layers.map(({ id, name, type, parentId, rootId, depth, absoluteBounds, relativeBounds, localBounds, renderAs, assetId }) => ({ id, name, type, parentId, rootId, depth, absoluteBounds, relativeBounds, localBounds, renderAs, assetId })), null, 2));
    await writeFile(join(staging, "collect-layout.js"), `window.collectFigmaLayout = ${collectLayout.toString()};\n`);
    await writeFile(join(staging, "collector-expression.js"), `(${collectLayout.toString()})()`);
    await writeFile(join(staging, "design.json"), JSON.stringify(design, null, 2));
    signal?.throwIfAborted();
    // Publish only after every image, collector and JSON file has been written.
    await rename(staging, directory);
    return design;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function validateFiles(designPath: string, actual: ActualLayout, tolerance?: number) {
  if (!isAbsolute(designPath)) throw new Error("designPath must be absolute");
  const design = JSON.parse(await readFile(designPath, "utf8"));
  const report = validateLayout(design, actual, tolerance);
  // Reports go to a separate local audit directory, never overwrite the design.
  const output = process.env.FIGMA_VALIDATION_DIR ?? join(homedir(), "Downloads", "figma-json-exporter", "validation");
  await mkdir(output, { recursive: true });
  const reportPath = join(output, `${randomUUID()}.json`);
  await writeFile(reportPath, JSON.stringify({ designPath, checkedAt: new Date().toISOString(), actual, ...report }, null, 2));
  return { ...report, reportPath };
}
