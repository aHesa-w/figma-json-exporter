// Figma JSON Exporter - Figma 插件沙箱导出逻辑

figma.showUI(__html__, { width: 360, height: 280, title: "JSON Exporter" });

// ── 工具函数 ──────────────────────────────────────────────────────────────

function colorToRgba(color, opacity) {
  if (!color) return null;
  var op = opacity !== undefined ? opacity : 1;
  var r = Number((color.r * 255).toFixed(6));
  var g = Number((color.g * 255).toFixed(6));
  var b = Number((color.b * 255).toFixed(6));
  var a = (color.a !== undefined ? color.a : 1) * op;
  return "rgba(" + r + "," + g + "," + b + "," + a + ")";
}

function serializePaint(paint) {
  var opacity = paint.opacity !== undefined ? paint.opacity : 1;
  var visible = paint.visible !== undefined ? paint.visible : true;
  var type = paint.type;
  var base = { type: type, opacity: opacity, visible: visible, blendMode: paint.blendMode };

  if (type === "SOLID") {
    base.color = colorToRgba(paint.color, opacity);
    if (paint.color) base.rgba = { r: paint.color.r, g: paint.color.g, b: paint.color.b, a: (paint.color.a === undefined ? 1 : paint.color.a) * opacity };
    base.opacityIncludedInColor = true;
    return base;
  }
  if (type.indexOf("GRADIENT") !== -1) {
    base.gradientTransform = paint.gradientTransform;
    var stops = [];
    if (paint.gradientStops) {
      for (var i = 0; i < paint.gradientStops.length; i++) {
        var s = paint.gradientStops[i];
        stops.push({ position: s.position, color: colorToRgba(s.color) });
      }
    }
    base.gradientStops = stops;
    return base;
  }
  if (type === "IMAGE") {
    base.imageHash = paint.imageHash;
    base.scaleMode = paint.scaleMode;
    base.imageTransform = paint.imageTransform;
    base.scalingFactor = paint.scalingFactor;
    base.rotation = paint.rotation;
    base.filters = paint.filters;
    return base;
  }
  return base;
}

function serializeEffect(effect) {
  var obj = {
    type: effect.type,
    visible: effect.visible !== undefined ? effect.visible : true,
    radius: effect.radius
  };
  if (effect.color) obj.color = colorToRgba(effect.color);
  if (effect.offset) {
    obj.offset = {
      x: effect.offset.x,
      y: effect.offset.y
    };
  }
  if (effect.spread !== undefined) obj.spread = effect.spread;
  if (effect.blendMode !== undefined) obj.blendMode = effect.blendMode;
  if (effect.showShadowBehindNode !== undefined) obj.showShadowBehindNode = effect.showShadowBehindNode;
  return obj;
}

function hasProp(node, prop) {
  try {
    return prop in node;
  } catch (e) {
    return false;
  }
}

function readProp(node, prop, fallback) {
  try {
    var value = node[prop];
    return value !== undefined ? value : fallback;
  } catch (e) {
    return fallback;
  }
}

function paintIsVisible(paint) {
  if (!paint || paint.visible === false || paint.opacity === 0) return false;
  return !(paint.type === "SOLID" && paint.color && paint.color.a === 0);
}

function hasVisiblePaint(node, prop) {
  var paints = readProp(node, prop, null);
  if (!paints || isMixed(paints)) return Boolean(paints);
  for (var i = 0; i < paints.length; i++) if (paintIsVisible(paints[i])) return true;
  return false;
}

function hasVisibleEffect(node) {
  var effects = readProp(node, "effects", null);
  if (!effects || isMixed(effects)) return Boolean(effects);
  for (var i = 0; i < effects.length; i++) {
    var effect = effects[i];
    if (effect && effect.visible !== false && !(effect.color && effect.color.a === 0)) return true;
  }
  return false;
}

// Empty Frame/Group wrappers with no visible paint and no exportable descendants
// do not contribute pixels. Prune them together with explicitly hidden subtrees.
function isVisuallyEmptyContainer(node) {
  var type = readProp(node, "type", "UNKNOWN");
  if (type !== "FRAME" && type !== "GROUP") return false;
  // Real FrameNodes expose paint properties. Preserve partial/proxy nodes whose
  // appearance cannot be determined instead of treating missing data as empty.
  if (type === "FRAME" && !hasProp(node, "fills") && !hasProp(node, "strokes")) return false;
  if (readProp(node, "isMask", false) || hasVisiblePaint(node, "fills") || hasVisiblePaint(node, "strokes") || hasVisibleEffect(node)) return false;
  var children = readProp(node, "children", []);
  if (type === "GROUP" && children.length === 0) return false;
  for (var i = 0; i < children.length; i++) if (shouldExportNode(children[i])) return false;
  return true;
}

// Prune invisible or pixel-empty subtrees before serializing or collecting images.
function shouldExportNode(node) {
  return readProp(node, "visible", true) !== false && readProp(node, "opacity", 1) !== 0 && !isVisuallyEmptyContainer(node);
}

// A directly selected child can still be hidden by an ancestor outside selection.
function isEffectivelyVisible(node) {
  var current = node;
  while (current) {
    if (!shouldExportNode(current)) return false;
    current = readProp(current, "parent", null);
  }
  return true;
}

function boundsFromRect(rect) {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
    left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height };
}

function absoluteBoundsOf(node) {
  var rect = readProp(node, "absoluteBoundingBox", null);
  if (rect) return boundsFromRect(rect);
  var t = readProp(node, "absoluteTransform", null);
  var w = readProp(node, "width", 0), h = readProp(node, "height", 0);
  if (t) {
    var points = [[0, 0], [w, 0], [0, h], [w, h]];
    var xs = [], ys = [];
    for (var i = 0; i < points.length; i++) {
      xs.push(t[0][0] * points[i][0] + t[0][1] * points[i][1] + t[0][2]);
      ys.push(t[1][0] * points[i][0] + t[1][1] * points[i][1] + t[1][2]);
    }
    var left = Math.min.apply(null, xs), top = Math.min.apply(null, ys);
    return boundsFromRect({ x: left, y: top, width: Math.max.apply(null, xs) - left, height: Math.max.apply(null, ys) - top });
  }
  // Used only for minimal mock nodes; real SceneNodes expose absoluteTransform.
  var x = readProp(node, "x", 0), y = readProp(node, "y", 0);
  var parent = readProp(node, "parent", null);
  while (parent) { x += readProp(parent, "x", 0); y += readProp(parent, "y", 0); parent = readProp(parent, "parent", null); }
  return boundsFromRect({ x: x, y: y, width: w, height: h });
}

function addRelativeBounds(node, root, parent) {
  var rect = node.absoluteBounds;
  node.rootId = root.id;
  node.parentId = parent ? parent.id : null;
  node.relativeBounds = boundsFromRect({ x: rect.x - root.absoluteBounds.x, y: rect.y - root.absoluteBounds.y, width: rect.width, height: rect.height });
  var origin = parent ? parent.absoluteBounds : root.absoluteBounds;
  node.localBounds = boundsFromRect({ x: rect.x - origin.x, y: rect.y - origin.y, width: rect.width, height: rect.height });
  if (node.imageBounds) {
    var image = node.imageBounds;
    node.imagePlacement = boundsFromRect({ x: image.x - rect.x, y: image.y - rect.y, width: image.width, height: image.height });
    node.relativeImageBounds = boundsFromRect({ x: image.x - root.absoluteBounds.x, y: image.y - root.absoluteBounds.y, width: image.width, height: image.height });
  }
  if (node.children) for (var i = 0; i < node.children.length; i++) addRelativeBounds(node.children[i], root, node);
}

