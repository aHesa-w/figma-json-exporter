import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { COLLECTOR_VERSION, collectLayout, flattenLayers, prepareDesign, rect, validateLayout, type ActualLayout } from "./geometry.js";

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
  if (design.meta.exporterVersion !== "3.4.1") throw new Error("Figma plugin v3.4.1 is required for complete rendering-property exports. Close and reopen JSON Exporter, then export again");
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
      const metadata = design.assets[id];
      const raster = layers.find((layer) => layer.assetId === id && layer.imageBounds);
      if (raster) {
        if (format.extension !== "png" || bytes.length < 24 || bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error(`Invalid raster PNG: ${id}`);
        const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
        const bounds = rect(metadata?.bounds), scale = metadata?.scale;
        if (JSON.stringify(bounds) !== JSON.stringify(raster.imageBounds) || scale !== 2 || !width || !height || Math.abs(width - bounds.width * scale) > 1 || Math.abs(height - bounds.height * scale) > 1) throw new Error(`Raster pixel size/bounds mismatch: ${id}; refusing clipped or incorrectly sized image`);
        metadata.pixelWidth = width; metadata.pixelHeight = height;
      }
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
    design.meta.implementationPath = join(directory, "implementation.json");
    design.meta.collectorPath = join(directory, "collect-layout.js");
    design.meta.collectorExpressionPath = join(directory, "collector-expression.js");
    design.meta.validation = { attribute: "data-d2c-id", rootAttribute: "data-d2c-root", coordinateSpace: "root-relative", tolerance: 1, required: true, collectorVersion: COLLECTOR_VERSION, propertyChecksRequired: true, visualReviewRequired: true };
    await writeFile(join(staging, "layout.json"), JSON.stringify(layers.map(({ id, name, type, parentId, rootId, depth, absoluteBounds, relativeBounds, localBounds, renderAs, assetId, imageBounds, imagePlacement, relativeImageBounds, imageBoundsSource, gradient, implementation }) => ({ id, name, type, parentId, rootId, depth, absoluteBounds, relativeBounds, localBounds, renderAs, assetId, imageBounds, imagePlacement, relativeImageBounds, imageBoundsSource, gradient, implementation })), null, 2));
    await writeFile(join(staging, "implementation.json"), JSON.stringify({ instructions: "Read design.json for source values. Follow each layer's rules and checks; never silently drop properties. Review items are NOT automatically verified. passed=true only covers automated checks, not full visual acceptance.", layers: layers.map(({ id, name, implementation }) => ({ id, name, ...implementation })) }, null, 2));
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
