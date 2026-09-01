import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { COLLECTOR_VERSION, collectLayout, flattenLayers, prepareDesign, rect, validateLayout, type ActualLayout } from "./geometry.js";
import { flowPlan, validateFlow, WORKFLOW_INSTRUCTIONS, type ValidationOptions } from "./flow.js";
import { semanticPlan, SEMANTIC_INSTRUCTIONS } from "./semantics.js";
import { stylePlan, STYLE_INSTRUCTIONS } from "./styles.js";
import { generatePreview } from "./preview.js";

export interface PenBounds { id: string; x: number; y: number; width: number; height: number }
export interface PenRaster { id: string; path: string; scale?: number; bounds?: PenBounds }
export interface ExportOptions {
  outputDir?: string;
  shapeGroupsAsImages?: boolean;
  mode?: "figma" | "pen";
  penPath?: string;
  nodeIds?: string[];
  penBounds?: PenBounds[];
  penRasters?: PenRaster[];
}
export interface AssetBytes { id: string; bytes: Buffer }
const finitePositive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

export function summarizeExport(input: unknown) {
  const design = prepareDesign(input);
  const layers = flattenLayers(design);
  const roots = design.nodes.map(root => ({ id: root.id, name: root.name, type: root.type, width: root.absoluteBounds.width, height: root.absoluteBounds.height }));
  const meta = design.meta;
  return {
    exportId: meta.exportId,
    source: { mode: meta.sourceMode ?? "figma", version: meta.sourceVersion ?? meta.exporterVersion },
    root: roots.length === 1 ? roots[0] : null,
    roots,
    counts: {
      roots: roots.length,
      nodes: layers.length,
      texts: layers.filter(layer => layer.type === "TEXT").length,
      images: Object.keys(design.assets ?? {}).length,
      repeatGroups: semanticPlan(design).repeatGroups.length,
      reviewRequired: generatePreview(design).manifest.reviewRequired.length,
    },
    files: {
      exportDirectory: meta.exportDirectory,
      designPath: meta.designPath,
      layoutPath: meta.layoutPath,
      implementationPath: meta.implementationPath,
      flowPlanPath: meta.flowPlanPath,
      semanticPlanPath: meta.semanticPlanPath,
      stylePlanPath: meta.stylePlanPath,
      generationManifestPath: meta.generationManifestPath,
      previewHtmlPath: meta.previewHtmlPath,
      previewCssPath: meta.previewCssPath,
      collectorPath: meta.collectorPath,
      collectorExpressionPath: meta.collectorExpressionPath,
    },
    warnings: { raster: Array.isArray(meta.rasterWarnings) ? meta.rasterWarnings.length : 0 },
    nextAction: "Open previewHtmlPath for the model-free starting preview. Read generationManifestPath for inferred structure; use designPath only for targeted implementation or validation details.",
  };
}

export function imageFormat(bytes: Buffer): { extension: string; mimeType: string } {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { extension: "png", mimeType: "image/png" };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { extension: "jpg", mimeType: "image/jpeg" };
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString())) return { extension: "gif", mimeType: "image/gif" };
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return { extension: "webp", mimeType: "image/webp" };
  const prefix = bytes.subarray(0, 1024).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (/^(?:<\?xml[\s\S]*?\?>\s*)?<svg\b/i.test(prefix)) return { extension: "svg", mimeType: "image/svg+xml" };
  throw new Error("Unsupported or invalid image bytes; export aborted instead of returning broken paths");
}