function isPureShape(node) {
  var type = readProp(node, "type", "");
  // An IMAGE paint is content, not vector geometry. Keep its surrounding group
  // expanded so the image remains an independently addressable image-render
  // layer instead of being baked into a composite-shape PNG.
  var paints = [].concat(readProp(node, "fills", []) || [], readProp(node, "strokes", []) || []);
  for (var p = 0; p < paints.length; p++) {
    if (paintIsVisible(paints[p]) && paints[p].type === "IMAGE") return false;
  }
  if (["VECTOR", "BOOLEAN_OPERATION", "RECTANGLE", "ELLIPSE", "LINE", "POLYGON", "STAR"].indexOf(type) !== -1) return true;
  if (type !== "GROUP") return false;
  var children = readProp(node, "children", []), count = 0;
  for (var i = 0; i < children.length; i++) {
    if (!shouldExportNode(children[i])) continue;
    if (!isPureShape(children[i])) return false;
    count++;
  }
  return count > 0;
}

function visibleDescendantIds(node) {
  var ids = [];
  var children = readProp(node, "children", []);
  for (var i = 0; i < children.length; i++) {
    if (!shouldExportNode(children[i])) continue;
    ids.push(children[i].id);
    ids = ids.concat(visibleDescendantIds(children[i]));
  }
  return ids;
}

function isMixed(value) {
  return value === figma.mixed || value === "Symbol(mixed)";
}

function serializeMixedValue(value) {
  return isMixed(value) ? "mixed" : value;
}

function serializeFontName(fontName) {
  if (!fontName || isMixed(fontName)) return "mixed";
  return {
    family: readProp(fontName, "family", ""),
    style: readProp(fontName, "style", "")
  };
}

function serializeLineHeight(lineHeight, fontSize) {
  if (!lineHeight || isMixed(lineHeight)) return "mixed";
  var unit = readProp(lineHeight, "unit", "AUTO");
  var value = readProp(lineHeight, "value", null);
  return {
    unit: unit, value: value,
    css: unit === "PERCENT" ? value + "%" : unit === "PIXELS" ? value + "px" : null,
    source: unit === "AUTO" ? "unresolved" : "explicit",
    pixels: unit === "PIXELS" ? value : unit === "PERCENT" && typeof fontSize === "number" ? fontSize * value / 100 : null
  };
}

// Explicit portable/system-font policy, not a vendor-name blacklist. A local
// browser font inventory is not available in the Figma sandbox.
var SYSTEM_FONT_FAMILIES = ["arial", "arial black", "helvetica", "helvetica neue", "times new roman", "times", "georgia", "verdana", "tahoma", "trebuchet ms", "courier new", "courier", "segoe ui", "sf pro", "sf pro display", "sf pro text", "pingfang sc", "pingfang tc", "pingfang hk", "microsoft yahei", "microsoft jhenghei", "simsun", "simhei", "songti sc", "heiti sc", "hiragino sans", "hiragino sans gb", "baidu number", "baidu number plus", "sans-serif", "serif", "monospace", "system-ui", "-apple-system", "blinkmacsystemfont"];
function fontsAreWhitelisted(fonts) {
  for (var i = 0; i < fonts.length; i++) {
    var family = String(fonts[i].family || "").trim().toLowerCase();
    if (SYSTEM_FONT_FAMILIES.indexOf(family) === -1) return false;
  }
  return fonts.length > 0;
}

var SEGMENT_TEXT_FIELDS = ["fontName", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "textDecoration", "textCase", "fills"];
function serializeStyledTextSegments(node, base) {
  if (base.type !== "TEXT" || typeof node.getStyledTextSegments !== "function") return null;
  var hasSupportedMixed = false;
  for (var i = 0; i < SEGMENT_TEXT_FIELDS.length; i++) {
    var prop = SEGMENT_TEXT_FIELDS[i];
    if (base[prop] === "mixed" || isMixed(readProp(node, prop, null))) hasSupportedMixed = true;
  }
  if (!hasSupportedMixed) return null;
  // Paragraph-level and stroke differences cannot be represented safely by
  // inline spans in the starter preview; keep the existing raster fallback.
  var unsupported = ["paragraphSpacing", "paragraphIndent", "strokes"];
  for (var u = 0; u < unsupported.length; u++) {
    if (base[unsupported[u]] === "mixed" || isMixed(readProp(node, unsupported[u], null))) return null;
  }
  var raw;
  try { raw = node.getStyledTextSegments(SEGMENT_TEXT_FIELDS); } catch (e) { return null; }
  if (!raw || !raw.length || raw.length > 1000) return null;
  var result = [], cursor = 0, combined = "";
  for (var s = 0; s < raw.length; s++) {
    var segment = raw[s];
    if (!segment || segment.start !== cursor || segment.end <= segment.start || typeof segment.characters !== "string") return null;
    var fontName = serializeFontName(segment.fontName);
    var fontSize = serializeMixedValue(segment.fontSize);
    var fontWeight = serializeMixedValue(segment.fontWeight);
    var lineHeight = serializeLineHeight(segment.lineHeight, fontSize);
    var letterSpacing = serializeLetterSpacing(segment.letterSpacing, fontSize);
    var textDecoration = serializeMixedValue(segment.textDecoration);
    var textCase = serializeMixedValue(segment.textCase);
    if (fontName === "mixed" || !fontsAreWhitelisted([fontName]) || typeof fontSize !== "number" || typeof fontWeight !== "number" || lineHeight === "mixed" || lineHeight.unit === "AUTO" || letterSpacing === "mixed" || textDecoration === "mixed" || textCase === "mixed" || !segment.fills || isMixed(segment.fills)) return null;
    var fills = [];
    for (var f = 0; f < segment.fills.length; f++) fills.push(serializePaint(segment.fills[f]));
    var textColor = serializeTextColor(fills);
    if (!textColor) return null;
    result.push({
      start: segment.start, end: segment.end, characters: segment.characters,
      fontName: fontName, fontSize: fontSize, fontWeight: fontWeight,
      lineHeight: lineHeight, letterSpacing: letterSpacing,
      textDecoration: textDecoration, textCase: textCase,
      fills: fills, textColor: textColor
    });
    cursor = segment.end;
    combined += segment.characters;
  }
  if (cursor !== base.characters.length || combined !== base.characters) return null;
  return result;
}

function textRasterReason(node, base) {
  if (base.type !== "TEXT") return null;
  var fonts = [];
  if (base.fontName !== "mixed") fonts = [base.fontName];
  else {
    try { fonts = node.getRangeAllFontNames(0, base.characters.length); } catch (e) { return "unknown-font"; }
  }
  if (!fonts.length) return "unknown-font";
  var whitelisted = fontsAreWhitelisted(fonts);
  // Whitelisted families stay selectable DOM text even when this machine lacks
  // the font: the exported font-family lets viewers who have it get faithful
  // rendering, and missing-font substitutes were never faithful either.
  if (!whitelisted) {
    if (readProp(node, "hasMissingFont", false)) return "missing-font";
    return "non-system-font";
  }
  if (readProp(readProp(figma, "root", {}), "documentColorProfile", "LEGACY") === "DISPLAY_P3") return "wide-gamut-text";
  var textProps = ["fontName", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "textDecoration", "textCase", "paragraphSpacing", "paragraphIndent", "fills", "strokes"];
  var hasMixedStyle = false;
  for (var p = 0; p < textProps.length; p++) if (base[textProps[p]] === "mixed" || isMixed(readProp(node, textProps[p], null))) hasMixedStyle = true;
  if (hasMixedStyle && !base.styledTextSegments) return "mixed-text-style";
  if (base.lineHeight.unit === "AUTO" && base.lineHeight.source !== "figma-css") return "unresolved-auto-line-height";
  if (base.strokes && base.strokes.some(function(p) { return p.visible !== false && p.opacity !== 0; })) return "text-stroke";
  // A single supported linear gradient can stay selectable DOM text. The
  // preview and validator express it with a node-sized background clipped to
  // the glyphs. Other text paints remain conservative raster fallbacks.
  var visibleFills = (base.fills || []).filter(function(p) { return p.visible !== false && p.opacity !== 0; });
  var supportedGradientText = visibleFills.length === 1 && visibleFills[0].type === "GRADIENT_LINEAR" && gradientRasterReason(base) === null;
  if (!base.textColor && !base.styledTextSegments && !supportedGradientText) return "complex-text-paint";
  return null;
}

