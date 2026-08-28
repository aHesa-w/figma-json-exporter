import type { Layer } from "./geometry.js";
import type { PropertyMismatch, RenderStyle } from "./rendering.js";
import { parseCSSColor } from "./colors.js";

type Stop = { position: number; color: number[] };
const normalize = (angle: number) => ((angle % 360) + 360) % 360;
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const rounded = (n: number) => Number(n.toFixed(6));
const visible = (paint: Record<string, unknown>) => paint.visible !== false && paint.opacity !== 0;
export function hasGradient(node: Layer): boolean {
  return [node.fills, node.strokes].some((paints) => Array.isArray(paints) && paints.some((p) => visible(p) && String(p.type).startsWith("GRADIENT")));
}

export function linearGradient(node: Layer) {
  if (node.renderAs === "image" || !Array.isArray(node.fills)) return null;
  const paints = node.fills.filter(visible);
  const paint = paints[0];
  const width = node.width ?? node.absoluteBounds.width, height = node.height ?? node.absoluteBounds.height;
  if (paints.length !== 1 || paint.type !== "GRADIENT_LINEAR" || !finite(width) || !finite(height) || width <= 0 || height <= 0 || (paint.blendMode && paint.blendMode !== "NORMAL")) return null;
  const m = paint.gradientTransform;
  if (!Array.isArray(m) || m.length !== 2 || !m.every((row: unknown) => Array.isArray(row) && row.length === 3 && row.every(finite))) return null;
  if (Math.abs(m[0][0] * m[1][1] - m[0][1] * m[1][0]) < 1e-12) return null;
  // Figma maps normalized node coordinates to gradient space: t = a*x/w +
  // b*y/h + c. Its physical color-change direction is the covector (a/w,b/h),
  // not the unscaled matrix angle or an inverse-transformed handle vector.
  const gx = m[0][0] / width, gy = m[0][1] / height, magnitude = Math.hypot(gx, gy);
  if (!finite(magnitude) || !magnitude) return null;
  const angleDeg = normalize(Math.atan2(gx, -gy) * 180 / Math.PI);
  const length = Math.abs(gx / magnitude) * width + Math.abs(gy / magnitude) * height;
  const center = (m[0][0] + m[0][1]) / 2 + m[0][2];
  if (!Array.isArray(paint.gradientStops) || paint.gradientStops.length < 2) return null;
  const opacity = paint.opacity ?? 1;
  if (!finite(opacity) || opacity < 0 || opacity > 1) return null;
  const stops: Stop[] = [];
  for (const stop of paint.gradientStops) {
    const color = parseCSSColor(stop.color);
    if (!finite(stop.position) || stop.position < 0 || stop.position > 1 || !color) return null;
    color[3] *= opacity;
    const position = (0.5 + (stop.position - center) / (magnitude * length)) * 100;
    if (!finite(position)) return null;
    if (stops.length && position < stops[stops.length - 1].position) return null;
    stops.push({ position, color });
  }
  const css = `linear-gradient(${rounded(angleDeg)}deg, ${stops.map((stop) => `rgba(${stop.color.slice(0, 3).map((v) => rounded(v * 255)).join(",")},${stop.color[3]}) ${rounded(stop.position)}%`).join(", ")})`;
  return { angleDeg, stops, css, coordinateSpace: "node-local", backgroundOrigin: "border-box", backgroundClip: "border-box", backgroundSize: "100% 100%", backgroundPosition: "0% 0%", backgroundRepeat: "no-repeat" };
}

function splitArgs(value: string): string[] | null {
  const result: string[] = []; let depth = 0, start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++;
    if (value[i] === ")" && --depth < 0) return null;
    if (value[i] === "," && depth === 0) { result.push(value.slice(start, i).trim()); start = i + 1; }
  }
  if (depth !== 0) return null;
  result.push(value.slice(start).trim()); return result;
}

