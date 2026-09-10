# dsh-workflow-view

DeepSeek Harness Web UI 插件：在「对话」「轨迹」之外增加第三个标签页「**工作流**」。

它以**用户对话轮次**为入口，把 Agent 一次会话里真实发生的模型请求、模型响应和工具调用，还原成一条条可逐级展开的执行链路。

> 本插件**只读取并展示已有记录**，不替换、不修改 Harness 内置的「轨迹」功能，也**不会**向模型请求中增加任何消息、提示词或工具。

---

## 兼容版本

当前 `0.1.0` 仅适配：

```
dsh@0.1.3-alpha.2
```

DeepSeek Harness 仍处于预发布阶段，不同 RC 版本的客户端接口可能发生变化。升级 DSH 后，需要同时安装与新版本适配的插件版本。

---

## 安装

```sh
dsh plugin --profile web add dsh-workflow-view
```

从本地目录安装（开发调试）：

```sh
dsh plugin --profile web add /path/to/dsh-workflow-view
```

`dsh plugin add` 会做两件事，无需手工编辑任何 profile 文件：

1. 把包装进 profile 目录；
2. 因为包声明了 `dsh.bundle.patch`，自动把它加入 `dsh.profile.bundles` 层栈。

> **安装后需要重启 `dsh web`。**
> profile 的 `patchReload: live` 只监听用户的 `cordis.patch.yml`（`watchUserPatches`），
> **不监听 `package.json` 里的 `dsh.profile.bundles`**。因此新增一个 bundle 层必须重启进程才会挂载；
> 重启后刷新浏览器页面，标签栏即出现第三个入口「工作流」。

卸载：

```sh
dsh plugin --profile web remove dsh-workflow-view
```

同样需要重启进程。

---

## 界面

```
┌───────────────────────────────────────────────────────────────────────────┐
│ 对话 │ 轨迹 │ 工作流                                                        │
├───────────────────────────────────────────────────────────────────────────┤
│  12 用户对话   47 模型调用   81 工具调用   8m07s 总耗时                      │
│  输入 2,986,785  未缓存输入 74,657  缓存读取 2,912,128  缓存写入 0  输出 21,613 │
├──────────────┬────────────────────────────────────────────────────────────┤
│ 用户对话轮次 │ 第 1 轮  已完成  15:14:29  8m07s  47 模型调用  81 工具调用    │
│ ┌──────────┐ │ 展开全部  收起全部                                          │
│ │1 提示词… │ │ ┌────────────────────────────────────────────────────────┐ │
│ │15:14:29  │ │ │ #1 模型调用 已完成 p/m 步骤 1 2.1s 2 个工具 输入… │ │
│ │47 81 8m… │ │ │ ▸ 请求  ▸ 响应  ▸ 工具调用                              │ │
│ └──────────┘ │ └────────────────────────────────────────────────────────┘ │
│ ┌──────────┐ │ （模型调用行虚拟化渲染，长链路不撑高整页）                 │
│ │2 …       │ │                                                            │
│ └──────────┘ │                                                            │
└──────────────┴────────────────────────────────────────────────────────────┘
```

### 顶部汇总

用户对话数、模型调用数、工具调用数、总耗时，以及整场会话的 Token 与缓存统计
（输入 / 未缓存输入 / 缓存读取 / 缓存写入 / 输出 / 推理）。

### 左侧：按轮次浏览

固定显示当前 Session 的用户对话轮次，每行包含：

- 轮次序号与提示词摘要（人类提示词优先，无则回退到该轮首条用户消息）
- 开始时间
- 模型调用数、工具调用数
- 已完成 / 进行中 / 已失败 / 已中止 / 已阻塞状态与耗时

左侧列表独立滚动；历史未加载完时底部提供「加载更早的历史」。

### 右侧：执行链路

每个模型调用（即一个 agent-loop step）依次展示三张卡片区块：

| 区块 | 内容 |
| --- | --- |
| **请求** | 真实记录的 `system`、提供方无关的 `messages[]`、`tools[]` 定义、调用参数；JSON 节点逐级展开/收起 |
| **响应** | `reasoning`、`content`、工具调用列表、Token 统计、未落盘消息的尝试、**响应原始记录** |
| **工具调用** | 每个工具的执行状态、调用参数、执行结果、耗时、错误摘要、`meta` |