function serializeTextColor(fills) {
  if (!fills) return null;
  var visible = fills.filter(function(p) { return p.visible !== false && p.opacity !== 0; });
  if (!visible.length) return { css: "rgba(0,0,0,0)", rgba: { r: 0, g: 0, b: 0, a: 0 }, opacityIncluded: true };
  if (visible.length !== 1 || visible[0].type !== "SOLID" || !visible[0].rgba || (visible[0].blendMode && visible[0].blendMode !== "NORMAL")) return null;
  return { css: visible[0].color, rgba: visible[0].rgba, opacityIncluded: true };
}

async function resolveAutoLineHeight(node, base) {
  if (base.type !== "TEXT" || base.lineHeight.unit !== "AUTO") return;
  try {
    var css = await node.getCSSAsync();
    var value = String(css["line-height"] || "").trim();
    var match = /^(\d+(?:\.\d+)?|\.\d+)px$/.exec(value);
    if (match && Number(match[1]) > 0) {
      base.lineHeight.css = value;
      base.lineHeight.pixels = Number(match[1]);
      base.lineHeight.source = "figma-css";
    }
  } catch (e) { /* Unresolved AUTO is rasterized; never infer from text box height. */ }
}

function gradientRasterReason(base) {
  // A mask is not standalone artwork: rasterizing only the mask loses its
  // relationship with the following siblings. Keep its paint/mask metadata so
  // the implementation can reproduce the composed mask. Its RGB color space
  // is irrelevant when only alpha/luminance drives masking.
  if (base.isMask) return null;
  var fills = (base.fills || []).filter(function(p) { return p.visible !== false && p.opacity !== 0; });
  var strokes = (base.strokes || []).filter(function(p) { return p.visible !== false && p.opacity !== 0; });
  function gradient(p) { return String(p.type).indexOf("GRADIENT") === 0; }
  if (!fills.some(gradient) && !strokes.some(gradient)) return null;
  // Only a single normal linear fill has the checked CSS representation.
  // Preserve complex gradients as a composed asset, including layout containers.
  if (strokes.some(gradient) || fills.length !== 1 || fills[0].type !== "GRADIENT_LINEAR" || (fills[0].blendMode && fills[0].blendMode !== "NORMAL") || !(base.width > 0 && base.height > 0)) return "complex-gradient";
  if (readProp(readProp(figma, "root", {}), "documentColorProfile", "LEGACY") === "DISPLAY_P3") return "wide-gamut-gradient";
  var m = fills[0].gradientTransform;
  if (!Array.isArray(m) || m.length !== 2 || !m.every(function(row) { return Array.isArray(row) && row.length === 3 && row.every(function(n) { return typeof n === "number" && isFinite(n); }); }) || Math.abs(m[0][0] * m[1][1] - m[0][1] * m[1][0]) < 1e-12) return "invalid-gradient-transform";
  return null;
}

function rasterNeedsIsolatedBounds(base) {
  if (!base.renderBounds || base.type === "TEXT") return true;
  var strokes = (base.strokes || []).filter(function(p) { return p.visible !== false && p.opacity !== 0; });
  if (strokes.length && base.strokeWeight > 0 && base.strokeAlign !== "INSIDE") return true;
  return (base.effects || []).some(function(effect) {
    return effect.visible !== false && (effect.type === "DROP_SHADOW" || effect.type === "LAYER_BLUR");
  });
}

function rasterBoundsOf(base) {
  var layout = base.absoluteBounds, visual = base.renderBounds;
  if (!visual || ![visual.x, visual.y, visual.width, visual.height].every(function(v) { return typeof v === "number" && isFinite(v); }) || visual.width < 0 || visual.height < 0) {
    // Figma can return null for a visible node outside an ancestor's clip.
    // Defer measurement to an isolated clone; layout bounds are not paint bounds.
    return null;
  }
  var left = Math.min(layout.left, visual.x), top = Math.min(layout.top, visual.y);
  var right = Math.max(layout.right, visual.x + visual.width), bottom = Math.max(layout.bottom, visual.y + visual.height);
  return boundsFromRect({ x: left, y: top, width: right - left, height: bottom - top });
}

async function exportRaster(item) {
  var options = { format: "PNG", constraint: { type: "SCALE", value: 2 }, contentsOnly: true, useAbsoluteBounds: true, colorProfile: "SRGB" };
  var layout = item.layoutBounds, recoverBounds = !item.bounds || item.requireIsolatedBounds;
  var b = item.bounds || layout;
  if (!recoverBounds && b.x === layout.x && b.y === layout.y && b.width === layout.width && b.height === layout.height) return item.node.exportAsync(options);
  // Export a clone in an isolated transparent canvas, not a page slice that
  // could include neighbouring artwork. Original layer geometry is untouched.
  var frame = null, clone = null;
  try {
    var t = item.transform;
    if (!t) throw new Error("Missing absoluteTransform for expanded raster " + item.id);
    frame = figma.createFrame();
    frame.name = "__JSON_EXPORT_TEMP__";
    frame.fills = []; frame.strokes = []; frame.effects = [];
    // The probe must not inherit clipping or introduce a new clip itself.
    frame.layoutMode = "NONE"; frame.clipsContent = false;
    frame.resizeWithoutConstraints(Math.max(1, b.width), Math.max(1, b.height));
    frame.x = b.x; frame.y = b.y;
    // Moving a clone out of an ancestor must not change inherited variable
    // modes (e.g. a dark-theme color reverting to the collection default).
    var collections = Object.keys(item.variableModes);
    for (var i = 0; i < collections.length; i++) {
      var collection = await figma.variables.getVariableCollectionByIdAsync(collections[i]);
      if (!collection) throw new Error("Cannot preserve variable mode for " + collections[i]);
      frame.setExplicitVariableModeForCollection(collection, item.variableModes[collections[i]]);
    }
    clone = item.node.clone();
    frame.appendChild(clone);
    clone.relativeTransform = [[t[0][0], t[0][1], t[0][2] - b.x], [t[1][0], t[1][1], t[1][2] - b.y]];
    if (Math.abs(clone.width - item.width) > 0.001 || Math.abs(clone.height - item.height) > 0.001) throw new Error("Clone resized during raster export: " + item.id);
    if (recoverBounds) {
      var recovered = rasterBoundsOf({ absoluteBounds: layout, renderBounds: readProp(clone, "absoluteRenderBounds", null) });
      if (!recovered || recovered.width <= 0 || recovered.height <= 0) {
        throw new Error("Cannot recover absoluteRenderBounds for raster layer " + item.node.id + " (" + item.node.type + ") even in an unclipped clone; refusing to crop strokes/shadows or silently drop this layer");
      }
      b = item.bounds = recovered;
      item.boundsSource = "isolated-clone";
    }
    // Resize without constraints, then reset the clone's world position so a
    // negative paint offset does not move the exported artwork or its children.
    frame.resizeWithoutConstraints(b.width, b.height);
    frame.x = b.x; frame.y = b.y;
    clone.relativeTransform = [[t[0][0], t[0][1], t[0][2] - b.x], [t[1][0], t[1][1], t[1][2] - b.y]];
    if (Math.abs(clone.width - item.width) > 0.001 || Math.abs(clone.height - item.height) > 0.001) throw new Error("Clone resized during raster export: " + item.id);
    frame.clipsContent = true;
    return await frame.exportAsync(options);
  } finally {
    try { if (clone && !clone.removed) clone.remove(); }
    finally { if (frame && !frame.removed) frame.remove(); }
  }
}

function rasterPixelSize(bytes, bounds) {
  var signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || signature.some(function(b, i) { return bytes[i] !== b; }) || bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) throw new Error("Invalid raster PNG");
  function uint32(i) { return bytes[i] * 16777216 + bytes[i + 1] * 65536 + bytes[i + 2] * 256 + bytes[i + 3]; }
  var width = uint32(16), height = uint32(20);
  if (!width || !height || Math.abs(width - bounds.width * 2) > 1 || Math.abs(height - bounds.height * 2) > 1) throw new Error("Raster pixel size does not match expanded canvas");
  return { width: width, height: height };
}

