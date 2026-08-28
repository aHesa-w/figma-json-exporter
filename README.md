# Figma JSON Exporter

Figma 选区导出插件和本地 MCP Server。MCP 完全使用 TypeScript 实现，预先编译、打包为 `dist/mcp-server.js`，运行时只需要 Node.js 22 或更高版本，不调用 Go、TypeScript 编译器或包管理器。

## 构建

```bash
npm ci
npm run build
```

构建先执行类型检查，再将服务及运行依赖打包成一个 JS 文件。`dist/` 不提交 Git；首次安装或修改源码后需重新构建。编译产物可单独复制到其他目录运行，无需旁置 `src/` 或 `node_modules/`。

项目的 `.npmrc` 使用公共 npm registry，不依赖公司内部镜像，也不修改全局 npm 配置。

```bash
node /absolute/path/to/figma-json-exporter/dist/mcp-server.js
```

默认使用 **stdio MCP**。入口先检查本机共享服务：没有服务时，使用同一个编译产物启动后台 HTTP/WebSocket 服务，再通过 stdio 接受 Agent 调用。多个 Agent 复用一个服务，导出请求串行处理，并按 `requestId` 隔离。

这里的“本地服务”仍需处理 MCP 和 WebSocket，不是仅提供文件下载的静态资源服务器。启动时不编译源码，不依赖任何模型供应商。

## MCP 配置

默认的 `mcp-config.json` 和 `mcp-config.stdio.json` 都使用编译入口，将其中的路径改为本机绝对路径：

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

- `figma_status`：检查 Figma 插件连接状态。
- `figma_export`：先将图片写入本地，再返回当前选区的可见节点 JSON 和文件路径。
- `figma_validate_layout`：将浏览器实测矩形与设计 JSON 比较，返回逐层偏差及完整报告路径。

如需 Streamable HTTP，先在本机启动：

```bash
node dist/mcp-server.js --transport=http
# 或 npm run serve / ./figma-export.sh serve
```

然后使用 `mcp-config.http.json` 中的 `http://127.0.0.1:3456/mcp`。协议由 [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x) 实现。

## Figma 插件

1. 在 Figma Desktop 中打开 Plugins → Development → Import plugin from manifest。
2. 选择本目录的 `manifest.json`。
3. 选中设计节点，运行 JSON Exporter 插件。
4. 手动点击“导出”，或等插件连接本机服务后通过 Agent 调用 MCP。

插件需要保留 `manifest.json`、`code.js` 和 `ui.html`。UI 的“启动”按钮只重新检测和连接服务；本地进程由 JS 入口启动。“关闭”会停止共享服务，再次启动 stdio 客户端时重新检活和启动。

## 默认过滤规则

手动 JSON/ZIP 导出和 MCP 导出共用相同逻辑：

- 排除 `visible === false` 或节点自身 `opacity === 0` 的节点。
- 排除节点的整棵子树都不遍历、不导出，其专属图片也不读取或打包。
- 选中的根节点同样适用；直接选择隐藏父级的子节点时，也检查选区外祖先。
- 保留 `opacity > 0` 的节点；仅填充透明、没有填充或作为容器的节点不会因此被删除。
- `meta.nodeCount` 和 `meta.nodeName` 只统计实际导出的选区根节点。
- 所有选中节点都被过滤时，返回明确错误，不生成空文件。

过滤不修改设计稿。这是按节点属性过滤，不做像素可见性判断，不会推测遮挡、裁剪或屏幕外节点是否应被删除。

## v3：图片先落盘，JSON 后返回

调用 `figma_export`，可传入 `outputDir`（绝对路径）和 `shapeGroupsAsImages`（默认 `true`）。每次导出新建一个目录，不覆盖已有文件：

```text
export-<uuid>/
  images/                  原图和组合形状 PNG，按文件内容 hash 命名
  design.json              完整图层树、资源清单和坐标
  layout.json              精简的逐层坐标表
  collect-layout.js        页面可加载的 DOM 采集器
  collector-expression.js  浏览器工具可执行的采集表达式
```

