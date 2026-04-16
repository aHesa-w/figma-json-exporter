# figma-json-exporter

Figma 插件，导出选中节点的完整 JSON 数据，包含图片资源。

## 导出内容

- 节点树结构（type、name、id、层级关系）
- 几何属性（位置、尺寸、旋转）
- 样式（填充、描边、效果、圆角）
- 文字（内容、字体、对齐、行高）
- Auto Layout 配置
- 约束（constraints）
- 组件引用（instance → component）
- 图片资源（Base64 内嵌，可选）

## 安装到 Figma

1. 打开 Figma Desktop
2. 菜单 → Plugins → Development → Import plugin from manifest
3. 选择本目录下的 `manifest.json`

## 使用

1. 在 Figma 画布中选中节点
2. 运行插件（Plugins → Development → Figma JSON Exporter）
3. 点击「导出 JSON」
4. 自动下载 `.json` 文件

## 文件结构

```
manifest.json   # 插件配置
code.js         # 主逻辑（运行在 Figma 沙箱）
ui.html         # 插件 UI
```

## 导出格式

```json
{
  "meta": {
    "exportedAt": "2026-04-16T...",
    "figmaFileName": "设计稿名",
    "pageName": "Page 1",
    "nodeCount": 3
  },
  "nodes": [...],
  "images": {
    "<imageHash>": "data:image/png;base64,..."
  }
}
```