function serializeLetterSpacing(letterSpacing, fontSize) {
  if (!letterSpacing || isMixed(letterSpacing)) return "mixed";
  var unit = readProp(letterSpacing, "unit", "PIXELS"), value = readProp(letterSpacing, "value", 0);
  return {
    unit: unit, value: value,
    css: unit === "PERCENT" ? value / 100 + "em" : unit === "PIXELS" ? value + "px" : null,
    pixels: unit === "PIXELS" ? value : unit === "PERCENT" && typeof fontSize === "number" ? fontSize * value / 100 : null
  };
}

function serializeLayoutValue(value) {
  if (isMixed(value)) return "mixed";
  return value;
}

function serializeConstraints(constraints) {
  if (!constraints || isMixed(constraints)) return null;
  return {
    horizontal: readProp(constraints, "horizontal", "MIN"),
    vertical: readProp(constraints, "vertical", "MIN")
  };
}

function serializePaintList(node, prop) {
  var paints = readProp(node, prop, null);
  if (!paints || isMixed(paints)) return null;

  // Invisible paints are treated as though the property does not exist:
  // keep the property list clean instead of emitting `visible:false` entries.
  var result = [];
  for (var i = 0; i < paints.length; i++) {
    if (paintIsVisible(paints[i])) result.push(serializePaint(paints[i]));
  }
  return result;
}

function collectImageHashesFromNode(node) {
  var hashes = [];
  var props = ["fills", "strokes"];
  for (var p = 0; p < props.length; p++) {
    var fills = readProp(node, props[p], null);
    if (!fills || isMixed(fills)) continue;
    for (var i = 0; i < fills.length; i++) {
      var fill = fills[i];
      if (fill.type === "IMAGE" && fill.imageHash && fill.visible !== false && fill.opacity !== 0) hashes.push(fill.imageHash);
    }
  }
  return hashes;
}

function serializeNodeBase(node) {
  var base = {
    id: readProp(node, "id", ""),
    name: readProp(node, "name", ""),
    type: readProp(node, "type", "UNKNOWN"),
    visible: readProp(node, "visible", true)
  };

  if (hasProp(node, "x")) base.x = readProp(node, "x", 0);
  if (hasProp(node, "y")) base.y = readProp(node, "y", 0);
  if (hasProp(node, "width")) base.width = readProp(node, "width", 0);
  if (hasProp(node, "height")) base.height = readProp(node, "height", 0);
  base.absoluteBounds = absoluteBoundsOf(node);
  base.absoluteTransform = readProp(node, "absoluteTransform", null);
  base.relativeTransform = readProp(node, "relativeTransform", null);
  base.renderBounds = readProp(node, "absoluteRenderBounds", null);
  if (hasProp(node, "clipsContent")) base.clipsContent = readProp(node, "clipsContent", false);
  base.isMask = readProp(node, "isMask", false);
  // Keep source semantics even where no single CSS declaration is equivalent.
  var extraProps = ["maskType", "cornerSmoothing", "strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight", "strokeCap", "strokeJoin", "strokeMiterLimit", "dashPattern", "layoutAlign", "layoutGrow", "layoutPositioning", "layoutSizingHorizontal", "layoutSizingVertical", "minWidth", "maxWidth", "minHeight", "maxHeight", "overflowDirection", "itemReverseZIndex", "strokesIncludedInLayout"];
  for (var p = 0; p < extraProps.length; p++) {
    if (hasProp(node, extraProps[p])) base[extraProps[p]] = serializeMixedValue(readProp(node, extraProps[p], null));
  }
  if (hasProp(node, "rotation")) base.rotation = readProp(node, "rotation", 0);
  if (hasProp(node, "opacity")) base.opacity = readProp(node, "opacity", 1);
  if (hasProp(node, "blendMode")) base.blendMode = readProp(node, "blendMode", "PASS_THROUGH");
  if (hasProp(node, "cornerRadius")) base.cornerRadius = serializeMixedValue(readProp(node, "cornerRadius", 0));
  if (hasProp(node, "topLeftRadius")) {
    base.cornerRadii = {
      topLeft: readProp(node, "topLeftRadius", 0),
      topRight: readProp(node, "topRightRadius", 0),
      bottomRight: readProp(node, "bottomRightRadius", 0),
      bottomLeft: readProp(node, "bottomLeftRadius", 0)
    };
  }

  var fills = serializePaintList(node, "fills");
  if (fills) base.fills = fills;

  var strokes = serializePaintList(node, "strokes");
  if (strokes) {
    base.strokes = strokes;
    base.strokeWeight = serializeMixedValue(readProp(node, "strokeWeight", 0));
    base.strokeAlign = readProp(node, "strokeAlign", "CENTER");
  }

  var effects = readProp(node, "effects", null);
  if (effects && !isMixed(effects)) {
    // Invisible effects are treated as though the property does not exist.
    var visibleEffects = [];
    for (var i = 0; i < effects.length; i++) {
      var effect = effects[i];
      if (effect && effect.visible !== false && !(effect.color && effect.color.a === 0)) visibleEffects.push(serializeEffect(effect));
    }
    if (visibleEffects.length) base.effects = visibleEffects;
  }

  var constraints = serializeConstraints(readProp(node, "constraints", null));
  if (constraints) base.constraints = constraints;

  if (base.type === "TEXT") {
    base.characters = readProp(node, "characters", "");
    base.fontSize = serializeMixedValue(readProp(node, "fontSize", "mixed"));
    base.fontWeight = serializeMixedValue(readProp(node, "fontWeight", 400));
    base.fontName = serializeFontName(readProp(node, "fontName", null));
    base.textAlignHorizontal = readProp(node, "textAlignHorizontal", "LEFT");
    base.textAlignVertical = readProp(node, "textAlignVertical", "TOP");
    base.lineHeight = serializeLineHeight(readProp(node, "lineHeight", null), base.fontSize);
    base.letterSpacing = serializeLetterSpacing(readProp(node, "letterSpacing", null), base.fontSize);
    base.textDecoration = serializeMixedValue(readProp(node, "textDecoration", "mixed"));
    base.textColor = serializeTextColor(base.fills);
    var textProps = ["textAutoResize", "textTruncation", "maxLines", "textCase", "paragraphSpacing", "paragraphIndent", "listSpacing", "hangingPunctuation", "hangingList", "leadingTrim"];
    for (var p = 0; p < textProps.length; p++) {
      if (hasProp(node, textProps[p])) base[textProps[p]] = serializeMixedValue(readProp(node, textProps[p], null));
    }
  }

  var layoutMode = readProp(node, "layoutMode", "NONE");
  if (hasProp(node, "layoutMode") && layoutMode !== "NONE") {
    base.autoLayout = {
      mode: layoutMode,
      paddingLeft: serializeLayoutValue(readProp(node, "paddingLeft", 0)),
      paddingRight: serializeLayoutValue(readProp(node, "paddingRight", 0)),
      paddingTop: serializeLayoutValue(readProp(node, "paddingTop", 0)),
      paddingBottom: serializeLayoutValue(readProp(node, "paddingBottom", 0)),
      itemSpacing: serializeLayoutValue(readProp(node, "itemSpacing", 0)),
      primaryAxisAlignItems: readProp(node, "primaryAxisAlignItems", "MIN"),
      counterAxisAlignItems: readProp(node, "counterAxisAlignItems", "MIN"),
      primaryAxisSizingMode: readProp(node, "primaryAxisSizingMode", "AUTO"),
      counterAxisSizingMode: readProp(node, "counterAxisSizingMode", "AUTO"),
      layoutWrap: readProp(node, "layoutWrap", "NO_WRAP"),
      counterAxisSpacing: readProp(node, "counterAxisSpacing", 0),
      counterAxisAlignContent: readProp(node, "counterAxisAlignContent", "AUTO")
    };
  }

  var imageHashes = collectImageHashesFromNode(node);
  if (imageHashes.length > 0) base._imageHashes = imageHashes;

  return base;
}

