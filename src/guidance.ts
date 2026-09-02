// Tag-indexed inference standards. The server injects only a lightweight workflow
// skeleton; agents load these on demand via figma_guidance after a layer or a
// semantic-plan node "hits" a tag (its guidanceTags). This is the single source of
// truth for implementation rules — the INSTRUCTIONS constants only reference it.

export interface GuidanceEntry {
  tag: string;
  title: string;
  guidance: string;
}

export const GUIDANCE: GuidanceEntry[] = [
  // ── 流程 / 校验 ──────────────────────────────────────────────────────────
  {
    tag: "workflow",
    title: "End-to-end workflow",
    guidance: "Mandatory sequence: (1) figma_export, (2) STOP before coding: open previewHtmlPath and read previewCssPath plus generationManifestPath, treating the deterministic preview as the first implementation candidate rather than a disposable sample, (3) call figma_assess_preview with concrete strengths to preserve and gaps/actions tied to exported node IDs, (4) copy or extend the preview structure and change only assessed/validated gaps; never restart from a blank page or bypass preview with design.json, (5) use detailed JSON/plans only for targeted properties, (6) collect real browser data and call figma_validate_layout phase=baseline with previewAssessmentPath until passed, (7) remeasure and call phase=flow with baselineReportPath until workflowComplete=true, then review visual/interaction fidelity. Baseline is blocked without the preview assessment receipt.",
  },
  {
    tag: "baseline",
    title: "Baseline validation",
    guidance: "Baseline compares the real DOM against exported geometry, image references/placement/pixel size, clipping, opacity, ordinary radii, text metrics/colors and linear gradient direction/stops/paint box. It is positioning-agnostic: it checks the final rendered rectangles and styles, so a document-flow first version can pass baseline directly — no absolute-positioned draft is required. Use the NEW exported collector (collectorVersion 5); wait for fonts and images; never fabricate or reuse measurements. Fix parent layout errors first, then children. Read propertyMismatches and reviewRequired. passed=true covers automated checks only; visualAcceptance stays not-verified.",
  },
  {
    tag: "flow",
    title: "Document flow",
    guidance: "Build in normal document flow using block first, then inline/inline-block, then justified flex. CSS Grid is forbidden: display:grid and inline-grid always fail flow and cannot be exempted. For layered-flow, keep real content in block/inline/flex flow; express broad backgrounds as parent paint or pseudo-elements where possible and position only decorations, source-absolute nodes or leaf shapes with explicit reasons. Preserve IDs and hierarchy; no absolute wrappers, floats, nonzero relative insets, negative margins or translate tricks. Remeasure at the same viewport and do not relax tolerance.",
  },
  {
    tag: "style",
    title: "CSS contract",
    guidance: "Final code must include real CSS file(s) imported by the page. Static geometry, layout, paint, text, effects and asset placement must NOT remain in style attributes; keep HTML semantic with data-d2c-id and reusable class names. Reuse one class for identical static rule sets and extract repeated declarations into foundation/component rules. Inline styles only for genuinely runtime values via documented CSS custom properties.",
  },
  {
    tag: "subagent",
    title: "Subagent orchestration",
    guidance: "If the agent supports subagents/child sessions, run heavy work — HTML/CSS generation, document-flow refactor and validation iterations — inside subagents so the main session stays lean. Open multiple subagents as needed: split by page region or repeat component, or run generation and validation in parallel. Every subagent must follow this same workflow and call figma_validate_layout with real collector data; do not claim completion without the workflowComplete=true report.",
  },

  // ── 布局策略 ─────────────────────────────────────────────────────────────
  {
    tag: "block-flow",
    title: "Block flow",
    guidance: "Ordinary vertical structure maps to block flow. Use padding and adjacent-sibling spacing; do not convert child x/y values into per-child positioning margins or introduce anonymous layout wrappers. HARD: display must be block/flow-root here — Grid is globally forbidden and unjustified Flex fails flow.",
  },
  {
    tag: "inline-flow",
    title: "Inline flow",
    guidance: "A simple non-wrapping horizontal sequence uses inline/inline-block content with vertical-align and local spacing; avoid flex without dynamic distribution, fill/stretch or wrap. HARD: display must be inline/inline-block here — Grid is globally forbidden and unjustified Flex fails flow.",
  },
  {
    tag: "flex-row",
    title: "Flex row",
    guidance: "Horizontal children that use dynamic distribution, fill/stretch sizing or visual row wrapping need flex-row; carry source spacing/gap/alignment over, not per-child coordinate margins. Use flex-wrap for inferred two-dimensional non-overlapping rows. Grid is globally forbidden.",
  },
  {
    tag: "flex-column",
    title: "Flex column",
    guidance: "Vertical children that use dynamic distribution (CENTER/MAX/SPACE_BETWEEN) or fill/stretch sizing need flex-column. Grid is globally forbidden.",
  },
  {
    tag: "layered-flow",
    title: "Layered flow without Grid",
    guidance: "Overlapping siblings retain design paint order without CSS Grid. Keep meaningful content in normal block/inline/flex flow. Prefer moving full-size visual backgrounds onto the parent or a pseudo-element; position only background/decorative leaves and source-absolute nodes inside a relative containing block. Complex overlap stays reviewRequired rather than degrading the whole container into a coordinate Grid.",
  },

  // ── 顺序策略 ─────────────────────────────────────────────────────────────
  {
    tag: "visual-reading-order",
    title: "Visual reading order",
    guidance: "Emit labelled siblings in codeOrder — top-to-bottom, then left-to-right. Never reorder overlapping paint stacks into reading order.",
  },
  {
    tag: "preserve-design-paint-order",
    title: "Preserve paint order",
    guidance: "Overlapping siblings depend on paint order; retain design order unless explicit z-index preserves the stack.",
  },

  // ── 重复结构 ─────────────────────────────────────────────────────────────
  {
    tag: "repeat",
    title: "Repeat groups",
    guidance: "Render repeatGroups from data with stable keys and preserve every instance data-d2c-id. Framework targets map the collection into the component; plain HTML keeps expanded DOM wrapped in the supplied d2c-repeat comments.",
  },

  // ── 交互 / 控件 ──────────────────────────────────────────────────────────
  {
    tag: "tab",
    title: "Tab interaction",
    guidance: "Render a real tablist/tab/tabpanel group. Apply tabInference.stateStyles.selected to the selected tab and stateStyles.unselected to the others; drive aria-selected and aria-controls from the selected flag (an inference to confirm, not a source of truth). Support Arrow-key navigation.",
  },
  {
    tag: "search",
    title: "Search input",
    guidance: "Use input[type=search] with an accessible label, filter only already-rendered local content, and do not call a remote API unless specified. Announce the results count.",
  },
  {
    tag: "select",
    title: "Select / dropdown",
    guidance: "Prefer a native select when possible; expose the current value and support keyboard operation. Change local filter state using values already present in the rendered data.",
  },
  {
    tag: "filter",
    title: "Filter action",
    guidance: "Change local filter state using values present in the rendered data. Use a native select when possible, expose the current value and support keyboard operation.",
  },
  {
    tag: "toggle",
    title: "Toggle / choice control",
    guidance: "Use checkbox/switch/radio semantics, expose checked/selected state and provide a visible focus state. Toggle local boolean/selection state only.",
  },
  {
    tag: "checkbox",
    title: "Checkbox",
    guidance: "Use input[type=checkbox] with a label and expose checked state. Toggle local boolean state only; never invent validation, submission or persistence.",
  },
  {
    tag: "radio",
    title: "Radio group",
    guidance: "Use input[type=radio] grouped by name with a label per option and expose the selected state. Manage local selection only.",
  },
  {
    tag: "switch",
    title: "Switch",
    guidance: "Use input[type=checkbox] with role=switch and expose checked state. Toggle local boolean state only.",
  },
  {
    tag: "input",
    title: "Input control (generic)",
    guidance: "Use the inferred inputInference.semanticElement and associate a visible label (label or aria-label). Apply inputInference.style (background, borderColor, borderWidth, borderRadius, placeholderColor, padding) as component CSS, not inline styles. placeholder text/color is a styling hint — never re-enter it as the value. Provide a visible focus state and manage only local input state: no invented validation, submission, APIs or persistence.",
  },
  {
    tag: "input-text",
    title: "Text input",
    guidance: "Use input[type=text] with a visible label. Follow the generic input rule for style, placeholder and local state.",
  },
  {
    tag: "input-password",
    title: "Password input",
    guidance: "Use input[type=password] with a visible label. Follow the generic input rule; never invent validation or submission.",
  },
  {
    tag: "input-email",
    title: "Email input",
    guidance: "Use input[type=email] with a visible label. Follow the generic input rule; never invent validation or submission.",
  },
  {
    tag: "input-tel",
    title: "Telephone input",
    guidance: "Use input[type=tel] with a visible label. Follow the generic input rule.",
  },
  {
    tag: "input-number",
    title: "Number input",
    guidance: "Use input[type=number] with a visible label. Follow the generic input rule.",
  },
  {
    tag: "input-textarea",
    title: "Textarea",
    guidance: "Use textarea with a visible label. Follow the generic input rule; multi-line content stays in the value, not re-baked text.",
  },
  {
    tag: "disclosure",
    title: "Disclosure / accordion",
    guidance: "Show or hide an existing local content region with aria-expanded and aria-controls; support Enter and Space activation.",
  },
  {
    tag: "pagination",
    title: "Pagination",
    guidance: "Change local page state only when multiple rendered pages exist; otherwise disable. Use semantic buttons, expose the disabled state and announce page position.",
  },
  {
    tag: "navigation",
    title: "Navigation (callback-only)",
    guidance: "Expose a navigation callback/event; do not invent routes or URLs. Use nav and link/button semantics and expose aria-current for the active destination.",
  },
  {
    tag: "action",
    title: "Action (callback-only)",
    guidance: "Expose a named callback or CustomEvent; do not invent business behavior. Use a semantic button, an accessible name and Enter/Space support.",
  },
  {
    tag: "business-action",
    title: "Business action (blocked)",
    guidance: "Do not invent or execute a side effect; require an explicit product contract. Render inert until confirmed, then use a semantic button with disabled/pending state.",
  },

  // ── 渲染 / 实现 ──────────────────────────────────────────────────────────
  {
    tag: "image",
    title: "Raster / image layer",
    guidance: "For renderAs=image keep the layer ID on an imageBounds-sized wrapper positioned at the visual canvas origin with overflow visible, and put an equally sized IMG marked data-d2c-asset=assetId at 0/0. Preserve the original filename and expanded canvas; never stretch it into the layout box or clip its outside strokes/shadows. Local clipsContent is already baked into the atomic PNG; preserve ancestor clipping. Non-raster image paints render via assets[imageHash], not empty containers. Do not repeat baked text or effects.",
  },
  {
    tag: "gradient",
    title: "Linear gradient",
    guidance: "Use layer.gradient.css with its backgroundOrigin/Clip/Size/Position values. Direction is node-local; never copy an unconverted source angle or reverse the color stops. The validator checks gradient angle, stops and paint box; unsupported gradients cannot pass silently.",
  },
  {
    tag: "text",
    title: "Text rendering",
    guidance: "Use textColor.css for solid text color, not background-color; its alpha already includes paint opacity but not node opacity. For supported linear-gradient text, use gradient.css as a node-sized background with background-clip:text and transparent text fill so the text stays selectable. Use lineHeight.css when present: PERCENT stays %, AUTO must have a resolved px or be rasterized; never substitute fontSize or a guessed multiplier. Preserve fontSize, fontWeight, font style, text alignment and letterSpacing.css (percent is em, not px). Do not re-bake text or effects.",
  },
  {
    tag: "clipping",
    title: "Clipping & opacity",
    guidance: "Preserve clipsContent on the data-d2c-id element (both overflow axes) and node opacity. Do not add clipping/opacity on unlabelled wrappers.",
  },
  {
    tag: "mask",
    title: "Masks",
    guidance: "Respect masks and paint order; implement the mask with its affected siblings — overflow:hidden is not an alpha/luminance/vector mask. A Figma mask source supplies alpha/luminance and is not independently painted in the composed result, so never expose its fill as a standalone color block.",
  },
  {
    tag: "paint",
    title: "Strokes, effects, blend & transform",
    guidance: "Preserve strokes, effects, blend modes, transforms, stacking, Auto Layout/wrap and text truncation in order and with units/alpha/blend preserved. Unsupported properties must be reported, never dropped. Preserve exact target geometry.",
  },
];

const byTag = new Map(GUIDANCE.map(entry => [entry.tag, entry]));

export function guidanceTags(): string[] {
  return GUIDANCE.map(entry => entry.tag);
}

export function guidanceFor(tags: unknown): { guidance: Record<string, { title: string; guidance: string }>; missing: string[] } {
  const requested = Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [];
  const output: Record<string, { title: string; guidance: string }> = {};
  const missing: string[] = [];
  for (const tag of requested) {
    const entry = byTag.get(tag);
    if (entry) output[tag] = { title: entry.title, guidance: entry.guidance };
    else missing.push(tag);
  }
  return { guidance: output, missing };
}
