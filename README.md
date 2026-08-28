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

## v3.4：图片先落盘，JSON 后返回

调用 `figma_export`，可传入 `outputDir`（绝对路径）和 `shapeGroupsAsImages`（默认 `true`）。每次导出新建一个目录，不覆盖已有文件：

```text
export-<uuid>/
  images/                  原图和组合形状 PNG，按文件内容 hash 命名
  design.json              完整图层树、资源清单和坐标
  layout.json              逐层坐标表及属性检查/复核清单
  implementation.json      逐层实现规则、自动检查和待视觉复核项
  collect-layout.js        页面可加载的 DOM 采集器
  collector-expression.js  浏览器工具可执行的采集表达式
```

节点树还保留填充、描边、效果、圆角、文本、字体、Auto Layout、约束和组件引用。图片字节从 Figma 插件传至本机服务，所有文件写完后才发布目录并返回结果。缺图、读取失败、未知图片格式或写入失败都会使导出失败，不能返回假路径。支持 PNG/JPEG/GIF/WebP 原图；单张图片字节上限 32MB，单次累计 128MB，导出超时 120 秒。

- `meta.schemaVersion = 3`；`meta.designPath`、`meta.layoutPath` 等为本机绝对路径。
- `meta.exporterVersion = "3.4.0"` 标识新版插件已加载；升级后应关闭并重新打开 Figma 插件。服务会拒绝旧插件的导出，避免静默漏掉新增属性与字体/图片处理；旧版 v3 JSON 仍可用于校验诊断。
- `assets[assetId]` 含 `path`、`relativePath`、`mimeType`、`byteLength`、`sha256`。
- 普通图片填充的 `imageHash` 对应 `assets[imageHash]`；形状图片节点通过 `assetId` 引用资源。
- 手动导出可选择 ZIP，包含 `index.json` 和 `images/`，ZIP 中使用相对路径。UI 打包 ZIP 仍引用 cdnjs 上的 JSZip；MCP 不依赖该 CDN。

### 组合形状整体导出

默认将 VECTOR、BOOLEAN_OPERATION，以及所有可见后代均为形状的 GROUP 导出成 2 倍 PNG。含 TEXT、FRAME 或 INSTANCE 的普通布局组不会被整体栅格化，文字和布局仍保留为节点。

这些节点标记为 `renderAs: "image"`，有 `assetId` 和 `collapsedNodeIds`，不再带 `children`。实现时视为一个原子图层，校验它的整体边界，不再为合并的内部路径创建 DOM。PNG 已包含该节点的外观和透明度，不应再次应用同一节点的填充、旋转或透明度；外层容器的样式仍须保留。可用 `shapeGroupsAsImages: false` 关闭，手动导出也有对应选项。