// 异步序列化节点（处理 mainComponent 等需要异步访问的属性）
async function serializeNodeAsync(node, context) {
  if (!shouldExportNode(node)) return null;
  var base = serializeNodeBase(node);

  if (context) await resolveAutoLineHeight(node, base);
  var styledTextSegments = serializeStyledTextSegments(node, base);
  if (styledTextSegments) base.styledTextSegments = styledTextSegments;
  var rasterReason = textRasterReason(node, base) || gradientRasterReason(base);
  var visibleChildren = readProp(node, "children", []).filter(shouldExportNode);
  var imageLeaf = collectImageHashesFromNode(node).length > 0 && visibleChildren.length === 0;
  var shape = context && context.shapeGroupsAsImages && !base.isMask && !(context.skipRasterIds && context.skipRasterIds[base.id]) &&
      (base.type === "VECTOR" || base.type === "BOOLEAN_OPERATION" || (base.type === "GROUP" && isPureShape(node)));
  var rasterHits = rasterReason || imageLeaf || shape;
  if (context && rasterHits && !(context.skipRasterIds && context.skipRasterIds[base.id])) {
    base.renderAs = "image";
    base.assetId = "node-" + base.id;
    base.rasterReason = rasterReason || (imageLeaf ? "image-paint" : "composite-shape");
    base.collapsedNodeIds = visibleDescendantIds(node);
    base.imageBounds = rasterBoundsOf(base);
    // Retain original image bytes as well as the faithful cropped/filtered PNG.
    if (!imageLeaf) delete base._imageHashes;
    // Composite groups must always be probed in isolation: their own stroke/effect
    // fields do not reveal paint extending from collapsed descendants.
    context.rasters.push({ id: base.assetId, node: node, layer: base, width: base.width, height: base.height, bounds: base.imageBounds, boundsSource: "absoluteRenderBounds", requireIsolatedBounds: shape || rasterNeedsIsolatedBounds(base), layoutBounds: base.absoluteBounds, transform: base.absoluteTransform, variableModes: readProp(node, "resolvedVariableModes", {}), kind: base.type === "TEXT" ? "text" : imageLeaf ? "image-render" : "shape", reason: base.rasterReason });
    return base;
  }

  // 异步获取 mainComponent
  if (base.type === "INSTANCE") {
    try {
      var mainComponent = await node.getMainComponentAsync();
      if (mainComponent) {
        base.componentId = mainComponent.id;
        base.componentName = mainComponent.name;
      }
    } catch (e) {
      // 忽略错误，保持 base 不变
    }
  }

  var children = readProp(node, "children", null);
  if (children) {
    base.children = [];
    for (var i = 0; i < children.length; i++) {
      var child = await serializeNodeAsync(children[i], context);
      if (child) base.children.push(child);
    }
  }

  return base;
}

// 同步版本保留（用于不需要异步访问的场景）
function serializeNode(node) {
  if (!shouldExportNode(node)) return null;
  var base = serializeNodeBase(node);

  if (base.type === "INSTANCE") {
    base.isInstance = true;
    // mainComponent 需要异步访问，在 serializeNodeAsync 中处理
  }

  var children = readProp(node, "children", null);
  if (children) {
    base.children = [];
    for (var i = 0; i < children.length; i++) {
      var child = serializeNode(children[i]);
      if (child) base.children.push(child);
    }
  }

  return base;
}

function collectImageHashes(nodeJson) {
  var hashes = {};
  function walk(n) {
    if (n._imageHashes) {
      for (var i = 0; i < n._imageHashes.length; i++) {
        hashes[n._imageHashes[i]] = true;
      }
    }
    if (n.children) {
      for (var i = 0; i < n.children.length; i++) walk(n.children[i]);
    }
  }
  walk(nodeJson);
  return Object.keys(hashes);
}

// ── 消息处理 ──────────────────────────────────────────────────────────────

function wrapMsg(base, requestId) {
  if (requestId) base.requestId = requestId;
  return base;
}

function sceneChildren(node) {
  var children = readProp(node, "children", []);
  return Array.isArray(children) ? children : [];
}

function walkScene(node, visit) {
  visit(node);
  var children = sceneChildren(node);
  for (var i = 0; i < children.length; i++) walkScene(children[i], visit);
}

function topLevelSelection(selection) {
  var result = [];
  for (var i = 0; i < selection.length; i++) {
    var ancestor = readProp(selection[i], "parent", null), nested = false;
    while (ancestor) {
      if (selection.indexOf(ancestor) !== -1) { nested = true; break; }
      ancestor = readProp(ancestor, "parent", null);
    }
    if (!nested) result.push(selection[i]);
  }
  return result;
}

function sameStringSet(actual, expected) {
  if (actual.length !== expected.length) return false;
  var seen = {};
  for (var i = 0; i < actual.length; i++) seen[actual[i]] = (seen[actual[i]] || 0) + 1;
  for (var j = 0; j < expected.length; j++) {
    if (!seen[expected[j]]) return false;
    seen[expected[j]]--;
  }
  return true;
}

function insideInstance(node, rootsById) {
  var current = node;
  while (current && !rootsById[current.id]) {
    if (readProp(current, "type", "") === "INSTANCE") return true;
    current = readProp(current, "parent", null);
  }
  return current && readProp(current, "type", "") === "INSTANCE";
}

function collectOptimizationFonts(roots) {
  var fonts = {}, list = [];
  for (var r = 0; r < roots.length; r++) walkScene(roots[r], function(node) {
    if (readProp(node, "type", "") !== "TEXT") return;
    var names = [];
    try {
      var characters = String(readProp(node, "characters", ""));
      names = typeof node.getRangeAllFontNames === "function" && characters.length ? node.getRangeAllFontNames(0, characters.length) : [readProp(node, "fontName", null)];
    } catch (e) { names = [readProp(node, "fontName", null)]; }
    for (var i = 0; i < names.length; i++) {
      var font = names[i];
      if (!font || isMixed(font) || typeof font.family !== "string" || typeof font.style !== "string") continue;
      var key = font.family + "\n" + font.style;
      if (!fonts[key]) { fonts[key] = true; list.push(font); }
    }
  });
  return list;
}

function mapCloneTree(source, clone, sourceToClone, createdIds) {
  sourceToClone[source.id] = clone;
  createdIds.push(clone.id);
  var sourceChildren = sceneChildren(source), cloneChildren = sceneChildren(clone);
  if (sourceChildren.length !== cloneChildren.length) throw new Error("复制后节点结构不一致：" + source.id);
  for (var i = 0; i < sourceChildren.length; i++) mapCloneTree(sourceChildren[i], cloneChildren[i], sourceToClone, createdIds);
}

function overlaps(a, b) {
  return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) > 0.5;
}

function orderVisualComponents(parent, children, floatingNodes) {
  if (children.length < 2) return children.slice();
  var parentBounds = absoluteBoundsOf(parent), parentArea = Math.max(1, parentBounds.width * parentBounds.height);
  var backgrounds = [], content = [], floating = [];
  for (var i = 0; i < children.length; i++) {
    var bounds = absoluteBoundsOf(children[i]);
    var coverage = bounds.width * bounds.height / parentArea;
    var name = String(readProp(children[i], "name", "")).toLowerCase();
    var backgroundName = /(^|[\s_\-/])(bg|background|backdrop)([\s_\-/]|$)|背景|底图|底色/.test(name);
    if (floatingNodes && floatingNodes.has(children[i])) floating.push({ node: children[i], index: i, bounds: bounds });
    else if (readProp(children[i], "type", "") !== "TEXT" && coverage >= 0.8 && (i === 0 || backgroundName)) backgrounds.push({ node: children[i], index: i, bounds: bounds });
    else content.push({ node: children[i], index: i, bounds: bounds });
  }
  content.sort(function(a, b) {
    var rowOverlap = Math.max(0, Math.min(a.bounds.bottom, b.bounds.bottom) - Math.max(a.bounds.top, b.bounds.top));
    var sameRow = rowOverlap >= Math.min(a.bounds.height, b.bounds.height) * 0.5;
    if (sameRow && Math.abs(a.bounds.left - b.bounds.left) > 0.5) return a.bounds.left - b.bounds.left;
    if (Math.abs(a.bounds.top - b.bounds.top) > 0.5) return a.bounds.top - b.bounds.top;
    if (Math.abs(a.bounds.left - b.bounds.left) > 0.5) return a.bounds.left - b.bounds.left;
    return a.index - b.index;
  });
  // Figma's Layers panel displays the last painted child first. Therefore the
  // paint array must contain content in reverse reading order for the panel to
  // read top-to-bottom and, within a row, left-to-right. Overlapping pairs keep
  // their original paint order via a DAG constraint; unlike connected-component
  // grouping, one large backdrop cannot freeze every otherwise independent node.
  var desired = backgrounds.sort(function(a, b) { return a.index - b.index; }).concat(content.slice().reverse(), floating.sort(function(a, b) { return a.index - b.index; }));
  var rank = new Map();
  for (var d = 0; d < desired.length; d++) rank.set(desired[d].node, d);
  var items = backgrounds.concat(content, floating), edges = [], indegree = [];
  items.sort(function(a, b) { return a.index - b.index; });
  for (var e = 0; e < items.length; e++) { edges[e] = []; indegree[e] = 0; }
  for (var from = 0; from < items.length; from++) for (var to = from + 1; to < items.length; to++) {
    if (!overlaps(items[from].bounds, items[to].bounds)) continue;
    edges[from].push(to); indegree[to]++;
  }
  var available = [], ordered = [];
  for (var z = 0; z < items.length; z++) if (indegree[z] === 0) available.push(z);
  while (available.length) {
    available.sort(function(a, b) { return rank.get(items[a].node) - rank.get(items[b].node); });
    var next = available.shift(); ordered.push(items[next].node);
    for (var edge = 0; edge < edges[next].length; edge++) {
      var target = edges[next][edge];
      indegree[target]--;
      if (indegree[target] === 0) available.push(target);
    }
  }
  return ordered.length === children.length ? ordered : children.slice();
}

