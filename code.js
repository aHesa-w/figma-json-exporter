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
  var base = { type: paint.type, opacity: opacity, visible: visible };

  if (paint.type === "SOLID") {
    base.color = colorToRgba(paint.color, opacity);
    return base;
  }
  if (paint.type.indexOf("GRADIENT") !== -1) {
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
  if (paint.type === "IMAGE") {
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
  if (effect.offset) obj.offset = effect.offset;
  if (effect.spread !== undefined) obj.spread = effect.spread;
  return obj;
}

function serializeNode(node) {
  var base = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible !== undefined ? node.visible : true
  };

  if ("x" in node) base.x = Math.round(node.x);
  if ("y" in node) base.y = Math.round(node.y);
  if ("width" in node) base.width = Math.round(node.width);
  if ("height" in node) base.height = Math.round(node.height);
  if ("rotation" in node) base.rotation = node.rotation;
  if ("opacity" in node) base.opacity = node.opacity;
  if ("blendMode" in node) base.blendMode = node.blendMode;
  if ("cornerRadius" in node) base.cornerRadius = node.cornerRadius;
  if ("topLeftRadius" in node) {
    base.cornerRadii = {
      topLeft: node.topLeftRadius,
      topRight: node.topRightRadius,
      bottomRight: node.bottomRightRadius,
      bottomLeft: node.bottomLeftRadius
    };
  }

  if ("fills" in node && node.fills !== figma.mixed) {
    var fills = [];
    for (var i = 0; i < node.fills.length; i++) fills.push(serializePaint(node.fills[i]));
    base.fills = fills;
  }
  if ("strokes" in node) {
    var strokes = [];
    for (var i = 0; i < node.strokes.length; i++) strokes.push(serializePaint(node.strokes[i]));
    base.strokes = strokes;
    base.strokeWeight = node.strokeWeight;
    base.strokeAlign = node.strokeAlign;
  }

  if ("effects" in node && node.effects.length > 0) {
    var effects = [];
    for (var i = 0; i < node.effects.length; i++) effects.push(serializeEffect(node.effects[i]));
    base.effects = effects;
  }

  if ("constraints" in node) base.constraints = node.constraints;

  if (node.type === "TEXT") {
    base.characters = node.characters;
    base.fontSize = node.fontSize !== figma.mixed ? node.fontSize : "mixed";
    base.fontName = node.fontName !== figma.mixed ? node.fontName : "mixed";
    base.textAlignHorizontal = node.textAlignHorizontal;
    base.textAlignVertical = node.textAlignVertical;
    base.lineHeight = node.lineHeight !== figma.mixed ? node.lineHeight : "mixed";
    base.letterSpacing = node.letterSpacing !== figma.mixed ? node.letterSpacing : "mixed";
    base.textDecoration = node.textDecoration !== figma.mixed ? node.textDecoration : "mixed";
  }

  if ("layoutMode" in node && node.layoutMode !== "NONE") {
    base.autoLayout = {
      mode: node.layoutMode,
      paddingLeft: node.paddingLeft,
      paddingRight: node.paddingRight,
      paddingTop: node.paddingTop,
      paddingBottom: node.paddingBottom,
      itemSpacing: node.itemSpacing,
      primaryAxisAlignItems: node.primaryAxisAlignItems,
      counterAxisAlignItems: node.counterAxisAlignItems,
      primaryAxisSizingMode: node.primaryAxisSizingMode,
      counterAxisSizingMode: node.counterAxisSizingMode
    };
  }

  if (node.type === "INSTANCE") {
    base.componentId = node.mainComponent ? node.mainComponent.id : null;
    base.componentName = node.mainComponent ? node.mainComponent.name : null;
  }

  // 收集图片哈希
  var imageHashes = [];
  if ("fills" in node && node.fills !== figma.mixed) {
    for (var i = 0; i < node.fills.length; i++) {
      var fill = node.fills[i];
      if (fill.type === "IMAGE" && fill.imageHash) {
        imageHashes.push(fill.imageHash);
      }
    }
  }
  if (imageHashes.length > 0) base._imageHashes = imageHashes;

  if ("children" in node) {
    var children = [];
    for (var i = 0; i < node.children.length; i++) {
      children.push(serializeNode(node.children[i]));
    }
    base.children = children;
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

figma.ui.onmessage = function(msg) {
  if (msg.type === "export") {
    var selection = figma.currentPage.selection;
    if (selection.length === 0) {
      figma.ui.postMessage({ type: "error", message: "请先选中至少一个节点" });
      return;
    }

    figma.ui.postMessage({ type: "progress", message: "正在序列化节点..." });

    var nodes = [];
    for (var i = 0; i < selection.length; i++) {
      nodes.push(serializeNode(selection[i]));
    }

    var exportData = {
      meta: {
        exportedAt: new Date().toISOString(),
        figmaFileName: figma.root.name,
        pageId: figma.currentPage.id,
        pageName: figma.currentPage.name,
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
      figma.ui.postMessage({ type: "done", data: cleanData0 });
      return;
    }

    figma.ui.postMessage({ type: "progress", message: "导出图片资源 (" + hashList.length + " 张)..." });

    // 逐个导出图片（async 递归）
    var imageResults = {};
    var index = 0;

    function exportNext() {
      if (index >= hashList.length) {
        exportData.images = imageResults;
        var cleanData = JSON.parse(JSON.stringify(exportData));
        figma.ui.postMessage({ type: "done", data: cleanData });
        return;
      }
      var hash = hashList[index];
      index++;
      var image = figma.getImageByHash(hash);
      if (!image) {
        exportNext();
        return;
      }
      image.getBytesAsync().then(function(bytes) {
        var binary = "";
        for (var k = 0; k < bytes.length; k++) {
          binary += String.fromCharCode(bytes[k]);
        }
        imageResults[hash] = "data:image/png;base64," + btoa(binary);
        exportNext();
      }).catch(function() {
        exportNext();
      });
    }

    exportNext();
  }

  if (msg.type === "cancel") {
    figma.closePlugin();
  }
};
