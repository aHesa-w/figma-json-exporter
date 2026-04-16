// Figma JSON Exporter - 主逻辑
// 导出选中节点的完整 JSON + 图片资源

figma.showUI(__html__, { width: 360, height: 280, title: "JSON Exporter" });

// ── 工具函数 ──────────────────────────────────────────────────────────────

// 把 Figma 颜色对象转成 rgba 字符串
function colorToRgba(color, opacity = 1) {
  if (!color) return null;
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  const a = (color.a !== undefined ? color.a : 1) * opacity;
  return `rgba(${r},${g},${b},${a.toFixed(2)})`;
}

// 序列化 paint（fills/strokes）
function serializePaint(paint) {
  const base = { type: paint.type, opacity: paint.opacity ?? 1, visible: paint.visible ?? true };
  if (paint.type === "SOLID") {
    return { ...base, color: colorToRgba(paint.color, paint.opacity ?? 1) };
  }
  if (paint.type.includes("GRADIENT")) {
    return {
      ...base,
      gradientStops: paint.gradientStops?.map(s => ({
        position: s.position,
        color: colorToRgba(s.color),
      })),
    };
  }
  if (paint.type === "IMAGE") {
    return { ...base, imageHash: paint.imageHash, scaleMode: paint.scaleMode };
  }
  return base;
}

// 序列化效果（shadows, blur）
function serializeEffect(effect) {
  return {
    type: effect.type,
    visible: effect.visible ?? true,
    radius: effect.radius,
    color: effect.color ? colorToRgba(effect.color) : undefined,
    offset: effect.offset,
    spread: effect.spread,
  };
}

// 递归序列化节点
function serializeNode(node) {
  const base = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible ?? true,
  };

  // 几何属性
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
      bottomLeft: node.bottomLeftRadius,
    };
  }

  // 填充 & 描边
  if ("fills" in node && node.fills !== figma.mixed) {
    base.fills = node.fills.map(serializePaint);
  }
  if ("strokes" in node) {
    base.strokes = node.strokes.map(serializePaint);
    base.strokeWeight = node.strokeWeight;
    base.strokeAlign = node.strokeAlign;
  }

  // 效果
  if ("effects" in node && node.effects.length > 0) {
    base.effects = node.effects.map(serializeEffect);
  }

  // 约束
  if ("constraints" in node) {
    base.constraints = node.constraints;
  }

  // 文字
  if (node.type === "TEXT") {
    base.characters = node.characters;
    base.fontSize = node.fontSize !== figma.mixed ? node.fontSize : "mixed";
    base.fontName = node.fontName !== figma.mixed ? node.fontName : "mixed";
    base.fontWeight = node.fontName !== figma.mixed ? node.fontName.style : "mixed";
    base.textAlignHorizontal = node.textAlignHorizontal;
    base.textAlignVertical = node.textAlignVertical;
    base.lineHeight = node.lineHeight !== figma.mixed ? node.lineHeight : "mixed";
    base.letterSpacing = node.letterSpacing !== figma.mixed ? node.letterSpacing : "mixed";
    base.textDecoration = node.textDecoration !== figma.mixed ? node.textDecoration : "mixed";
  }

  // Auto Layout
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
      counterAxisSizingMode: node.counterAxisSizingMode,
    };
  }

  // 组件引用
  if (node.type === "INSTANCE") {
    base.componentId = node.mainComponent?.id;
    base.componentName = node.mainComponent?.name;
  }

  // 图片哈希收集（用于后续 exportAsync）
  const imageHashes = [];
  if ("fills" in node && node.fills !== figma.mixed) {
    for (const fill of node.fills) {
      if (fill.type === "IMAGE" && fill.imageHash) {
        imageHashes.push(fill.imageHash);
      }
    }
  }
  if (imageHashes.length > 0) base._imageHashes = imageHashes;

  // 递归子节点
  if ("children" in node) {
    base.children = node.children.map(serializeNode);
  }

  return base;
}

// 收集所有图片哈希
function collectImageHashes(nodeJson) {
  const hashes = new Set();
  function walk(n) {
    if (n._imageHashes) n._imageHashes.forEach(h => hashes.add(h));
    if (n.children) n.children.forEach(walk);
  }
  walk(nodeJson);
  return [...hashes];
}

// ── 消息处理 ──────────────────────────────────────────────────────────────

figma.ui.onmessage = async (msg) => {
  if (msg.type === "export") {
    const selection = figma.currentPage.selection;
    if (selection.length === 0) {
      figma.ui.postMessage({ type: "error", message: "请先选中至少一个节点" });
      return;
    }

    figma.ui.postMessage({ type: "progress", message: "正在序列化节点..." });

    // 序列化所有选中节点
    const nodes = selection.map(serializeNode);
    const exportData = {
      meta: {
        exportedAt: new Date().toISOString(),
        figmaFileName: figma.root.name,
        pageId: figma.currentPage.id,
        pageName: figma.currentPage.name,
        nodeCount: selection.length,
      },
      nodes,
    };

    // 收集所有图片哈希
    const allHashes = new Set();
    nodes.forEach(n => collectImageHashes(n).forEach(h => allHashes.add(h)));

    // 导出图片
    const images = {};
    if (allHashes.size > 0) {
      figma.ui.postMessage({ type: "progress", message: `导出图片资源 (${allHashes.size} 张)...` });
      for (const hash of allHashes) {
        try {
          const image = figma.getImageByHash(hash);
          if (image) {
            const bytes = await image.getBytesAsync();
            // 转 base64
            let binary = "";
            for (let i = 0; i < bytes.length; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            images[hash] = "data:image/png;base64," + btoa(binary);
          }
        } catch (e) {
          console.warn(`图片导出失败 ${hash}: ${e}`);
        }
      }
    }

    exportData.images = images;

    figma.ui.postMessage({ type: "progress", message: "准备下载..." });
    figma.ui.postMessage({ type: "done", data: exportData });
  }

  if (msg.type === "cancel") {
    figma.closePlugin();
  }
};