function isCompletelyClippedOut(node, root) {
  var bounds = absoluteBoundsOf(node), ancestor = readProp(node, "parent", null);
  while (ancestor) {
    if (readProp(ancestor, "clipsContent", false)) {
      var clip = absoluteBoundsOf(ancestor);
      var left = Math.max(bounds.left, clip.left), top = Math.max(bounds.top, clip.top);
      var right = Math.min(bounds.right, clip.right), bottom = Math.min(bounds.bottom, clip.bottom);
      if (right - left <= 0.5 || bottom - top <= 0.5) return true;
      bounds = { left: left, top: top, right: right, bottom: bottom, x: left, y: top, width: right - left, height: bottom - top };
    }
    if (ancestor === root) break;
    ancestor = readProp(ancestor, "parent", null);
  }
  return false;
}

function removeInvisibleCloneNodes(root, removedSourceIds, cloneToSource, protectedIds) {
  function visit(parent, protectedByInstance) {
    var children = sceneChildren(parent).slice();
    for (var i = children.length - 1; i >= 0; i--) {
      var child = children[i], sourceId = cloneToSource[child.id];
      var protectedHere = protectedByInstance || readProp(parent, "type", "") === "INSTANCE";
      var invisible = !shouldExportNode(child) || isCompletelyClippedOut(child, root);
      if (protectedHere) { if (invisible) protectedIds.push(sourceId); continue; }
      if (invisible) { removedSourceIds.push(sourceId); child.remove(); continue; }
      visit(child, readProp(child, "type", "") === "INSTANCE");
    }
  }
  visit(root, readProp(root, "type", "") === "INSTANCE");
}