export async function persistExport(input: unknown, assets: Map<string, Buffer>, options: ExportOptions, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const design = prepareDesign(input);
  const sourceMode = design.meta.sourceMode ?? "figma";
  if (sourceMode === "figma" && design.meta.exporterVersion !== "3.4.1") throw new Error("Figma plugin v3.4.1 is required for complete rendering-property exports. Close and reopen JSON Exporter, then export again");
  if (sourceMode !== "figma" && sourceMode !== "pen") throw new Error(`Unsupported design source: ${sourceMode}`);
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
        if (JSON.stringify(bounds) !== JSON.stringify(raster.imageBounds) || !finitePositive(scale) || (sourceMode === "figma" && scale !== 2) || !width || !height || Math.abs(width - bounds.width * scale) > 1 || Math.abs(height - bounds.height * scale) > 1) throw new Error(`Raster pixel size/bounds mismatch: ${id}; refusing clipped or incorrectly sized image`);
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
    design.meta.flowPlanPath = join(directory, "flow-plan.json");
    design.meta.semanticPlanPath = join(directory, "semantic-plan.json");
    design.meta.stylePlanPath = join(directory, "style-plan.json");
    design.meta.generationManifestPath = join(directory, "generation-manifest.json");
    design.meta.previewDirectory = join(directory, "preview");
    design.meta.previewHtmlPath = join(directory, "preview", "index.html");
    design.meta.previewCssPath = join(directory, "preview", "preview.css");
    design.meta.collectorPath = join(directory, "collect-layout.js");
    design.meta.collectorExpressionPath = join(directory, "collector-expression.js");
    design.meta.validation = { attribute: "data-d2c-id", rootAttribute: "data-d2c-root", coordinateSpace: "root-relative", tolerance: 1, required: true, collectorVersion: COLLECTOR_VERSION, propertyChecksRequired: true, visualReviewRequired: true, phases: ["baseline", "flow"], instructions: WORKFLOW_INSTRUCTIONS };
    await writeFile(join(staging, "layout.json"), JSON.stringify(layers.map(({ id, name, type, parentId, rootId, depth, absoluteBounds, relativeBounds, localBounds, renderAs, assetId, imageBounds, imagePlacement, relativeImageBounds, imageBoundsSource, gradient, implementation }) => ({ id, name, type, parentId, rootId, depth, absoluteBounds, relativeBounds, localBounds, renderAs, assetId, imageBounds, imagePlacement, relativeImageBounds, imageBoundsSource, gradient, implementation })), null, 2));
    await writeFile(join(staging, "flow-plan.json"), JSON.stringify(flowPlan(design), null, 2));
    await writeFile(join(staging, "semantic-plan.json"), JSON.stringify(semanticPlan(design), null, 2));
    await writeFile(join(staging, "style-plan.json"), JSON.stringify(stylePlan(design), null, 2));
    const preview = generatePreview(design);
    await writeFile(join(staging, "generation-manifest.json"), JSON.stringify(preview.manifest, null, 2));
    await mkdir(join(staging, "preview"));
    await writeFile(join(staging, "preview", "index.html"), preview.html);
    await writeFile(join(staging, "preview", "preview.css"), preview.css);
    await writeFile(join(staging, "implementation.json"), JSON.stringify({ workflow: WORKFLOW_INSTRUCTIONS, semantics: SEMANTIC_INSTRUCTIONS, styles: STYLE_INSTRUCTIONS, instructions: "Read design.json for source values. Follow each layer's rules and checks; never silently drop properties. Review items are NOT automatically verified. passed=true only covers automated checks, not full visual acceptance.", layers: layers.map(({ id, name, implementation }) => ({ id, name, ...implementation })) }, null, 2));
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

export async function validateFiles(designPath: string, actual: ActualLayout, tolerance?: number, options: ValidationOptions = {}) {
  if (!isAbsolute(designPath)) throw new Error("designPath must be absolute");
  const source = await readFile(designPath, "utf8"), design = JSON.parse(source);
  const designDigest = createHash("sha256").update(source).digest("hex");
  const phase = options.phase ?? "baseline";
  if (!["baseline", "flow"].includes(phase)) throw new Error("phase must be baseline or flow");
  if (typeof actual.sampleId !== "string" || !actual.sampleId || !Number.isFinite(Date.parse(actual.collectedAt ?? ""))) throw new Error("Use the NEW collector with sampleId and collectedAt; do not reuse or invent measurements");
  if (!actual.viewport || ![actual.viewport.width, actual.viewport.height, actual.viewport.devicePixelRatio].every(v => Number.isFinite(v) && v > 0)) throw new Error("Use the NEW collector with a valid viewport and devicePixelRatio for both stages");
  if (phase === "baseline" && (options.baselineReportPath || options.flowExceptions?.length)) throw new Error("baselineReportPath/flowExceptions are only valid for phase=flow");
  let baseline: any;
  let effectiveTolerance = tolerance ?? 1;
  if (phase === "flow") {
    if (!options.baselineReportPath || !isAbsolute(options.baselineReportPath)) throw new Error("phase=flow requires baselineReportPath from a successful baseline validation");
    baseline = JSON.parse(await readFile(options.baselineReportPath, "utf8"));
    if (baseline.reportFormat !== "figma-two-stage-v1" || baseline.phase !== "baseline" || baseline.passed !== true || baseline.designDigest !== designDigest || baseline.designPath !== designPath) throw new Error("Baseline must be a successful baseline report for this unchanged designPath and design digest");
    if (!validateLayout(design, baseline.actual, baseline.tolerance).passed) throw new Error("Baseline measurements no longer pass; rerun baseline");
    effectiveTolerance = tolerance ?? baseline.tolerance;
    if (effectiveTolerance > baseline.tolerance) throw new Error("Flow tolerance must not exceed the successful baseline tolerance");
    if (!Number.isFinite(Date.parse(baseline.checkedAt)) || actual.sampleId === baseline.actual.sampleId || Date.parse(actual.collectedAt!) <= Date.parse(baseline.checkedAt)) throw new Error("Flow requires a new browser sample collected after baseline passed");
    const viewport = actual.viewport, previous = baseline.actual.viewport;
    if (!viewport || !previous || ![viewport.width, viewport.height, viewport.devicePixelRatio].every(v => Number.isFinite(v) && v > 0) || ["width", "height", "devicePixelRatio"].some(key => viewport[key as keyof typeof viewport] !== previous[key])) throw new Error("Flow must be measured at the same viewport and devicePixelRatio as baseline");
  }
  const report = validateLayout(design, actual, effectiveTolerance);
  const flow = phase === "flow" ? validateFlow(design, actual, options.flowExceptions) : null;
  const passed = report.passed && (flow?.passed ?? true);
  const stage = { reportFormat: "figma-two-stage-v1", phase, passed, workflowComplete: phase === "flow" && passed,
    scope: report.scope + (phase === "flow" ? "; additionally checks document-flow positioning conventions, not source-code quality or responsive behavior" : ""),
    baselineReportPath: options.baselineReportPath ?? null, flowMismatches: flow?.mismatches ?? [], flowExceptions: flow?.exceptions ?? [],
    nextAction: !report.passed ? report.nextAction : phase === "baseline" ? "Baseline passed. Save this reportPath, refactor real HTML/CSS to flex/grid/block document flow, then collect a NEW browser sample at the same viewport and call phase=flow with baselineReportPath. Do not stop at baseline success." : !flow!.passed ? "Fix flowMismatches without regressing geometry/styles; remeasure the refactored page and retry phase=flow with the same baselineReportPath." : "Both automated stages passed. Review flowExceptions, reviewRequired, responsive behavior and visual/interaction fidelity separately." };
  // Reports go to a separate local audit directory, never overwrite the design.
  const output = process.env.FIGMA_VALIDATION_DIR ?? join(homedir(), "Downloads", "figma-json-exporter", "validation");
  await mkdir(output, { recursive: true });
  const reportPath = join(output, `${randomUUID()}.json`);
  await writeFile(reportPath, JSON.stringify({ designPath, designDigest, checkedAt: new Date().toISOString(), actual, ...report, ...stage }, null, 2));
  return { ...report, ...stage, reportPath };
}
