import { parseCSSColor } from "./colors.js";
export { parseCSSColor } from "./colors.js";
import { linearGradient, validateGradient } from "./gradients.js";
import type { ActualLayer, Design, Layer } from "./geometry.js";

export interface RenderStyle {
  opacity: number | null;
  position: string;
  overflowX: string; overflowY: string;
  clipPath: string; maskImage: string; contain: string;
  borderBoxWidth: number | null; borderBoxHeight: number | null;
  cornerRadii: string[];
  wrapperEffects: string[];
  backgroundImage?: string; backgroundOrigin?: string; backgroundClip?: string;
  backgroundSize?: string; backgroundPosition?: string;
}
export interface TextStyle {
  color?: string; textFillColor?: string;
  fontSize: number | null; lineHeight: number | null;
  fontWeight?: number | null; fontStyle?: string;
  letterSpacing?: number | null; textAlign?: string; direction?: string;
  textDecorationLine?: string;
}
export interface PropertyMismatch { property: string; expected: unknown; actual: unknown }


const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const radiiKeys = ["topLeft", "topRight", "bottomRight", "bottomLeft"] as const;
function targetRadii(node: Layer): number[] | null {
  if (finite(node.cornerSmoothing) && node.cornerSmoothing > 0) return null;
  const corners = node.cornerRadii as Record<string, unknown> | undefined;
  if (corners && radiiKeys.every((key) => finite(corners[key]))) return radiiKeys.map((key) => corners[key] as number);
  return finite(node.cornerRadius) ? Array(4).fill(node.cornerRadius) : null;
}
function spacingPixels(value: unknown, fontSize: unknown): number | null {
  const spacing = value as { unit?: string; value?: number } | undefined;
  if (!finite(spacing?.value)) return null;
  return spacing.unit === "PIXELS" ? spacing.value : spacing.unit === "PERCENT" && finite(fontSize) ? fontSize * spacing.value / 100 : null;
}

// CSS scales overlapping corner radii together. Compare used radii, not raw
// strings (e.g. a pill may use 999px or 50%). Matrices are reviewed separately.
function usedRadii(corners: number[][], width: number, height: number): number[][] {
  const ratios = [1];
  for (const [size, sum] of [[width, corners[0][0] + corners[1][0]], [width, corners[3][0] + corners[2][0]], [height, corners[0][1] + corners[3][1]], [height, corners[1][1] + corners[2][1]]]) {
    if (sum > 0) ratios.push(size / sum);
  }
  const factor = Math.min(...ratios);
  return corners.map((corner) => corner.map((value) => value * factor));
}
function cssRadii(style: RenderStyle): number[][] | null {
  if (!finite(style.borderBoxWidth) || !finite(style.borderBoxHeight) || style.cornerRadii?.length !== 4) return null;
  const corners: number[][] = [];
  for (const value of style.cornerRadii) {
    const parts = value.trim().split(/\s+/);
    if (parts.length < 1 || parts.length > 2) return null;
    const pair = [parts[0], parts[1] ?? parts[0]].map((part, axis) => {
      const match = /^(\d+(?:\.\d+)?|\.\d+)(px|%)$/.exec(part);
      return match ? Number(match[1]) * (match[2] === "%" ? (axis === 0 ? style.borderBoxWidth! : style.borderBoxHeight!) / 100 : 1) : NaN;
    });
    if (!pair.every(finite)) return null;
    corners.push(pair);
  }
  return usedRadii(corners, style.borderBoxWidth, style.borderBoxHeight);
}

