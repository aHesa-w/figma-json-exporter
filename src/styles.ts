import { flattenLayers, prepareDesign, type Layer } from "./geometry.js";

export const STYLE_INSTRUCTIONS = "Final code must include one or more real CSS files imported by the page; static visual/layout declarations and raster asset placement must not remain in style attributes, and HTML stays semantic with data-d2c-id and reusable class names. Load the detailed style contract and per-layer rendering standards on demand with figma_guidance (tags: style, text, image, gradient, clipping, mask, paint) instead of assuming unread rules.";

const STYLE_KEYS = [
  "width", "height", "opacity", "blendMode", "cornerRadius", "cornerRadii", "clipsContent",
  "fills", "strokes", "strokeWeight", "strokeAlign", "effects", "fontName", "fontSize", "fontWeight",
  "lineHeight", "letterSpacing", "textAlignHorizontal", "textAlignVertical", "textColor", "gradient",
] as const;

function signature(layer: Layer): string {
  const source = layer as unknown as Record<string, unknown>;
  return JSON.stringify(STYLE_KEYS.map(key => [key, source[key] ?? null]));
}

export function stylePlan(input: unknown) {
  const layers = flattenLayers(prepareDesign(input));
  const groups = new Map<string, Layer[]>();
  for (const layer of layers) {
    const key = signature(layer);
    groups.set(key, [...(groups.get(key) ?? []), layer]);
  }
  const sharedRules = [...groups.values()].filter(group => group.length >= 2).sort((a, b) => b.length - a.length).map((group, index) => ({
    suggestedClass: `d2c-shared-${index + 1}`,
    nodeIds: group.map(layer => layer.id),
    count: group.length,
    reason: "These layers share the same exported static visual/text style signature; emit one reusable CSS rule",
  }));
  return {
    instructions: STYLE_INSTRUCTIONS,
    outputContract: {
      cssFileRequired: true,
      staticInlineStyles: "forbidden",
      htmlResponsibility: "Semantic DOM, data-d2c-id, accessibility attributes and reusable class names only",
      cssResponsibility: "All static geometry, layout, paint, text, effects and raster asset placement",
      runtimeException: "Only genuinely runtime values may use a documented CSS custom property; never copy exported constants into style attributes",
    },
    organization: [
      "foundation: reset, inherited typography and design tokens",
      "structure: page regions and semantic document flow",
      "components: reusable tabs, list rows, controls and badges",
      "instances: irreducibly unique source-layer geometry",
    ],
    deduplication: {
      exactRuleReuse: "required",
      repeatedDeclarations: "extract into a shared foundation or component class",
      selectorPolicy: "Prefer meaningful component classes; generated hash classes are acceptable only for irreducibly unique geometry",
    },
    sharedRules,
    summary: { layerCount: layers.length, sharedRuleCount: sharedRules.length, coveredLayerCount: new Set(sharedRules.flatMap(group => group.nodeIds)).size },
  };
}