async function optimizeSelection(request) {
  var plan = request && request.plan;
  if (!plan || !Array.isArray(request.expectedSelectionIds) || !request.expectedSelectionIds.length) throw new Error("优化请求缺少 expectedSelectionIds 或 plan");
  var roots = topLevelSelection(figma.currentPage.selection);
  var selectedIds = roots.map(function(node) { return node.id; });
  if (!sameStringSet(selectedIds, request.expectedSelectionIds)) throw new Error("当前 Figma 选区与模型计划不一致；请重新 figma_export 后再生成优化计划");
  var sourceById = {}, rootsById = {}, nodeCount = 0;
  for (var r = 0; r < roots.length; r++) {
    rootsById[roots[r].id] = true;
    walkScene(roots[r], function(node) { sourceById[node.id] = node; nodeCount++; });
  }
  if (nodeCount > 5000) throw new Error("单次节点优化最多支持 5000 个节点");
  var reorderParentIds = Array.isArray(plan.reorderParentIds) ? plan.reorderParentIds : [];
  var ungroupNodeIds = Array.isArray(plan.ungroupNodeIds) ? plan.ungroupNodeIds : [];
  var groups = Array.isArray(plan.groups) ? plan.groups : [];
  var postGroups = Array.isArray(plan.postGroups) ? plan.postGroups : [];
  var rootArchitectureNodeIds = Array.isArray(plan.rootArchitectureNodeIds) ? plan.rootArchitectureNodeIds : [];
  var floatingNodeIds = Array.isArray(plan.floatingNodeIds) ? plan.floatingNodeIds : [];
  if (reorderParentIds.length > 200 || ungroupNodeIds.length > 200 || groups.length + postGroups.length > 100 || rootArchitectureNodeIds.length > 100 || floatingNodeIds.length > 100) throw new Error("优化计划操作数量过多");
  var operationIds = reorderParentIds.concat(ungroupNodeIds, rootArchitectureNodeIds, floatingNodeIds);
  var allGroups = groups.concat(postGroups);
  for (var gi = 0; gi < allGroups.length; gi++) operationIds.push(allGroups[gi].parentId), operationIds = operationIds.concat(allGroups[gi].childIds || []);
  for (var oi = 0; oi < operationIds.length; oi++) if (!sourceById[operationIds[oi]]) throw new Error("优化计划引用了选区外节点：" + operationIds[oi]);
  for (var ri = 0; ri < reorderParentIds.length; ri++) {
    var reorderSource = sourceById[reorderParentIds[ri]];
    if (!sceneChildren(reorderSource).length) throw new Error("排序目标不是容器：" + reorderSource.id);
    if (insideInstance(reorderSource, rootsById)) throw new Error("不能重排组件实例内部结构：" + reorderSource.id);
    if (sceneChildren(reorderSource).some(function(child) { return readProp(child, "isMask", false); })) throw new Error("含蒙版的容器不允许自动重排：" + reorderSource.id);
  }
  for (var ui = 0; ui < ungroupNodeIds.length; ui++) {
    var ungroupSource = sourceById[ungroupNodeIds[ui]];
    if (readProp(ungroupSource, "type", "") !== "GROUP") throw new Error("只允许解组 GROUP：" + ungroupSource.id);
    if (insideInstance(ungroupSource, rootsById)) throw new Error("不能解组组件实例内部节点：" + ungroupSource.id);
  }
  var ungroupSet = {};
  for (var us = 0; us < ungroupNodeIds.length; us++) ungroupSet[ungroupNodeIds[us]] = true;
  function childrenAfterPlannedUngroup(parent) {
    var flattened = [], direct = sceneChildren(parent);
    for (var dc = 0; dc < direct.length; dc++) {
      if (ungroupSet[direct[dc].id]) flattened = flattened.concat(sceneChildren(direct[dc]));
      else flattened.push(direct[dc]);
    }
    return flattened;
  }
  var protectedStructureIds = new Set(rootArchitectureNodeIds.concat(floatingNodeIds));
  for (var pi = 0; pi < allGroups.length; pi++) {
    var spec = allGroups[pi], parent = sourceById[spec.parentId], childIds = spec.childIds || [];
    if (!parent || childIds.length < 2 || childIds.length > 50 || new Set(childIds).size !== childIds.length) throw new Error("成组计划无效：" + String(spec.name || spec.parentId));
    if (insideInstance(parent, rootsById)) throw new Error("不能在组件实例内部成组：" + parent.id);
    var sourceChildren = childrenAfterPlannedUngroup(parent), indexes = [];
    for (var ci = 0; ci < childIds.length; ci++) {
      var child = sourceById[childIds[ci]];
      if (protectedStructureIds.has(childIds[ci])) throw new Error("页面骨架或浮动节点必须保持根级独立：" + childIds[ci]);
      if (!child || sourceChildren.indexOf(child) === -1) throw new Error("成组节点必须是当前父级或计划解组后的直接子节点：" + childIds[ci]);
      indexes.push(sourceChildren.indexOf(child));
    }
    indexes.sort(function(a, b) { return a - b; });
    for (var ii = 1; pi < groups.length && ii < indexes.length; ii++) if (indexes[ii] !== indexes[ii - 1] + 1) {
      var between = sourceChildren.slice(indexes[ii - 1] + 1, indexes[ii]).map(function(node) { return node.id + "(" + String(readProp(node, "name", "")) + ")"; });
      throw new Error("为避免改变层叠关系，只允许将连续同级节点成组：" + String(spec.name) + "；间隔节点：" + between.join("、"));
    }
  }
  var fonts = collectOptimizationFonts(roots);
  var unavailableFonts = [];
  for (var fi = 0; fi < fonts.length; fi++) {
    try { await figma.loadFontAsync(fonts[fi]); }
    catch (fontError) { unavailableFonts.push(fonts[fi].family + " " + fonts[fi].style); }
  }
  var modeCollections = {};
  for (var mr = 0; mr < roots.length; mr++) {
    var modes = readProp(roots[mr], "resolvedVariableModes", {});
    var collectionIds = Object.keys(modes);
    for (var mi = 0; mi < collectionIds.length; mi++) {
      if (!modeCollections[collectionIds[mi]]) {
        var collection = await figma.variables.getVariableCollectionByIdAsync(collectionIds[mi]);
        if (!collection) throw new Error("无法保留变量模式：" + collectionIds[mi]);
        modeCollections[collectionIds[mi]] = collection;
      }
    }
  }
  var clones = [], createdIds = [], mutatedIds = [], sourceToClone = {}, cloneToSource = {};
  try {
    var sourceBounds = roots.map(absoluteBoundsOf);
    var selectionLeft = Math.min.apply(null, sourceBounds.map(function(b) { return b.left; }));
    var selectionRight = Math.max.apply(null, sourceBounds.map(function(b) { return b.right; }));
    var pageRight = selectionRight;
    var pageChildren = sceneChildren(figma.currentPage);
    for (var pc = 0; pc < pageChildren.length; pc++) {
      if (roots.indexOf(pageChildren[pc]) !== -1) continue;
      pageRight = Math.max(pageRight, absoluteBoundsOf(pageChildren[pc]).right);
    }
    var shiftX = pageRight + (typeof request.spacing === "number" ? request.spacing : 200) - selectionLeft;
    for (var cr = 0; cr < roots.length; cr++) {
      var sourceRoot = roots[cr], clone = sourceRoot.clone(), transform = readProp(sourceRoot, "absoluteTransform", null);
      clones.push(clone);
      if (transform) clone.relativeTransform = [[transform[0][0], transform[0][1], transform[0][2] + shiftX], [transform[1][0], transform[1][1], transform[1][2]]];
      else clone.x = sourceBounds[cr].x + shiftX, clone.y = sourceBounds[cr].y;
      clone.name = sourceRoot.name + " · " + (request.copyName || "DOM优化");
      var rootModes = readProp(sourceRoot, "resolvedVariableModes", {}), rootCollectionIds = Object.keys(rootModes);
      for (var rm = 0; rm < rootCollectionIds.length; rm++) clone.setExplicitVariableModeForCollection(modeCollections[rootCollectionIds[rm]], rootModes[rootCollectionIds[rm]]);
      mapCloneTree(sourceRoot, clone, sourceToClone, createdIds);
    }
    var sourceIds = Object.keys(sourceToClone);
    for (var si = 0; si < sourceIds.length; si++) cloneToSource[sourceToClone[sourceIds[si]].id] = sourceIds[si];
    var removedSourceIds = [], protectedInvisibleSourceIds = [];
    if (plan.removeInvisible !== false) for (var rr = 0; rr < clones.length; rr++) removeInvisibleCloneNodes(clones[rr], removedSourceIds, cloneToSource, protectedInvisibleSourceIds);
    var ungroupedSourceIds = [];
    for (var ug = 0; ug < ungroupNodeIds.length; ug++) {
      var groupClone = sourceToClone[ungroupNodeIds[ug]];
      if (!groupClone || readProp(groupClone, "removed", false)) continue;
      var ungrouped = figma.ungroup(groupClone);
      for (var uc = 0; uc < ungrouped.length; uc++) mutatedIds.push(ungrouped[uc].id);
      ungroupedSourceIds.push(ungroupNodeIds[ug]);
    }
    var createdGroups = [];
    function applyPlannedGroups(groupSpecs, stage) {
    for (var gp = 0; gp < groupSpecs.length; gp++) {
      var groupSpec = groupSpecs[gp], groupParent = sourceToClone[groupSpec.parentId];
      if (!groupParent || readProp(groupParent, "removed", false)) continue;
      var groupChildren = groupSpec.childIds.map(function(id) { return sourceToClone[id]; }).filter(function(node) { return node && !readProp(node, "removed", false) && readProp(node, "parent", null) === groupParent; });
      if (groupChildren.length !== groupSpec.childIds.length) throw new Error("成组节点已被其他优化操作移除或改变父级：" + groupSpec.name);
      var currentGroupChildren = sceneChildren(groupParent), currentIndexes = groupChildren.map(function(node) { return currentGroupChildren.indexOf(node); }).sort(function(a, b) { return a - b; });
      for (var cg = 1; cg < currentIndexes.length; cg++) if (currentIndexes[cg] !== currentIndexes[cg - 1] + 1) throw new Error(stage + "成组节点尚未连续，请调整模型计划：" + groupSpec.name);
      var firstIndex = currentIndexes[0];
      groupChildren.sort(function(a, b) { return currentGroupChildren.indexOf(a) - currentGroupChildren.indexOf(b); });
      var newGroup = figma.group(groupChildren, groupParent, firstIndex);
      newGroup.name = groupSpec.name;
      createdIds.push(newGroup.id); mutatedIds.push(newGroup.id);
      createdGroups.push({ id: newGroup.id, name: newGroup.name, sourceChildIds: groupSpec.childIds, stage: stage });
    }
    }
    applyPlannedGroups(groups, "architecture-first");
    var reorderedParentSourceIds = [];
    for (var ro = 0; ro < reorderParentIds.length; ro++) {
      var parentClone = sourceToClone[reorderParentIds[ro]];
      if (!parentClone || readProp(parentClone, "removed", false)) continue;
      var floatingClones = new Set(floatingNodeIds.map(function(id) { return sourceToClone[id]; }).filter(Boolean));
      var current = sceneChildren(parentClone).slice(), ordered = orderVisualComponents(parentClone, current, floatingClones), changed = false;
      for (var oc = 0; oc < ordered.length; oc++) if (ordered[oc] !== current[oc]) { changed = true; break; }
      if (changed) {
        for (var ins = 0; ins < ordered.length; ins++) parentClone.insertChild(ins, ordered[ins]);
        mutatedIds.push(parentClone.id); reorderedParentSourceIds.push(reorderParentIds[ro]);
      }
    }
    applyPlannedGroups(postGroups, "post-order");
    var requiredRootIds = rootArchitectureNodeIds.concat(floatingNodeIds);
    for (var rootCheck = 0; rootCheck < requiredRootIds.length; rootCheck++) {
      var requiredClone = sourceToClone[requiredRootIds[rootCheck]];
      if (!requiredClone || clones.indexOf(readProp(requiredClone, "parent", null)) === -1) throw new Error("页面骨架或浮动节点未保持在优化根级：" + requiredRootIds[rootCheck]);
    }
    figma.currentPage.selection = clones;
    figma.viewport.scrollAndZoomIntoView(clones);
    figma.commitUndo();
    return {
      status: "optimized", summary: plan.summary,
      sourceRootIds: selectedIds, optimizedRootIds: clones.map(function(node) { return node.id; }),
      createdNodeIds: createdIds, mutatedNodeIds: Array.from(new Set(mutatedIds.concat(clones.map(function(node) { return node.id; })))),
      removedInvisibleSourceNodeIds: removedSourceIds, protectedInvisibleSourceNodeIds: protectedInvisibleSourceIds,
      reorderedParentSourceIds: reorderedParentSourceIds, ungroupedSourceNodeIds: ungroupedSourceIds, createdGroups: createdGroups,
      rootArchitectureSourceNodeIds: rootArchitectureNodeIds, floatingSourceNodeIds: floatingNodeIds,
      warnings: unavailableFonts.length ? [{ type: "unavailable-fonts", fonts: unavailableFonts, action: "No text properties were modified; structural optimization continued on the copied nodes." }] : []
    };
  } catch (error) {
    for (var cleanup = 0; cleanup < clones.length; cleanup++) try { if (!readProp(clones[cleanup], "removed", false)) clones[cleanup].remove(); } catch (e) {}
    throw error;
  }
}

