// Computed sRGB forms only. Unknown color spaces fail explicitly instead of
// being misread as RGB bytes. No 8-bit canvas roundtrip that drops small alpha.
export function parseCSSColor(input: string | undefined): number[] | null {
  if (!input) return null;
  if (input === "transparent") return [0, 0, 0, 0];
  const hex = /^#([0-9a-f]{3,8})$/i.exec(input.trim());
  if (hex) {
    let raw = hex[1];
    if (raw.length === 3 || raw.length === 4) raw = [...raw].map(char => char + char).join("");
    if (raw.length === 6) raw += "ff";
    if (raw.length !== 8) return null;
    return [0, 2, 4, 6].map(offset => Number.parseInt(raw.slice(offset, offset + 2), 16) / 255);
  }
  const match = /^rgba?\(([^)]+)\)$/.exec(input.trim());
  if (!match) return null;
  const parts = match[1].trim().split(/[\s,/]+/);
  if (parts.length !== 3 && parts.length !== 4) return null;
  if (!parts.every((part) => /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?%?$/i.test(part))) return null;
  const result = parts.map((part, i) => Number.parseFloat(part) / (part.endsWith("%") ? 100 : i < 3 ? 255 : 1));
  if (result.length === 3) result.push(1);
  return result.every((value) => Number.isFinite(value) && value >= 0 && value <= 1) ? result : null;
}