export function renderingRequirements(node: Layer) {
  const checks = ["geometry", "hierarchy", "visibility"];
  const review: Array<{ property: string; reason: string }> = [];
  const add = (property: string, reason: string) => review.push({ property, reason });
  if (node.renderAs === "image") {
    checks.push("image-reference", "opacity");
    if (node.imageBounds) checks.push("image-placement", "image-pixel-size");
    // A standalone raster of a mask does not implement its effect on siblings.
    if (node.isMask) add("isMask/maskType", "A mask affects following siblings; its own image is not the masked composition.");
    if ((node.blendMode && !["NORMAL", "PASS_THROUGH"].includes(String(node.blendMode))) || (Array.isArray(node.effects) && node.effects.some((effect) => effect.visible !== false && effect.type === "BACKGROUND_BLUR"))) add("backdrop-compositing", "An isolated PNG does not prove blending or background blur against the implementation backdrop; inspect the composed result.");
    return { checks, review, rules: ["Keep data-d2c-id on a layout-sized wrapper with overflow:visible. Place an IMG marked data-d2c-asset=assetId at imagePlacement.x/y/width/height; do not fit the enlarged canvas into layout bounds. Do not give the asset IMG another layer ID. Local paint, opacity, radius, clipping and effects are baked; preserve ancestor clipping/opacity and mask relationships."] };
  }
  if (typeof node.clipsContent === "boolean") checks.push("clipsContent");
  if (linearGradient(node)) checks.push("gradient-direction", "gradient-stops", "gradient-paint-box");
  if (finite(node.opacity)) checks.push("opacity");
  if (targetRadii(node)) checks.push("cornerRadii");
  if (node.type === "TEXT") {
    if (node.textColor) checks.push("textColor");
    if ((node.lineHeight as { unit?: string })?.unit === "AUTO") checks.push("resolved-auto-line-height");
    for (const prop of ["fontSize", "fontWeight"] as const) if (finite(node[prop])) checks.push(prop);
    if (finite(spacingPixels(node.letterSpacing, node.fontSize))) checks.push("letterSpacing");
    if (finite(spacingPixels(node.lineHeight, node.fontSize))) checks.push("lineHeight");
    if (typeof node.textAlignHorizontal === "string") checks.push("textAlignHorizontal");
    if (["NONE", "UNDERLINE", "STRIKETHROUGH"].includes(String(node.textDecoration))) checks.push("textDecoration");
    if ((node.fontName as { style?: string })?.style) checks.push("fontStyle");
    add("text-content/font/vertical-alignment/wrapping", "Check glyphs, exact text, baselines, vertical alignment, whitespace, paragraph/list spacing, truncation and case. CSS metrics alone do not prove these.");
  }
  for (const property of ["fills", "strokes", "effects"]) {
    const values = node[property];
    if (Array.isArray(values) && values.some((v) => v.visible !== false && v.opacity !== 0)) add(property, "Preserve every visible layer in order, units, alpha and blend modes; verify paint, stroke alignment/dashes and effect appearance. Image references alone do not check crop, filters or pixels.");
  }
  if (node.isMask || node.children?.some((child) => child.isMask)) add("isMask/maskType", "Implement the mask with its affected siblings; overflow:hidden is not an alpha/luminance/vector mask.");
  if (node.blendMode && !["NORMAL", "PASS_THROUGH"].includes(String(node.blendMode))) add("blendMode", "Preserve compositing against the correct backdrop; do not silently use normal.");
  if (finite(node.cornerSmoothing) && node.cornerSmoothing > 0) add("cornerSmoothing", "Figma smoothed corners are not ordinary CSS border-radius; use a faithful shape/asset and review.");
  const matrix = node.relativeTransform as number[][] | undefined;
  if (node.rotation || (matrix && (matrix[0]?.[0] !== 1 || matrix[0]?.[1] !== 0 || matrix[1]?.[0] !== 0 || matrix[1]?.[1] !== 1))) add("transform", "Preserve rotation/reflection and transform origin. Matching axis-aligned boxes does not prove orientation.");
  if (node.autoLayout || node.constraints || ["layoutGrow", "layoutAlign", "layoutPositioning", "layoutSizingHorizontal", "layoutSizingVertical", "minWidth", "maxWidth", "minHeight", "maxHeight"].some((p) => node[p] != null)) add("layout/resizing", "Honor padding, gap, wrap, absolute children, sizing and min/max constraints; a single viewport checks only the snapshot, not responsive behavior.");
  if (node.children?.length) add("stacking-order", "Preserve children order, itemReverseZIndex and stacking contexts; equal rectangles do not prove correct occlusion.");
  if (node.overflowDirection && node.overflowDirection !== "NONE") add("overflowDirection", "Scrolling behavior is separate from clipsContent; test it interactively.");
  return { checks, review, rules: [...(linearGradient(node) ? ["Use layer.gradient.css as background-image and its backgroundOrigin/Clip/Size/Position/Repeat values on the layer element. Preserve node-local angle and stop order/alpha; do not reuse the bare matrix angle."] : []), "Apply clipping and text styles on the element carrying data-d2c-id. Unlabelled wrappers between design nodes must not introduce clipping, opacity or visual effects.", "clipsContent=true needs both overflow axes clipped and a positioned clipping owner (e.g. position:relative) for child containing blocks; false needs both axes visible. Preserve geometry and off-frame children; never delete them to fake clipping.", "Preserve all exported properties. Review items are not automatically verified; report them as pending until separately inspected."] };
}