节点树还保留填充、描边、效果、圆角、文本、字体、Auto Layout、约束和组件引用。图片字节从 Figma 插件传至本机服务，所有文件写完后才发布目录并返回结果。缺图、读取失败、未知图片格式或写入失败都会使导出失败，不能返回假路径。支持 PNG/JPEG/GIF/WebP 原图；单张图片字节上限 32MB，单次累计 128MB，导出超时 120 秒。

- `meta.schemaVersion = 3`；`meta.designPath`、`meta.layoutPath` 等为本机绝对路径。
- `assets[assetId]` 含 `path`、`relativePath`、`mimeType`、`byteLength`、`sha256`。
- 普通图片填充的 `imageHash` 对应 `assets[imageHash]`；形状图片节点通过 `assetId` 引用资源。
- 手动导出可选择 ZIP，包含 `index.json` 和 `images/`，ZIP 中使用相对路径。UI 打包 ZIP 仍引用 cdnjs 上的 JSZip；MCP 不依赖该 CDN。

### 组合形状整体导出

默认将 VECTOR、BOOLEAN_OPERATION，以及所有可见后代均为形状的 GROUP 导出成 2 倍 PNG。含 TEXT、FRAME 或 INSTANCE 的普通布局组不会被整体栅格化，文字和布局仍保留为节点。

这些节点标记为 `renderAs: "image"`，有 `assetId` 和 `collapsedNodeIds`，不再带 `children`。实现时视为一个原子图层，校验它的整体边界，不再为合并的内部路径创建 DOM。PNG 已包含该节点的外观和透明度，不应再次应用同一节点的填充、旋转或透明度；外层容器的样式仍须保留。可用 `shapeGroupsAsImages: false` 关闭，手动导出也有对应选项。

