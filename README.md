# Figma JSON Exporter

[English](README.en.md) | 简体中文

将 Figma 当前选区或 Pen `.pen` 文件导出为结构化 JSON、资源文件和可直接检查的 HTML 预览，并通过本地 MCP 提供导出、结构优化和布局校验能力。

## 功能

- 导出节点层级、几何、文本、填充、描边、渐变、图片与字体信息。
- 生成 `design.json`、语义规划、资源清单和 HTML/CSS 预览。
- 基于模型计划，在 Figma 中创建并优化选区副本，不修改原图层。
- 使用浏览器实测结果校验实现与设计稿的几何差异。
- 支持无需 Figma 插件的 Pen `.pen` 文件导出。

## 要求

- Node.js 22+
- Figma Desktop（仅 Figma 模式需要）

## 安装与构建

```bash
npm ci
npm run build
```

服务会打包到 `dist/mcp-server.js`。`dist/` 不提交到 Git，首次安装或修改源码后需要重新构建。

## MCP 配置

默认使用 stdio。将配置中的路径替换为本机绝对路径：

```json
{
  "mcpServers": {
    "figma-json-exporter": {
      "command": "node",
      "args": ["/absolute/path/to/figma-json-exporter/dist/mcp-server.js"]
    }
  }
}
```

也可以启动 Streamable HTTP：

```bash
node dist/mcp-server.js --transport=http
```

MCP 地址为 `http://127.0.0.1:3456/mcp`，示例见 `mcp-config.http.json`。

## 安装 Figma 插件

1. 在 Figma Desktop 中打开 Plugins → Development → Import plugin from manifest。
2. 选择本项目的 `manifest.json`。
3. 保留 `manifest.json`、`code.js` 和 `ui.html` 在同一目录。
4. 运行插件并连接本地服务。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `figma_status` | 检查 Figma 插件连接，或检查 Pen 文件并列出顶层节点。 |
| `figma_export` | 导出当前选区或 Pen 节点，生成设计数据、资源和基础预览。 |
| `figma_optimize_selection` | 根据节点 ID 白名单计划，在画布右侧创建并优化副本。 |
| `figma_assess_preview` | 记录预览中需要保留和修正的决策，生成布局校验前置文件。 |
| `figma_guidance` | 按工作流或图层属性标签加载实现规范。 |
| `figma_validate_layout` | 对比浏览器实测矩形与设计数据，输出逐层偏差报告。 |

## 推荐工作流

### 导出并实现

1. 调用 `figma_status` 确认连接。
2. 调用 `figma_export` 读取当前选区。
3. 打开返回的 `previewHtmlPath`，并读取 `previewCssPath` 与 `generationManifestPath`。
4. 调用 `figma_assess_preview` 记录预览判断。
5. 基于预览实现页面，保留 `data-d2c-id`，不要使用 CSS Grid。
6. 调用 `figma_validate_layout` 建立 baseline。
7. 将结构调整为健康的文档流或 Flex 布局，再次校验。

只有校验结果中的 `workflowComplete: true` 表示自动门禁已完成；仍需人工检查最终视觉效果。

### 优化 Figma 节点结构

1. 保持目标选区不变并调用 `figma_export`。
2. 模型根据最新层级和绝对几何制定仅含节点 ID 的计划。
3. 调用 `figma_optimize_selection` 创建优化副本。

优化器会删除不可见或被祖先完全裁剪的节点，并优先建立页面架构层级，再按左上角位置整理同级顺序。可使用：

- `rootArchitectureNodeIds`：将状态栏、主体、底部栏等页面骨架保持在根层级。
- `floatingNodeIds`：将悬浮控件、收起态等独立覆盖元素保持在根层级并按覆盖关系处理。

原选区不会修改。Instance 内部、蒙版、非连续同级分组、过期选区等不安全计划会被拒绝；一次 Undo 可撤销创建的副本。

## Pen 模式

Pen 模式直接读取本地 `.pen` JSON，不依赖 Figma 插件：

```json
{
  "mode": "pen",
  "penPath": "/absolute/path/design.pen",
  "nodeIds": ["screen-id"]
}
```

需要精确补充几何或栅格资源时，可传入 `penBounds` 和 `penRasters`。不支持的动态内容会明确报错，不会静默降级。

## 导出结果

每次导出都会创建独立目录，主要包含：

```text
export-<request-id>/
├── design.json
├── semantic-plan.json
├── generation-manifest.json
├── assets/
└── preview/
    ├── index.html
    └── styles.css
```

默认返回紧凑摘要和文件路径；仅在确实需要完整节点 JSON 时使用 `responseMode: "full"`。

## 关键约束

- 生成预览和后续实现禁止使用 CSS Grid，重叠结构使用文档流、Flex 和受控定位表达。
- 图片填充属于内容，不会被当作普通形状参与父级合并。
- 复杂矢量、图片、字体或效果可能按资源导出，以保证视觉还原。
- 共享服务仅监听本机回环地址；多个客户端复用服务，导出请求串行执行。

## 开发

```bash
npm test
```

## License

[MIT](LICENSE)