export function validateRendering(node: Layer, found: ActualLayer, design: Design, tolerance: number): PropertyMismatch[] {
  const mismatches: PropertyMismatch[] = [];
  mismatches.push(...validateGradient(node, found.renderStyle));
  const style = found.renderStyle;
  const fail = (property: string, expected: unknown, actual: unknown) => mismatches.push({ property, expected, actual: actual ?? null });
  const numeric = (property: string, expected: unknown, actual: unknown, epsilon = Math.min(tolerance, 0.1)) => {
    if (finite(expected) && (!finite(actual) || Math.abs(expected - actual) > epsilon)) fail(property, expected, actual);
  };
  if (style?.wrapperEffects?.length) fail("wrapper-effects", [], style.wrapperEffects);
  const baked = node.renderAs === "image" && node.assetId && design.assets[node.assetId]?.opacityBaked === true;
  numeric("opacity", baked ? 1 : node.opacity, style?.opacity, 0.005);
  if (node.renderAs === "image") {
    if (node.imageBounds && node.relativeImageBounds) {
      const images = found.assetImages ?? [];
      if (images.length !== 1 || images[0].assetId !== node.assetId) fail("asset-image-count", "Exactly one owned IMG with matching data-d2c-asset", images.length);
      else {
        const image = images[0], expected = node.relativeImageBounds;
        for (const key of ["x", "y", "width", "height"] as const) numeric(`imagePlacement.${key}`, expected[key], image.bounds[key], tolerance);
        const asset = design.assets[node.assetId!];
        numeric("image.pixelWidth", asset?.pixelWidth, image.naturalWidth, 0);
        numeric("image.pixelHeight", asset?.pixelHeight, image.naturalHeight, 0);
        numeric("image.opacity", 1, image.opacity, 0.005);
        if (image.objectFit !== "fill") fail("image.objectFit", "fill", image.objectFit);
      }
      if (found.tagName !== "IMG" && (style?.overflowX !== "visible" || style?.overflowY !== "visible" || style?.clipPath !== "none" || style?.maskImage !== "none" || /\b(paint|strict|content)\b/.test(style?.contain ?? ""))) fail("raster-wrapper-clipping", "Do not clip exported strokes/effects on the layout wrapper", style);
    }
    return mismatches;
  }
  if (typeof node.clipsContent === "boolean") {
    const axes = [style?.overflowX, style?.overflowY];
    const allowed = node.clipsContent ? ["hidden", "clip", "auto", "scroll"] : ["visible"];
    if (!axes.every((axis) => typeof axis === "string" && allowed.includes(axis))) fail("clipsContent", node.clipsContent, { overflowX: axes[0] ?? null, overflowY: axes[1] ?? null });
    if (node.clipsContent && node.children?.length && !["relative", "absolute", "fixed", "sticky"].includes(style?.position ?? "")) fail("clip-containing-block", "Position the clipping owner so absolute children cannot use an outside containing block", style?.position);
    const maskComposition = node.isMask || node.children?.some((child) => child.isMask);
    if (style && !maskComposition && ((style.clipPath && style.clipPath !== "none") || (style.maskImage && style.maskImage !== "none") || /\b(paint|strict|content)\b/.test(style.contain))) fail("extra-clipping", "No additional clip-path/mask/paint containment", { clipPath: style.clipPath, maskImage: style.maskImage, contain: style.contain });
  }
  const corners = targetRadii(node);
  if (corners) {
    const expected = usedRadii(corners.map((v) => [v, v]), finite(node.width) ? node.width : node.absoluteBounds.width, finite(node.height) ? node.height : node.absoluteBounds.height);
    const actual = style ? cssRadii(style) : null;
    if (!actual || expected.some((pair, i) => pair.some((v, j) => Math.abs(v - actual[i][j]) > Math.min(tolerance, 0.1)))) fail("cornerRadii", expected, actual);
  }
  if (node.type !== "TEXT") return mismatches;
  const text = found.textStyle;
  const lineHeight = node.lineHeight as { unit?: string; source?: string; pixels?: number } | undefined;
  if (lineHeight?.unit === "AUTO" && (lineHeight.source !== "figma-css" || !finite(lineHeight.pixels))) fail("unresolved-auto-line-height", "Use Figma-resolved px or rasterize; never infer normal/1.2/fontSize", lineHeight);
  const color = node.textColor as { rgba?: { r: number; g: number; b: number; a: number } } | undefined;
  if (color?.rgba) {
    const expected = [color.rgba.r, color.rgba.g, color.rgba.b, color.rgba.a];
    for (const key of ["color", "textFillColor"] as const) {
      const measured = parseCSSColor(text?.[key]);
      // Transparent colors need equal alpha, not equal invisible RGB channels.
      if (!measured || Math.abs(expected[3] - measured[3]) > 0.001 || (expected[3] > 0 && expected.slice(0, 3).some((value, i) => Math.abs(value - measured[i]) > 1 / 255 + 1e-6))) fail(`textColor.${key}`, expected, measured ?? text?.[key]);
    }
  }
  numeric("fontSize", node.fontSize, text?.fontSize);
  numeric("fontWeight", node.fontWeight, text?.fontWeight, 0);
  numeric("letterSpacing", spacingPixels(node.letterSpacing, node.fontSize), text?.letterSpacing);
  const align = { LEFT: "left", CENTER: "center", RIGHT: "right", JUSTIFIED: "justify" }[String(node.textAlignHorizontal)];
  let actualAlign = text?.textAlign;
  if (actualAlign === "start") actualAlign = text?.direction === "rtl" ? "right" : "left";
  if (actualAlign === "end") actualAlign = text?.direction === "rtl" ? "left" : "right";
  if (align && align !== actualAlign) fail("textAlignHorizontal", align, actualAlign);
  const decoration = { NONE: "none", UNDERLINE: "underline", STRIKETHROUGH: "line-through" }[String(node.textDecoration)];
  if (decoration && decoration !== text?.textDecorationLine) fail("textDecoration", decoration, text?.textDecorationLine);
  const font = node.fontName as { style?: string } | undefined;
  if (font?.style) {
    const italic = /italic|oblique/i.test(font.style);
    if (!text?.fontStyle || italic !== /italic|oblique/i.test(text.fontStyle)) fail("fontStyle", italic ? "italic/oblique" : "normal", text?.fontStyle);
  }
  return mismatches;
}
