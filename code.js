// Figma JSON Exporter - 纯 ES5，兼容 Figma 插件沙箱

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

function serializeLineHeight(lineHeight) {
  if (!lineHeight || isMixed(lineHeight)) return "mixed";
  return {
    unit: readProp(lineHeight, "unit", "AUTO"),
    value: readProp(lineHeight, "value", null)
  };
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
  var fills = readProp(node, "fills", null);
  if (!fills || isMixed(fills)) return hashes;

  for (var i = 0; i < fills.length; i++) {
    var fill = fills[i];
    if (fill.type === "IMAGE" && fill.imageHash) hashes.push(fill.imageHash);
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

  if (hasProp(node, "x")) base.x = Math.round(readProp(node, "x", 0));
  if (hasProp(node, "y")) base.y = Math.round(readProp(node, "y", 0));
  if (hasProp(node, "width")) base.width = Math.round(readProp(node, "width", 0));
  if (hasProp(node, "height")) base.height = Math.round(readProp(node, "height", 0));
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
    base.fontName = serializeFontName(readProp(node, "fontName", null));
    base.textAlignHorizontal = readProp(node, "textAlignHorizontal", "LEFT");
    base.textAlignVertical = readProp(node, "textAlignVertical", "TOP");
    base.lineHeight = serializeLineHeight(readProp(node, "lineHeight", null));
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
async function serializeNodeAsync(node) {
  var base = serializeNodeBase(node);

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
      base.children.push(await serializeNodeAsync(children[i]));
    }
  }

  return base;
}

// 同步版本保留（用于不需要异步访问的场景）
function serializeNode(node) {
  var base = serializeNodeBase(node);

  if (base.type === "INSTANCE") {
    base.isInstance = true;
    // mainComponent 需要异步访问，在 serializeNodeAsync 中处理
  }

  var children = readProp(node, "children", null);
  if (children) {
    base.children = [];
    for (var i = 0; i < children.length; i++) {
      base.children.push(serializeNode(children[i]));
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

figma.ui.onmessage = async function(msg) {
  var rid = msg.requestId;

  if (msg.type === "export") {
    try {
      var selection = figma.currentPage.selection;
      if (selection.length === 0) {
        figma.ui.postMessage(wrapMsg({ type: "error", message: "请先选中至少一个节点" }, rid));
        return;
      }

      figma.ui.postMessage(wrapMsg({ type: "progress", message: "正在序列化节点..." }, rid));

      var nodes = [];
      var nodeNames = [];
      for (var i = 0; i < selection.length; i++) {
        nodes.push(await serializeNodeAsync(selection[i]));
        nodeNames.push(readProp(selection[i], "name", "node"));
      }

      var exportData = {
        meta: {
          exportedAt: new Date().toISOString(),
          nodeName: nodeNames.join("+"),
          nodeCount: selection.length
        },
        nodes: nodes,
        images: {}
      };

      // 收集所有图片哈希
      var allHashes = {};
      for (var i = 0; i < nodes.length; i++) {
        var hs = collectImageHashes(nodes[i]);
        for (var j = 0; j < hs.length; j++) allHashes[hs[j]] = true;
      }
      var hashList = Object.keys(allHashes);

      if (hashList.length === 0) {
        var cleanData0 = JSON.parse(JSON.stringify(exportData));
        figma.ui.postMessage(wrapMsg({ type: "done", data: cleanData0 }, rid));
        return;
      }

      figma.ui.postMessage(wrapMsg({ type: "progress", message: "导出图片资源 (" + hashList.length + " 张)..." }, rid));

      // 并行导出所有图片，bytes 直接传给 UI 侧做 base64 转换
      // （避免 ES5 var 闭包 bug 和插件沙箱 btoa 大文件限制）
      var promises = [];
      for (var i = 0; i < hashList.length; i++) {
        (function(hash) {
          var image = figma.getImageByHash(hash);
          if (!image) return;
          var p = image.getBytesAsync().then(function(bytes) {
            return { hash: hash, bytes: Array.from(bytes) };
          }).catch(function() {
            return null;
          });
          promises.push(p);
        })(hashList[i]);
      }

      Promise.all(promises).then(function(results) {
        var imageCount = 0;
        var cleanData = JSON.parse(JSON.stringify(exportData));
        var pending = results.length;

        if (pending === 0) {
          figma.ui.postMessage(wrapMsg({ type: "done", data: cleanData, imageCount: 0 }, rid));
          return;
        }

        for (var i = 0; i < results.length; i++) {
          (function(result) {
            if (!result) {
              pending--;
              if (pending === 0) figma.ui.postMessage(wrapMsg({ type: "done", data: cleanData, imageCount: imageCount }, rid));
              return;
            }

            imageCount++;
            figma.ui.postMessage(wrapMsg({ type: "image", hash: result.hash, bytes: result.bytes }, rid));
            pending--;
            if (pending === 0) figma.ui.postMessage(wrapMsg({ type: "done", data: cleanData, imageCount: imageCount }, rid));
          })(results[i]);
        }
      }).catch(function(e) {
        figma.ui.postMessage(wrapMsg({ type: "error", message: "导出图片失败：" + (e && e.message ? e.message : e) }, rid));
      });
    } catch (e) {
      figma.ui.postMessage(wrapMsg({ type: "error", message: "导出失败：" + (e && e.message ? e.message : e) }, rid));
    }
  }

  if (msg.type === "cancel") {
    figma.closePlugin();
  }
};