// One export at a time, including manual and MCP requests.
var exportInProgress = false;
figma.ui.onmessage = async function(msg) {
  var rid = msg.requestId;
  if (msg.type === "cancel") { figma.closePlugin(); return; }
  if (msg.type !== "export" && msg.type !== "optimize") return;
  if (exportInProgress) {
    figma.ui.postMessage(wrapMsg({ type: "error", message: "已有导出正在执行，请等待完成后重试" }, rid));
    return;
  }
  exportInProgress = true;
  try {
    if (msg.type === "optimize") {
      figma.ui.postMessage(wrapMsg({ type: "progress", message: "正在复制选区并执行节点结构优化..." }, rid));
      var optimized = await optimizeSelection(msg.request);
      figma.ui.postMessage(wrapMsg({ type: "optimized", data: optimized }, rid));
      return;
    }
    var selection = figma.currentPage.selection;
    if (selection.length === 0) throw new Error("请先选中至少一个节点");
    var context = { shapeGroupsAsImages: msg.shapeGroupsAsImages !== false, rasters: [] };
    var nodes = [], names = [];
    figma.ui.postMessage(wrapMsg({ type: "progress", message: "正在读取精确图层边界..." }, rid));
    for (var i = 0; i < selection.length; i++) {
      if (!isEffectivelyVisible(selection[i])) continue;
      // Do not export the same subtree twice if both ancestor and child are selected.
      var ancestor = readProp(selection[i], "parent", null), nested = false;
      while (ancestor) {
        if (selection.indexOf(ancestor) !== -1) { nested = true; break; }
        ancestor = readProp(ancestor, "parent", null);
      }
      if (nested) continue;
      var n = await serializeNodeAsync(selection[i], context);
      if (n) { nodes.push(n); names.push(n.name); }
    }
    if (!nodes.length) throw new Error("选中的节点均已隐藏或透明度为 0，没有可导出的可见节点");
    var data = { meta: { schemaVersion: 3, exporterVersion: "3.5.0", exportedAt: new Date().toISOString(), nodeName: names.join("+"), nodeCount: nodes.length }, nodes: nodes, images: {}, assets: {} };
    data.meta.documentColorProfile = readProp(readProp(figma, "root", {}), "documentColorProfile", "LEGACY");
    var hashes = {};
    for (var i = 0; i < nodes.length; i++) {
      var collected = collectImageHashes(nodes[i]);
      for (var j = 0; j < collected.length; j++) hashes[collected[j]] = true;
    }
    var keys = Object.keys(hashes), imageCount = 0;
    figma.ui.postMessage(wrapMsg({ type: "progress", message: "正在导出图片与组合形状..." }, rid));
    for (var i = 0; i < keys.length; i++) {
      var hash = keys[i], image = figma.getImageByHash(hash);
      if (!image) throw new Error("找不到图片资源：" + hash);
      var bytes = await image.getBytesAsync();
      data.assets[hash] = { id: hash, kind: "image-fill" };
      figma.ui.postMessage(wrapMsg({ type: "image", hash: hash, bytes: Array.from(bytes) }, rid));
      imageCount++;
    }
    // Per-item resilience: one broken layer (e.g. a VECTOR whose
    // absoluteRenderBounds cannot be recovered even in an isolated clone) must
    // not abort a 500-layer export. Failed rasters degrade to their full DOM
    // subtree and the failure is reported in meta.rasterWarnings.
    var exportWarnings = [], failedItems = [], rasterIndex = 0;
    function replaceNodeIn(list, oldNode, newNode) {
      for (var i = 0; i < list.length; i++) {
        if (list[i] === oldNode) { list[i] = newNode; return true; }
        var c = list[i].children;
        if (c && replaceNodeIn(c, oldNode, newNode)) return true;
      }
      return false;
    }
    async function exportPendingRasters() {
      while (rasterIndex < context.rasters.length) {
        var item = context.rasters[rasterIndex++];
        try {
          var bytes = await exportRaster(item);
          var pixels = rasterPixelSize(bytes, item.bounds);
          item.layer.imageBounds = item.bounds;
          item.layer.imageBoundsSource = item.boundsSource;
          data.assets[item.id] = { id: item.id, kind: item.kind, rasterReason: item.reason, nodeId: item.node.id, scale: 2, bounds: item.bounds, boundsSource: item.boundsSource, layoutBounds: item.layoutBounds, pixelWidth: pixels.width, pixelHeight: pixels.height, colorProfile: "SRGB", opacityBaked: true };
          figma.ui.postMessage(wrapMsg({ type: "image", hash: item.id, bytes: Array.from(bytes) }, rid));
          imageCount++;
        } catch (e) {
          failedItems.push(item);
          exportWarnings.push({ id: item.layer.id, name: item.layer.name, nodeType: item.node.type, rasterReason: item.reason, action: "degraded-to-dom", message: String((e && e.message) || e) });
        }
      }
    }
    // Each pass exports pending rasters, then re-serializes failed layers with
    // their ids excluded from rasterization. Recovery may queue new rasters
    // (nested shape groups), so iterate until a pass fails nothing. A failed id
    // is never re-queued, so the loop terminates.
    var passes = 0;
    do {
      await exportPendingRasters();
      if (!failedItems.length) break;
      var skipIds = {};
      for (var f = 0; f < failedItems.length; f++) skipIds[failedItems[f].layer.id] = true;
      var retry = failedItems;
      failedItems = [];
      for (var f = 0; f < retry.length; f++) {
        var bad = retry[f];
        var replacement = await serializeNodeAsync(bad.node, { shapeGroupsAsImages: context.shapeGroupsAsImages, rasters: context.rasters, skipRasterIds: skipIds });
        if (!replacement || !replaceNodeIn(nodes, bad.layer, replacement)) throw new Error("无法恢复栅格化失败图层（DOM 降级失败）：" + bad.layer.id + " " + bad.layer.name);
      }
      passes++;
    } while (passes < 5);
    if (exportWarnings.length) {
      data.meta.rasterWarnings = exportWarnings;
      // A recovered subtree may carry image fills the first hash sweep missed.
      for (var i = 0; i < nodes.length; i++) {
        var collected = collectImageHashes(nodes[i]);
        for (var j = 0; j < collected.length; j++) {
          if (data.assets[collected[j]]) continue;
          var image = figma.getImageByHash(collected[j]);
          if (!image) throw new Error("找不到图片资源：" + collected[j]);
          var bytes = await image.getBytesAsync();
          data.assets[collected[j]] = { id: collected[j], kind: "image-fill" };
          figma.ui.postMessage(wrapMsg({ type: "image", hash: collected[j], bytes: Array.from(bytes) }, rid));
          imageCount++;
        }
      }
    }
    // Strip internal image bookkeeping, retaining only public metadata and geometry.
    function clean(n) { delete n._imageHashes; if (n.children) n.children.forEach(clean); }
    // Recovery can change the image canvas; derive offsets only after exports.
    nodes.forEach(function(n) { addRelativeBounds(n, n, null); });
    nodes.forEach(clean);
    figma.ui.postMessage(wrapMsg({ type: "done", data: JSON.parse(JSON.stringify(data)), imageCount: imageCount }, rid));
  } catch (error) {
    figma.ui.postMessage(wrapMsg({ type: "error", message: (msg.type === "optimize" ? "节点优化失败：" : "导出失败：") + (error && error.message ? error.message : error) }, rid));
  } finally {
    exportInProgress = false;
  }
};