PNG 使用 Figma 的 `exportAsync`、`useAbsoluteBounds: true`，保留完整图层尺寸而非只裁到非透明像素。参见 [Figma ExportSettings](https://developers.figma.com/docs/plugins/api/ExportSettings/)。

## 图层坐标与验收流程

每个导出图层有三组矩形，都包含 `x/y/width/height/left/top/right/bottom`：

| 字段 | 坐标空间 | 用途 |
| --- | --- | --- |
| `absoluteBounds` | Figma 画布绝对坐标 | 原始依据；优先读取 `absoluteBoundingBox`，保留小数 |
| `relativeBounds` | 减去各自选区根节点的绝对原点 | 与浏览器结果比较 |
| `localBounds` | 减去父节点绝对包围盒原点 | 定位父子层级误差 |

`right = x + width`，`bottom = y + height` 由代码计算。`rootId` 和 `parentId` 标识图层归属。保留 `absoluteTransform`、`relativeTransform` 用于旋转/变换实现；`localBounds` 是轴对齐包围盒之差，**不是旋转父级的局部变换坐标**，不要直接用它替代所有变换矩阵。`renderBounds` 另存视觉边界，不能与 DOM 布局框混用。阴影等不属于 `absoluteBoundingBox`；参见 [Figma node properties](https://developers.figma.com/docs/plugins/api/node-properties/)。

Agent 应按以下顺序执行：

1. 在 Figma 选择完整画板并打开插件，调用 `figma_export`。先读取本地 JSON 和资源，不能用字符或猜测图标替代已导出的图片。
2. 实现时为**每个导出图层**标记 `data-d2c-id="Figma ID"`，选区根节点额外标记 `data-d2c-root`。保留导出层级；非设计结构的包装元素可不加 ID。原子图片只标记图片本身。
3. 用实际浏览器加载页面，等待字体、图片和稳定布局。执行 `collector-expression.js` 的内容，或加载 `collect-layout.js` 后调用 `await window.collectFigmaLayout()`，保存返回值为 `actual-layout.json`。
4. 调用 `figma_validate_layout({ designPath: "/.../design.json", actualPath: "/.../actual-layout.json", tolerance: 1 })`。也可直接传 `actual` 对象，两种方式二选一。
5. 按报告先修父级，再修子级，修改实际页面代码、重新渲染和采集，然后再次校验。默认六项边界/尺寸误差均不超过 **1 CSS px**；缺失/重复/多余 ID、层级错误、隐藏实现、图片失败、未稳定布局均不能通过。

采集器只读取真实 `getBoundingClientRect()`，减去浏览器中根节点的矩形原点，因此页面居中、页面滚动不会直接造成整体偏差。多选根节点分别归一化；验证的是每个选区内部布局，不校验不同选区在页面之间的排布。**不要使用 CSS zoom/整体缩放来适配验收视口**，因为缩放后的矩形会改变尺寸。

MCP 返回 `passed`、`maxError`、`failed`（父级优先，响应最多 30 项）、`failedCount`、`missing`、`duplicates`、`unexpected` 和 `reportPath`。完整报告包含实测数据和每个图层的预期值、实际值、六项差值。

**边界：**服务负责导出和数值比较，浏览器执行及 HTML/CSS 修正由 Agent 完成；单独调用导出并不会自动修复页面。MCP 指令会要求反复实测直到通过，但不能强制所有 Agent 执行。不能从设计值伪造实测值、修改目标或放宽阈值来通过。浏览器不可用或修正无法收敛时应明确报告未验收，不得宣称完成。几何通过也不代表像素、字体、遮挡、裁剪或交互一致，需要另行检查。

## 本地服务配置

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `FIGMA_AGENT_HOST` | `127.0.0.1` | 监听地址，仅接受回环地址 |
| `FIGMA_AGENT_PORT` | `3456` | HTTP/MCP/WebSocket 端口 |
| `FIGMA_MCP_BRIDGE_URL` | 由 host/port 生成 | stdio 使用的本机 HTTP origin；自动启动也使用该地址 |
| `FIGMA_MCP_START_TIMEOUT_MS` | `30000` | 等待共享服务启动的毫秒数 |
| `FIGMA_AGENT_URL` | `http://localhost:3456` | Shell CLI 查询地址 |
| `FIGMA_EXPORT_DIR` | `~/Downloads/figma-json-exporter` | 默认导出父目录，可由 `outputDir` 覆盖 |
| `FIGMA_VALIDATION_DIR` | `~/Downloads/figma-json-exporter/validation` | 校验报告目录 |

插件 UI 和 manifest 的开发网络许可固定为 `localhost:3456`。更换端口时需同步修改 `ui.html` 和 `manifest.json`。服务没有账号认证，不应通过反向代理或端口转发暴露到公网。

保留接口：`/health`、`/status`、`/export`、`/mcp`、`/ws`、`POST /control/shutdown`。

## 升级与迁移

旧 Go 实现和 `mcp-entry.js` 已移除。更新 MCP 配置为 `dist/mcp-server.js`，先停止旧服务，再重新连接客户端并重载 Figma 插件。v2 升级到 v3 时入口路径无需改动，但必须重新构建、停止旧共享服务、重连 MCP 和重开插件，才能加载新版导出协议和第三个工具。旧版插件的 JSON 将被拒绝，避免缺图/缺坐标的导出成功。若旧服务仍占用端口，入口会报版本不兼容，不会静默连接旧实现。

## 验证

```bash
npm test
```

测试涵盖类型检查、独立编译产物运行、stdio/HTTP 调用、服务启动和关闭、并发隔离、断线恢复、节点过滤、组合形状、小数坐标、资源先落盘、缺图失败，以及校验的通过/失败路径。插件和 DOM 的单元测试使用模拟 API，不替代真实 Figma/浏览器验收，不应将测试中的预置矩形当作实际页面的通过结果。

## 文件结构

```text
src/main.ts         入口、检活、后台启动和 stdio
src/server.ts       HTTP/MCP/WebSocket 本机服务
src/mcp.ts          MCP 工具定义
src/bridge.ts       请求排队、关联和 stdio HTTP 桥
src/assets.ts       图片/JSON 原子落盘和校验报告
src/geometry.ts     坐标归一化、DOM 采集和逐层比较
dist/mcp-server.js  编译产物，直接用 node 执行
code.js             Figma 沙箱导出与可见性过滤
ui.html             插件 UI、下载和 WebSocket 桥
test/               编译产物集成测试和过滤测试
```
