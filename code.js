// Figma JSON Exporter - Figma 插件沙箱导出逻辑

figma.showUI(__html__, { width: 360, height: 280, title: "JSON Exporter" });

// ── 工具函数 ──────────────────────────────────────────────────────────────

function colorToRgba(color, opacity) {
  if (!color) return null;
  var op = opacity !== undefined ? opacity : 1;
  var r = Math.round(color.r * 255);
  var g = Math.round(color.g * 255);
  var b = Math.round(color.b * 255);
  var a = (color.a !== undefined ? color.a : 1) * op;
  return "rgba(" + r + "," + g + "," + b + "," + a.toFixed(2) + ")";
}

function serializePaint(paint) {
  var opacity = paint.opacity !== undefined ? paint.opacity : 1;
  var visible = paint.visible !== undefined ? paint.visible : true;
  var type = paint.type;
  var base = { type: type, opacity: opacity, visible: visible };

  if (type === "SOLID") {
    base.color = colorToRgba(paint.color, opacity);
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

// Prune invisible subtrees before serializing or collecting image resources.
function shouldExportNode(node) {
  return readProp(node, "visible", true) !== false && readProp(node, "opacity", 1) !== 0;
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
  if (node.children) for (var i = 0; i < node.children.length; i++) addRelativeBounds(node.children[i], root, node);
}

function isPureShape(node) {
  var type = readProp(node, "type", "");
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
    css: unit === "AUTO" ? "normal" : unit === "PERCENT" ? value + "%" : unit === "PIXELS" ? value + "px" : null,
    pixels: unit === "PIXELS" ? value : unit === "PERCENT" && typeof fontSize === "number" ? fontSize * value / 100 : null
  };
}

// Explicit portable/system-font policy, not a vendor-name blacklist. A local
// browser font inventory is not available in the Figma sandbox.
var SYSTEM_FONT_FAMILIES = ["arial", "arial black", "helvetica", "helvetica neue", "times new roman", "times", "georgia", "verdana", "tahoma", "trebuchet ms", "courier new", "courier", "segoe ui", "sf pro", "sf pro display", "sf pro text", "pingfang sc", "pingfang tc", "pingfang hk", "microsoft yahei", "microsoft jhenghei", "simsun", "simhei", "songti sc", "heiti sc", "hiragino sans", "hiragino sans gb", "sans-serif", "serif", "monospace", "system-ui", "-apple-system", "blinkmacsystemfont"];
function textRasterReason(node, base) {
  if (base.type !== "TEXT") return null;
  if (readProp(node, "hasMissingFont", false)) return "missing-font";
  var fonts = [];
  if (base.fontName !== "mixed") fonts = [base.fontName];
  else {
    try { fonts = node.getRangeAllFontNames(0, base.characters.length); } catch (e) { return "unknown-font"; }
  }
  if (!fonts.length) return "unknown-font";
  for (var i = 0; i < fonts.length; i++) {
    var family = String(fonts[i].family || "").trim().toLowerCase();
    if (SYSTEM_FONT_FAMILIES.indexOf(family) === -1) return "non-system-font";
  }
  if (base.fontName === "mixed" || base.fontSize === "mixed" || base.lineHeight === "mixed") return "mixed-text-style";
  return null;
}

function serializeLetterSpacing(letterSpacing) {
  if (!letterSpacing || isMixed(letterSpacing)) return "mixed";
  return {
    unit: readProp(letterSpacing, "unit", "PIXELS"),
    value: readProp(letterSpacing, "value", 0)
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

  var result = [];
  for (var i = 0; i < paints.length; i++) result.push(serializePaint(paints[i]));
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
  base.clipsContent = readProp(node, "clipsContent", false);
  base.isMask = readProp(node, "isMask", false);
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
  if (effects && !isMixed(effects) && effects.length > 0) {
    base.effects = [];
    for (var i = 0; i < effects.length; i++) base.effects.push(serializeEffect(effects[i]));
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
    base.letterSpacing = serializeLetterSpacing(readProp(node, "letterSpacing", null));
    base.textDecoration = serializeMixedValue(readProp(node, "textDecoration", "mixed"));
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
      counterAxisSizingMode: readProp(node, "counterAxisSizingMode", "AUTO")
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

  var rasterReason = textRasterReason(node, base);
  var visibleChildren = readProp(node, "children", []).filter(shouldExportNode);
  var imageLeaf = collectImageHashesFromNode(node).length > 0 && visibleChildren.length === 0;
  var shape = context && context.shapeGroupsAsImages &&
      (base.type === "VECTOR" || base.type === "BOOLEAN_OPERATION" || (base.type === "GROUP" && isPureShape(node)));
  if (context && (rasterReason || imageLeaf || shape)) {
    base.renderAs = "image";
    base.assetId = "node-" + base.id;
    base.rasterReason = rasterReason || (imageLeaf ? "image-paint" : "composite-shape");
    base.collapsedNodeIds = visibleDescendantIds(node);
    // Retain original image bytes as well as the faithful cropped/filtered PNG.
    if (!imageLeaf) delete base._imageHashes;
    context.rasters.push({ id: base.assetId, node: node, bounds: base.absoluteBounds, kind: base.type === "TEXT" ? "text" : imageLeaf ? "image-render" : "shape", reason: base.rasterReason });
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

// One export at a time, including manual and MCP requests.
var exportInProgress = false;
figma.ui.onmessage = async function(msg) {
  var rid = msg.requestId;
  if (msg.type === "cancel") { figma.closePlugin(); return; }
  if (msg.type !== "export") return;
  if (exportInProgress) {
    figma.ui.postMessage(wrapMsg({ type: "error", message: "已有导出正在执行，请等待完成后重试" }, rid));
    return;
  }
  exportInProgress = true;
  try {
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
      if (n) { nodes.push(n); names.push(n.name); addRelativeBounds(n, n, null); }
    }
    if (!nodes.length) throw new Error("选中的节点均已隐藏或透明度为 0，没有可导出的可见节点");
    var data = { meta: { schemaVersion: 3, exporterVersion: "3.1.0", exportedAt: new Date().toISOString(), nodeName: names.join("+"), nodeCount: nodes.length }, nodes: nodes, images: {}, assets: {} };
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
    for (var i = 0; i < context.rasters.length; i++) {
      var item = context.rasters[i];
      var bytes = await item.node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 }, contentsOnly: true, useAbsoluteBounds: true });
      data.assets[item.id] = { id: item.id, kind: item.kind, rasterReason: item.reason, nodeId: item.node.id, scale: 2, bounds: item.bounds, opacityBaked: true };
      figma.ui.postMessage(wrapMsg({ type: "image", hash: item.id, bytes: Array.from(bytes) }, rid));
      imageCount++;
    }
    // Strip internal image bookkeeping, retaining only public metadata and geometry.
    function clean(n) { delete n._imageHashes; if (n.children) n.children.forEach(clean); }
    nodes.forEach(clean);
    figma.ui.postMessage(wrapMsg({ type: "done", data: JSON.parse(JSON.stringify(data)), imageCount: imageCount }, rid));
  } catch (error) {
    figma.ui.postMessage(wrapMsg({ type: "error", message: "导出失败：" + (error && error.message ? error.message : error) }, rid));
  } finally {
    exportInProgress = false;
  }
};