一行内容超出可视区域时**横向滚动**，不折行、不挤压页面。

模型调用行使用虚拟化渲染（自研测量式窗口化，不依赖第三方虚拟列表）；右侧列表独立滚动。

---

## 主题与对比度（重要约定）

**不要直接用 `--dsw-alias-state-*-primary` / `-secondary` 配对做「文字 + 背景」。**
它们不是一对文字/背景色，而是**两个不透明的高饱和色**。在深色主题下：

```
--dsw-alias-state-error-primary:   rgb(242, 90, 90)
--dsw-alias-state-error-secondary: rgb(242, 90, 90)   ← 完全相同
```

所以「primary 文字 + secondary 背景」实测只有 **1.00:1** —— 文字完全看不见（浅色主题也只有 1.37:1）。
这正是「失败状态与错误信息看不清」的根因。

本插件在 `.wf-root` 派生了一组状态色：文字把色相朝主题自己的 `label-primary` 混合，
背景把同一色相混进面板底色，因此在明暗两种主题下都稳定通过 WCAG AA：

```css
--wf-bad-fg: color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, var(--dsw-alias-label-primary));
--wf-bad-bg: color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, var(--dsw-alias-bg-layer-1));
```

实测结果（`preview/check.mjs` 在真实浏览器里用 canvas 取像素逐项测量）：

| 元素 | 修复前（深色） | 修复后（深色） | 修复后（浅色） |
| --- | --- | --- | --- |
| `.wf-status-bad` 失败状态 | **1.00:1** | 6.61:1 | 7.70:1 |
| `.wf-detail-error` 错误信息 | **1.00:1** | 6.08:1 | 6.96:1 |
| `.wf-status-ok` / `.wf-role-assistant` | 5.25:1 | 7.50:1 | 5.17:1 |
| `.wf-status-warn` / `.wf-role-tool` | 8.04:1 | 7.74:1 | 4.97:1 |
| `.wf-json-string` | 7.55:1 | 10.53:1 | 5.57:1 |

最低一项 4.97:1，全部满足 AA（≥ 4.5:1）。新增或修改任何状态样式后，
`npm run check:view` 会在明暗两种主题下重新测量，低于 AA 直接失败。

---

## 数据来源

工作流页面完全由 DeepSeek Harness Session 中**真实记录的事件**生成：