export function parseLinearGradient(css: string | undefined, width: number, height: number) {
  if (!css || !finite(width) || !finite(height) || width <= 0 || height <= 0) return null;
  const outer = /^linear-gradient\((.*)\)$/is.exec(css.trim());
  const args = outer ? splitArgs(outer[1]) : null;
  if (!args || args.length < 2) return null;
  let angle = 180;
  const numeric = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))(deg|grad|rad|turn)$/.exec(args[0]);
  if (numeric) {
    angle = Number(numeric[1]) * ({ deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 }[numeric[2]]!);
    args.shift();
  } else if (args[0].startsWith("to ")) {
    const words = args.shift()!.slice(3).trim().split(/\s+/);
    if (!words.length || words.length > 2 || new Set(words).size !== words.length || words.some((w) => !["left", "right", "top", "bottom"].includes(w))) return null;
    const x = words.includes("right") ? 1 : words.includes("left") ? -1 : 0;
    const y = words.includes("bottom") ? 1 : words.includes("top") ? -1 : 0;
    if ((words.length === 2 && (!x || !y))) return null;
    // CSS corner keywords use magic corners, not the box diagonal itself.
    angle = Math.atan2(x * (y ? height : 1), -y * (x ? width : 1)) * 180 / Math.PI;
  }
  angle = normalize(angle);
  const radians = angle * Math.PI / 180, length = Math.abs(Math.sin(radians)) * width + Math.abs(Math.cos(radians)) * height;
  const stops: Array<{ color: number[]; position: number | null }> = [];
  for (const arg of args) {
    const stop = /^(rgba?\([^)]*\)|transparent)(?:\s+([+-]?(?:\d+(?:\.\d+)?|\.\d+))(%|px))?$/i.exec(arg);
    const color = stop ? parseCSSColor(stop[1]) : null;
    if (!stop || !color) return null;
    stops.push({ color, position: stop[2] === undefined ? null : Number(stop[2]) * (stop[3] === "px" ? 100 / length : 1) });
  }
  if (stops.length < 2) return null;
  stops[0].position ??= 0; stops[stops.length - 1].position ??= 100;
  let previous = -Infinity;
  for (const stop of stops) if (stop.position !== null) { stop.position = Math.max(previous, stop.position); previous = stop.position; }
  for (let start = 0; start < stops.length - 1;) {
    let end = start + 1; while (stops[end].position === null) end++;
    for (let i = start + 1; i < end; i++) stops[i].position = stops[start].position! + (stops[end].position! - stops[start].position!) * (i - start) / (end - start);
    start = end;
  }
  return { angleDeg: angle, stops: stops as Stop[] };
}

export function validateGradient(node: Layer, style: RenderStyle | undefined): PropertyMismatch[] {
  if (node.renderAs === "image" || !hasGradient(node)) return [];
  const target = linearGradient(node), issues: PropertyMismatch[] = [];
  const fail = (property: string, expected: unknown, actual: unknown) => issues.push({ property, expected, actual: actual ?? null });
  if (!target || (Array.isArray(node.strokes) && node.strokes.some((p) => visible(p) && String(p.type).startsWith("GRADIENT")))) {
    fail("gradient-unsupported", "Export complex gradients as an image; do not silently skip direction checks", null); return issues;
  }
  const actual = parseLinearGradient(style?.backgroundImage, style?.borderBoxWidth ?? 0, style?.borderBoxHeight ?? 0);
  if (!actual) { fail("gradient-missing-or-unsupported", target.css, style?.backgroundImage); return issues; }
  const difference = Math.abs(target.angleDeg - actual.angleDeg);
  if (Math.min(difference, 360 - difference) > 0.1) fail("gradient-direction", target.angleDeg, actual.angleDeg);
  if (actual.stops.length !== target.stops.length) fail("gradient-stops", target.stops, actual.stops);
  else target.stops.forEach((stop, i) => {
    const found = actual.stops[i];
    if (Math.abs(stop.position - found.position) > 0.001 || Math.abs(stop.color[3] - found.color[3]) > 0.001 || (stop.color[3] > 0 && stop.color.slice(0, 3).some((v, j) => Math.abs(v - found.color[j]) > 1 / 255 + 1e-6))) fail(`gradient-stops[${i}]`, stop, found);
  });
  if (style?.backgroundOrigin !== "border-box" || style.backgroundClip !== "border-box" || !["auto", "auto auto", "100% 100%"].includes(style.backgroundSize ?? "") || !["0% 0%", "0px 0px"].includes(style.backgroundPosition ?? "")) fail("gradient-paint-box", "Use border-box origin/clip, full-box background-size and 0% 0% position", style);
  return issues;
}