PNG 使用 Figma 的 `exportAsync`、`useAbsoluteBounds: true`。v3.3 将布局框与视觉边界的并集作为画布：超出布局框时导出到临时透明容器中，保留外描边/阴影，不再将图片画布强制压进布局框。参见 [Figma ExportSettings](https://developers.figma.com/docs/plugins/api/ExportSettings/)。

### 行高、特殊字体和图片填充

文字行高保留 Figma 原始 `unit/value`，并提供可直接用于 CSS 的 `lineHeight.css` 及可计算时的 `lineHeight.pixels`：

| 输入（字号 32） | `css` | `pixels` |
| --- | --- | --- |
| `PERCENT / 100` | `100%` | `32` |
| `PERCENT / 125.5` | `125.5%` | `40.16` |
| `PIXELS / 100` | `100px` | `100` |
| `AUTO`，Figma CSS 明确返回 px | Figma 返回的 px | 对应数值 |
| `AUTO`，未取得明确 px | `null`，必须转图片 | `null` |

不要直接给 `lineHeight.value` 拼接 `px`。`AUTO` 不伪造固定像素行高；混合样式无法安全用一套 CSS 表达时，保留原文并栅格化。

字体使用明确的常见系统字体名单（例如 Arial、Helvetica、PingFang SC/TC/HK、Microsoft YaHei、Segoe UI），不按某个公司名称做特殊适配。名称先去除两端空格、忽略大小写。名单之外的字体、Figma 中缺失的字体及混合文字样式会自动导出为 PNG，标记 `renderAs: "image"`、`rasterReason`，资源类型为 `text`。`characters` 和原字体元数据仍保留，建议用原文作为图片 `alt`。

这是一项保守策略，不保证名单中的字体在所有操作系统都已安装；Figma 沙箱无法读取目标浏览器的字体清单。栅格化不修改设计、不安装或替换字体，也不要求先加载缺失字体，使用 Figma 已保存的文字外观。[Figma 文字说明](https://developers.figma.com/docs/plugins/working-with-text/)

**图片填充不是独立的 Figma IMAGE 节点**。v3.1 默认将具有可见图片填充/描边的叶节点导出为 `image-render` PNG，裁剪、滤镜、填充透明度及旋转由 Figma 渲染；同时保留原图 `image-fill`。它们和特殊字体独立于 `shapeGroupsAsImages` 开关，不能只处理 GROUP/VECTOR 后忽略这些图片。

有子节点的图片容器仍保留布局层级，其 `fills/strokes` 中的 `imageHash` 必须映射到 `assets[imageHash]` 并绘制，不能生成空容器。导出保留 `imageTransform`、`scaleMode`、`scalingFactor`、`rotation`、`filters` 和渐变矩阵；不能将 CROP 当作任意居中 cover。[Figma Paint 定义](https://developers.figma.com/docs/plugins/api/Paint/)

所有 `renderAs: "image"` 节点都应优先于 `type === "TEXT"` 等分支处理，并使用对应本地文件。不能在图片上再绘制原文、填充、效果或重复应用节点透明度。

## v3.4：渐变方向与色标校验

单层、普通混合模式的线性渐变保留为可编辑节点。MCP 在 `design.json` 和 `layout.json` 中提供 `layer.gradient`：包含 `angleDeg`、换算后的 `stops`、完整 `css` 和背景绘制区域设置。实现时使用 `gradient.css` 作为 `background-image`，并应用其 `backgroundOrigin/Clip/Size/Position/Repeat`，不要只读取矩阵里的角度或交换颜色顺序。

- 根据 Figma 渐变矩阵、节点局部宽高、缩放和偏移计算 CSS 角度及色标百分比。矩形图层的角度不能直接套用正方形结果；平移/缩放也不能丢弃。色标允许落在 0–100% 之外，paint.opacity 只合入色标 alpha 一次。
- 新采集器读取实际计算的 `backgroundImage`、`backgroundOrigin`、`backgroundClip`、`backgroundSize`、`backgroundPosition`。校验角度（含 360° 环绕，容差 0.1°）、色标数量/位置/颜色/透明度和绘制区域；方向正确但颜色反了也会失败。色标位置容差为 0.001 个百分点，RGB 为 1/255、alpha 为 0.001，不随几何容差放宽。
- 当前自动校验约定为带图层 ID 元素上的单个、非重复 `linear-gradient`，使用 border-box 原点/裁剪和完整背景尺寸。支持浏览器计算后的 RGB/RGBA、角度单位/方向关键字、百分比/px/省略位置的色标。不支持的 CSS 表达方式会明确失败，不推断任意多背景、伪元素或其他绘制方式是否等价。
- 径向、角向、菱形渐变、渐变描边、多层渐变混合及 P3 渐变整体导出为图片；含子节点的复杂渐变容器也会合并，牺牲内部可编辑性以保留组合外观。这项策略不受 `shapeGroupsAsImages` 开关影响。旧 JSON 中无法校验的复杂渐变报告 `gradient-unsupported`，不能跳过后宣称通过。

方向采用节点局部坐标，旋转/翻转、背景合成及插值后的像素外观仍需视觉复核。图片渐变检查资源和位置，不单独反推像素渐变角度；`passed` 仍只代表自动检查通过。实现依据：[Figma 官方渐变矩阵示例](https://github.com/figma/mcp-server-guide/blob/main/skills/figma-use/references/plugin-api-patterns.md)、[CSS 线性渐变规范](https://drafts.csswg.org/css-images-3/#linear-gradients)。

## v3.3：AUTO、文字颜色和图片外扩边界

- **AUTO 行高**：原始 `unit: AUTO` 保留，不把 `normal`、字号、固定 1.2 倍或文本框高度当作确定行高。尝试读取节点 `getCSSAsync()` 的明确 px 值，成功时输出 `source: "figma-css"` 与 `css/pixels`；返回 normal、百分比、变量或读取失败时，按 `unresolved-auto-line-height` 转为图片。明确值会参与行高校验，未解析的 AUTO 不能作为普通文字通过验收。
- **文字颜色**：提供 `textColor.css/rgba`；使用 CSS `color`，不是 background-color。单个可见纯色填充保留小数 RGB 和完整 alpha，paint.opacity 只合并一次，节点 opacity 单独应用。无可见填充输出透明色，不默认黑色。渐变、多层填充、混合颜色和文字描边转图片；采集器同时检查计算 `color` 与 `-webkit-text-fill-color`，防止颜色被后者覆盖。RGB 容差为 1/255，alpha 为 0.001，与几何容差无关。
- **颜色空间**：记录文档 color profile；PNG 显式导出为 sRGB。Display P3 文档的文字采取图片转换路径，不将未经转换的通道直接当作 sRGB CSS；这不等于保证保留超出 sRGB 的所有颜色。其他宽色域填充/合成仍需视觉复核。
- **图片边界**：`absoluteBounds` 仍是布局框；`imageBounds` 是布局框和 `absoluteRenderBounds` 的并集；`imagePlacement` 是图片相对本图层的偏移与尺寸；`relativeImageBounds` 用于浏览器图片位置比较。不是简单给宽高加两倍 strokeWeight，而是使用 Figma 提供的实际视觉边界，覆盖 OUTSIDE/CENTER 描边、阴影 spread/offset、模糊、斜体字形外伸及超框子形状。[Figma 布局框与视觉边界定义](https://developers.figma.com/docs/plugins/api/node-properties/#absoluterenderbounds)

比如布局框 `100×50`，视觉内容四边各超出 4px：外层仍是 `100×50`，图片为 `108×58`，left/top 为 `-4px`，2 倍 PNG 为 `216×116`。实现结构：

```html
<div data-d2c-id="layer-id" style="position:absolute;width:100px;height:50px;overflow:visible">
  <img data-d2c-asset="node-layer-id" src="images/original-hash.png" alt=""
       style="position:absolute;left:-4px;top:-4px;width:108px;height:58px;object-fit:fill">
</div>
```

图层本身的透明度/描边/阴影已经烘焙到图片，不重复施加。外层祖先的裁剪和透明度仍需保留。校验不再只看容器外框，同时检查资源归属、图片矩形、像素尺寸和图片透明度；扩大图片后再压缩进原框、遗漏负偏移、在本层容器裁掉阴影都会失败。手动 JSON/ZIP 和 MCP 都包含图片偏移元数据。

需要扩展画布时，插件临时创建透明 FRAME，放入节点副本并保留原绝对变换与继承的变量模式，只导出其内容；成功或失败均在 finally 中清理副本/容器，不持久修改原节点。无法获取可靠视觉边界、变量模式无法保留、复制后尺寸变化或 PNG 像素尺寸不匹配时直接报错。PNG 尺寸允许最多 1 个物理像素的栅格化舍入，不把它当作任意缩放许可。服务落盘前再次检查尺寸。

这轮只优化代码与模拟 API/协议回归测试，未重新生成设计页面，也未进行真实 Figma 图像验收。临时复制导出的真实 Figma 行为、背板相关混合/背景模糊、嵌套蒙版和像素外观仍须实际复核；尺寸通过不代表像素一致。

## v3.2：属性不能静默忽略

此前 `clipsContent` 已存在于 JSON，但没有参与浏览器验收，导致漏裁剪仍能得到 `passed: true`。现在在导出、MCP 指令和校验报告中都明确约束：

| 属性 | 新增处理 |
| --- | --- |
| `clipsContent` | 比较两个计算后的 overflow 轴；true 必须裁剪，false 必须可见。检查额外 clip-path、mask、paint containment，避免无意增加裁剪 |
| 裁剪容器定位 | 含子节点的裁剪容器必须使用非 static 定位（通常 `position: relative`），将绝对定位子层的包含块留在容器内；这是本工具的保守实现约定 |
| `opacity` | 比较节点计算透明度，误差不超过 0.005；`opacityBaked` 图片的元素透明度必须为 1，父级透明度仍单独检查 |
| 四角圆角 | 分别比较四角，解析 CSS px/% 和圆角重叠时的缩放，不能统一替换为一个圆角；平滑圆角列入视觉复核 |
| 字号、字重、斜体、字距、水平对齐、装饰线 | 比较真实计算样式。字号、字距和圆角误差不超过 `min(tolerance, 0.1)` px；字重和枚举值不能靠几何容差放过 |
| 中间包装层 | 选区内两个带 ID 的节点之间，无 ID 包装层不得额外裁剪、修改透明度或添加滤镜等外观效果；页面承载选区的外层布局不在此检查范围 |

`clipsContent` 仅对支持它的节点类型导出；false 不等于“删除容器外子节点”。裁剪控制超出 frame 边界的内容是否显示，不改变子节点的原始坐标和层级。[Figma 节点属性](https://developers.figma.com/docs/plugins/api/node-properties/#clipscontent)、[CSS overflow](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/overflow)。true 可使用 hidden/clip/auto/scroll，但滚动行为仍需独立验证。裁剪和文字样式须放在带 `data-d2c-id` 的实际元素上；本工具不尝试推断任意包装层、伪元素或复杂 CSS 的等价关系。

字距也保留单位并增加 `letterSpacing.css/pixels`：字号 20、`PERCENT: 2` 输出 `0.02em` / `0.4`，不要拼 `px`，也不要直接写 CSS `2%`。补充检测混合字重、字距、装饰、大小写、段落间距和填充；这些混合文字会按现有保真策略整体栅格化。

本轮还补充导出 `maskType`、`cornerSmoothing`、每边描边宽度、端点/连接/虚线、paint/effect blendMode、阴影穿透设置、布局换行/行间距、子项绝对定位/伸展/增长、HUG/FILL、min/max 尺寸、反向层叠、描边是否计入布局，以及文字自适应、截断、行数、大小写和段落/列表属性。保留 0、false、null 的原意，不据此猜测默认值。它们不是全部都可由 CSS 数值直接验收，也不声称覆盖 Figma 的全部 API。

每层 `implementation` 和单独的 `implementation.json` 分为 `checks`（自动检查）、`rules`（实现约定）、`review`（尚未自动验证）：

- 填充/渐变/图片裁剪、描边/虚线、阴影/模糊、混合模式、蒙版、平滑圆角、旋转/翻转、层叠遮挡、响应式布局、文字内容/换行/截断/垂直对齐均按节点列出复核项，不允许默默丢弃。
- 蒙版不是普通裁剪。单个蒙版节点的 PNG 不能代替它对兄弟节点的作用；必须实现整组遮罩关系并复核。
- 栅格化节点不再重复要求其内部圆角、裁剪和文字样式，但仍校验图片引用、透明度与外层关系。资源外观已烘焙不等于父级效果也被烘焙。
- SOLID paint 的 `color` 已合并 paint.opacity，不能再次将同一填充透明度相乘；节点 opacity 与填充 opacity 是不同层级。复杂 paint/effect 的外观仍须复核。

验证报告新增 `propertyMismatches`（字段、预期、实际）、`collectorCompatible`、`reviewRequired` 和 `visualAcceptance: "not-verified"`。`passed: true` **只表示自动检查通过**，不能用它宣称复核项、像素或交互已通过；MCP 响应最多列出 30 层复核项，完整清单保存在 `reportPath`。缺失新版采集信息会失败，不允许仅提交矩形蒙混通过。旧 v3 JSON 可以用于诊断，但报告会提示新增属性可能不全。

## 图层坐标与验收流程

每个导出图层有三组矩形，都包含 `x/y/width/height/left/top/right/bottom`：

| 字段 | 坐标空间 | 用途 |
| --- | --- | --- |
| `absoluteBounds` | Figma 画布绝对坐标 | 原始依据；优先读取 `absoluteBoundingBox`，保留小数 |
| `relativeBounds` | 减去各自选区根节点的绝对原点 | 与浏览器结果比较 |
| `localBounds` | 减去父节点绝对包围盒原点 | 定位父子层级误差 |

`right = x + width`，`bottom = y + height` 由代码计算。`rootId` 和 `parentId` 标识图层归属。保留 `absoluteTransform`、`relativeTransform` 用于旋转/变换实现；`localBounds` 是轴对齐包围盒之差，**不是旋转父级的局部变换坐标**，不要直接用它替代所有变换矩阵。`renderBounds` 另存视觉边界，不能与 DOM 布局框混用。阴影等不属于 `absoluteBoundingBox`；参见 [Figma node properties](https://developers.figma.com/docs/plugins/api/node-properties/)。

Agent 应按以下顺序执行：

1. 在 Figma 选择完整画板并打开插件，调用 `figma_export`。先读取 `design.json`、`implementation.json` 和资源；逐层落实 `implementation.checks/rules`，处理 `review` 中的未验证属性。不能只读坐标表，也不能用字符或猜测图标替代已导出的图片。
2. 实现时为**每个导出图层**标记 `data-d2c-id="Figma ID"`，选区根节点额外标记 `data-d2c-root`。保留导出层级；非设计结构的包装元素可不加 ID。原子图片的布局容器带图层 ID，内部 IMG 标记 `data-d2c-asset="assetId"` 并使用 `imagePlacement`，不再给 IMG 添加另一份图层 ID。
3. 用实际浏览器加载页面，等待字体、图片和稳定布局。执行 `collector-expression.js` 的内容，或加载 `collect-layout.js` 后调用 `await window.collectFigmaLayout()`，保存返回值为 `actual-layout.json`。
4. 调用 `figma_validate_layout({ designPath: "/.../design.json", actualPath: "/.../actual-layout.json", tolerance: 1 })`。也可直接传 `actual` 对象，两种方式二选一。
5. 按报告先修父级，再修子级，修改实际页面代码、重新渲染和采集，然后再次校验。默认六项边界/尺寸误差均不超过 **1 CSS px**；缺失/重复/多余 ID、层级错误、隐藏实现、图片失败、未稳定布局均不能通过。

采集器只读，不修改页面；读取真实 `getBoundingClientRect()` 和 `getComputedStyle()`，减去浏览器中根节点的矩形原点，因此页面居中、页面滚动不会直接造成整体偏差。多选根节点分别归一化；验证的是每个选区内部布局，不校验不同选区在页面之间的排布。**不要使用 CSS zoom/整体缩放来适配验收视口**，因为缩放后的矩形会改变尺寸。

MCP 返回 `passed`、`maxError`、`failed`（父级优先，响应最多 30 项）、`failedCount`、`missing`、`duplicates`、`unexpected` 和 `reportPath`。完整报告包含实测数据和每个图层的预期值、实际值、六项差值。

v3.1 还检查显式行高和图片引用：

- 对非栅格化文字读取浏览器计算行高，与 PIXELS 或 `fontSize × PERCENT / 100` 比较，报告 `line-height-mismatch`。
- 对图片节点检查实际 `IMG` 及资源文件名；对普通图片填充检查实际 CSS 背景引用，报告 `image-missing-or-wrong-source`。复制资源时保留导出的文件名，便于跨目录核对。当前引用校验针对文件 URL，不支持将图片改名或改为 data URI 后仍声称引用通过。
- 必须运行新版采集器，它会返回 `collectorVersion: 4`、`tagName`、`imageSources`、`assetImages`、`textStyle` 和 `renderStyle`（含渐变背景样式）。旧采集器或缺失属性采样的结果不能通过。

引用检查不是浏览器端内容哈希或像素校验：同名文件被替换、背景图片网络失败、遮挡等还需另行验证，不能将它当作完整视觉验收。

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
src/rendering.ts    逐层属性约束、样式比较与视觉复核清单
dist/mcp-server.js  编译产物，直接用 node 执行
code.js             Figma 沙箱导出与可见性过滤
ui.html             插件 UI、下载和 WebSocket 桥
test/               编译产物集成测试和过滤测试
```