| 展示内容 | 来源事件 | 读取字段 |
| --- | --- | --- |
| 轮次边界 | `turn/start` / `turn/end` | `turn`、`reason.kind`、`reason.error.message` |
| 模型调用边界 | `step/start` / `step/end` | `turn`、`step` |
| 用户提示词 | `user/message` | `content[]`、`source.kind === 'user'` |
| 系统提示词 / 工具定义 | `request/header` | `header.system`、`header.tools[]`、`header.config` |
| 请求 `messages[]` | `user/message`、`assistant/message`、`tool/result` 的有序 surface | `content[]`、`surfaceOp` |
| 响应 | `assistant/message` | `message.content[]`（reasoning/text/tool-call）、`usage`、`stream` |
| 未落盘尝试 | `assistant/attempt` | 原始 payload |
| 工具执行 | `tool/call` + `tool/result` | `callId`、`name`、`arguments`、`error`、`meta` |
| Token 与缓存 | `assistant/message.usage` | `inputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`outputTokens`、`reasoningTokens` |
| 实时输出 | `assistant/live-chunk` 瞬时行 | `chunk` delta |

几点说明：

- **请求的 `messages[]` 就是该次调用真实看到的会话上下文**：按事件顺序累积，并应用
  `surfaceOp: { op: 'replace', start, end }` 的压缩替换语义（替换节点落在被摘要范围的原始位置上）。
  因此第 N 次调用的消息列表天然包含之前所有轮次与步骤，这正是模型实际收到的内容。
- **Token 口径与 `@deepseek-ai/dsh-token-meter` 一致**：适配器上报的 `inputTokens` 是**未缓存**输入，
  缓存读取/写入另行上报，所以「输入」= `inputTokens + cacheReadTokens + cacheWriteTokens`，
  「未缓存输入」= `inputTokens`。
- **工具状态是工具自己的状态**：`tool/call` 已记录但 `tool/result` 未到达 → 运行中；
  结果带 `isError` 或 `error` → 失败；否则完成。
- 所有 JSON 都来自对应事件本身，不做任何推测或重新拼接；未加载到 `request/header` 的记录会
  明确显示「请求头未出现在已加载的记录中」，而不是猜测。

---

## 工程结构

```
dsh-workflow-view/
├── package.json          # dsh.bundle.patch + dsh.client(platform: web)
├── cordis.patch.yml      # 把本包挂载为 profile 的一层（宿主侧入口）
├── build.mjs             # 用 esbuild 产出 lib/index.js 与 lib/client.js
├── src/
│   ├── index.ts          # 宿主半：无副作用，仅让包被 Loader 挂载
│   ├── ambient.d.ts      # 平台模块的环境声明（必须保持为 script）
│   ├── dsh.ts            # 用到的 Session 事件结构契约（本地声明）
│   └── client/
│       ├── index.ts      # 注册 conversation.view 的「工作流」入口
│       ├── projection.ts # 事件 → 工作流模型（纯函数，无 React 依赖）
│       ├── WorkflowView.tsx
│       ├── JsonTree.tsx  # 惰性展开的 JSON 检查器
│       ├── VirtualList.tsx # 测量式窗口化列表
│       ├── locales.ts    # zh / en 词典
│       └── styles.css    # 全部使用 --dsw-alias-* 主题变量
└── preview/              # 仅用于开发验证，不随包发布
```

### 为什么需要宿主半？

`@deepseek-ai/dsh-client-modules` 通过**扫描宿主 Loader 的条目**来发现声明了 `dsh.client` 的包，
并据此生成浏览器启动图（`window.__DSH_BOOT__`）。没有挂载的包，其 `lib/client.js` 永远不会被送进浏览器。
所以 `src/index.ts` 是一个导出了空 `apply()` 的宿主半——它存在的唯一意义就是让包被挂载。

### 客户端产物格式

`lib/client.js` 是模块表（module table）所需的闭包工厂格式：

```js
window.__ModuleLoader__.load({ id: "dsh-workflow-view", factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  /* …bundled code… require("react") / require("react/jsx-runtime") … */
  return module.exports; } });
```

只请求模块表基线的 `react` 与 `react/jsx-runtime`，其余（CSS、词典、组件、投影）全部内联。
CSS 以文本内联，由插件自己的 `ctx.effect` 生命周期注入 `<style>`，卸载时移除。

---

## 从源码构建

构建只需要一个 esbuild（DSH 检出里已经带了一个）：

```sh
node build.mjs
```

若 esbuild 不在预期位置，用环境变量指定：

```sh
DSH_WORKFLOW_ESBUILD=/path/to/esbuild/lib/main.js node build.mjs
```

## 开发验证

```sh
npm run typecheck          # tsc --noEmit
npm run check:projection   # 30 条投影逻辑断言（含实时输出、运行中工具、失败轮次、压缩替换）
npm run check:view         # 起静态预览页 + Chromium：布局、虚拟化、横向滚动、区块结构、明暗双主题对比度
npm run check              # 以上三项串跑
npm run preview            # 手动打开预览页 http://127.0.0.1:5199/preview/index.html
```

`preview/check.mjs` 会写出明暗两张截图 —— `preview/shot.png` 与 `preview/shot-dark.png`，便于人工比对。

`preview/fixtures/events.json` 由两个真实 Session 记录拼成（第二个的 turn 已重编号）；
因为真实记录里**没有失败轮次**，`preview/main.tsx` 会再追加一个合成的失败轮次
——失败状态此前正是因为没有任何夹具覆盖它才漏掉了对比度问题。
两者都属于开发夹具，不会随包发布。

---

## 已知限制

- 只渲染**当前已加载的事件窗口**。更早历史需要点「加载更早的历史」，
  此时 `request/header` 可能尚未加载，请求区块会明确提示而不会编造。
- 只读投影：插件不写入 Session、不注册服务、不改变任何模型输入。
- 虚拟化行高依赖 `ResizeObserver`；运行环境不支持时自动退化为整表渲染。
- 宿主侧无行为：本插件不提供任何 Cordis 服务，也不修改 Harness 源码。
- `dsh plugin add` 之后必须重启 `dsh web`（见上文「安装」），这是 profile 层栈的既有行为，不是本插件的限制。
