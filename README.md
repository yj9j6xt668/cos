# CosAI — Photoshop 漫展修图助手

[![Version](https://img.shields.io/badge/version-1.8.2-blue.svg)]()
[![Platform](https://img.shields.io/badge/platform-Photoshop%202026+-green.svg)]()
[![Framework](https://img.shields.io/badge/framework-UXP%20v5-orange.svg)]()

> 一款专为漫展 Cosplay 人像精修设计的 Adobe Photoshop UXP 插件。提供高低频分离、双曲线修图、辉光效果三大核心修图工具，并内置「闭源大模型」AI 绘图能力（基于 GRS/Nano Banana 视觉模型）——支持并发多任务生成、一次多张、选区对齐返图与分级日志落盘，把「选图 → 生成 → 贴回画布 → 修图」整条链路收进 Photoshop。

---

## 目录

- [功能简介](#功能简介)
- [架构概览](#架构概览)
- [安装指南](#安装指南)
- [使用说明](#使用说明)
  - [工具箱](#工具箱)
  - [闭源大模型（AI 绘图）](#闭源大模型ai-绘图)
  - [任务队列与并发](#任务队列与并发)
  - [运行日志](#运行日志)
- [工具详解](#工具详解)
  - [高低频分离](#高低频分离)
  - [双曲线修图](#双曲线修图)
  - [辉光效果](#辉光效果)
  - [返图区域](#返图区域)
- [通信架构](#通信架构)
- [技术栈](#技术栈)
- [项目结构](#项目结构)
- [迭代日志](#迭代日志)
- [许可证](#许可证)

---

## 功能简介

CosAI 面向 Photoshop 2026+ UXP 架构，为漫展 Cosplay 人像后期提供一站式工具链：

| 功能 | 说明 |
|------|------|
| **高低频分离** | 将图像分离为低频（光影/颜色层）和高频（纹理/细节层），互不干扰地精细修图 |
| **双曲线修图** | 用曲线调整图层建立提亮/压暗两支画笔，精准控制光影过渡 |
| **辉光效果** | 一键添加柔光/发光效果，模拟 Orton 效应，提升氛围感 |
| **闭源大模型** | 接入 GRS/Nano Banana 视觉模型，按选区或整图生成 AI 图像 |
| **自动获取参考图** | 位于「闭源大模型」页时自动取图：有选区→按选区真实像素导出；无选区→整张画布 |
| **一次生成多张** | 可配置单次出图张数（1/2/4），服务端返回不足时**自动补齐重发** |
| **并发任务队列** | 多任务并行生成，可配并发上限，每个任务独立状态与进度、互不阻塞 |
| **选区对齐返图** | 生成结果保存在本地并贴回 PS 新图层，有选区时严格贴合选区位置与尺寸 |
| **分级日志** | debug/info/warn/error 分级 + 模块 + 时间戳，环形缓冲并落盘到本地，面板可过滤/导出/清空 |
| **返图区域** | 结果图片预览、缩放、贴回画布、对比、下载，闭环工作流 |

---

## 架构概览

```
┌─────────────────────────────────────────────────┐
│                   Photoshop 2026                 │
│  ┌─────────────────────────────────────────────┐ │
│  │           UXP Panel (index.html)             │ │
│  │  ┌──────────┐    ┌──────────────────────┐   │ │
│  │  │  host.js  │◄──►│  WebView (app.html)  │   │ │
│  │  │  (PS API) │    │  (手写原生 UI)       │   │ │
│  │  └──────────┘    └──────────────────────┘   │ │
│  │      │  ▲ 分级日志落盘                          │ │
│  │      └──┴─► cosai_logs/cosai_YYYYMMDD.log     │ │
│  └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

- **host.js**: 运行在 UXP 宿主环境，直接调用 Photoshop 原生 API（batchPlay、DOM 操作），并承担图片导出、图层贴回、文件读写与日志落盘
- **WebView**: 运行在 Chromium 渲染环境，承载手写原生前端 UI 与 AI 任务队列调度
- **通信**: 通过 `uxpHost.postMessage` + `CustomEvent` 双向桥接；所有 modal 级 PS 操作经共享互斥锁串行化，避免并发崩溃

---

## 安装指南

### 系统要求

- Adobe Photoshop 2026 (v25.0.0+) — **仅支持 UXP v5 架构**
- macOS / Windows

### 安装步骤

1. **下载或构建** 插件代码
2. 将插件文件夹放置到 Photoshop 插件目录：
   - **macOS**: `~/Library/Application Support/Adobe/UXP/Plugins/External/`（也支持直接放入 `Plug-ins/CosAI`）
   - **Windows**: `%APPDATA%\Adobe\UXP\Plugins\External\`
3. 打开 Photoshop → **菜单栏 → 插件 → CosAI** 即可启用

### 手动安装（开发者模式）

```bash
# 克隆仓库
git clone https://github.com/yj9j6xt668/cos.git

# 复制到插件目录
cp -r cos ~/Library/Application\ Support/Adobe/UXP/Plugins/External/

# 重启 Photoshop
```

**AI 绘图前置条件**：需先在「闭源大模型」配置页填入 GRS 的 API Key（会落盘到插件数据目录的 `cosai_key.json`，避免每次重新读取），并确认 API 地址与默认模型。

---

## 使用说明

### 打开插件

Photoshop 菜单栏 → **窗口 → 扩展(旧版) → CosAI**（或 菜单栏 → 插件 → CosAI）。

### 界面布局

- **顶部工具箱**: 浮动工具栏，含修图三大功能按钮 + 模型配置入口
- **侧栏导航**: emoji 图标 + tooltip，切换各功能页
- **主区域**: 各功能页面板（修图工具 / 闭源大模型 / 运行日志）
- **底部调试条**: 显示通信状态与错误信息

### 工具箱

| 按钮 | 功能 |
|------|------|
| 高低频 | 新建「高低频」图层组，分离光影与纹理 |
| 双曲线 | 新建提亮/压暗两个曲线调整层，用于精细磨皮 |
| 辉光 | 一键 Orton 柔光效果 |
| 模型配置 | 打开 GRS 闭源大模型配置页（API Key / 地址 / 默认模型） |

### 闭源大模型（AI 绘图）

1. 先进入「**模型配置**」页，填入 API Key、API 地址（默认 `https://grsai.dakka.com.cn`）、默认模型，点 **保存配置** 并可选 **测试连接**。
2. 切到「**闭源大模型**」页，面板会自动获取当前参考图：
   - **有选区** → 按选区真实像素尺寸导出选区内容作为参考图；
   - **无选区** → 导出整张画布作为参考图。
3. 输入提示词，设置**参考比例 / 分辨率 / 生成张数 / 并发数**，点击 **立即生成**。
4. 生成结果会：自动保存到本地 → 贴回 Photoshop 新图层（有选区时**严格贴合选区位置与尺寸**）→ 加入结果区预览。

> 顶部积分卡片实时显示会话与当日用量（GRS 官方 `getAPIKeyCredits` 接口），调用后自动刷新。

### 任务队列与并发

- **一次 N 张**：在「生成张数」选择 1/2/4。提交时携带期望张数；若服务端单次返回不足目标，会**自动补齐重发**（单任务最多补 3 批）。
- **并发数**：可设 1/2/3（默认 2），决定同时在途的生成任务上限。
- 可**连续多次点击「立即生成」**累积多个独立任务，调度器按并发上限依次运行，互不阻塞。
- 每个任务以**任务卡片**展示：编号、提示词、阶段（排队/提交/生成/补齐/完成/失败）、已得张数、进度条；顶部有运行/排队/完成的汇总进度。

### 运行日志

- 内置分级日志（debug / info / warn / error）+ 模块前缀（QUEUE/GEN/POLL/SAVE/PLACE/API/LOG…）+ 毫秒时间戳。
- 环形缓冲（上限 500 条）实时显示在「运行日志」面板，支持**按级别过滤**、**导出 .log**、**清空面板**。
- 日志经**去抖批量落盘**到插件数据目录 `cosai_logs/cosai_YYYYMMDD.log`，按天轮转，便于事后排查。

### 注意事项

> ⚠️ **修改 `host.js` 后必须完全退出 Photoshop（Cmd+Q）再重开**，新代码才生效。仅关闭面板或重新加载不会刷新 UXP 脚本缓存。修改 `app.html` 亦然（重启一次即可）。

> UXP 运行日志（含插件 `console.log`）写入 `~/Library/Logs/Adobe/Adobe Photoshop 2026/UXPLogs_*.log`；面板内 `cosai_logs/` 为本插件自身的分级日志，两者互不相关。

---

## 工具详解

### 高低频分离

**原理**: 将图像分解为两层：

- **低频层**（Low Frequency）：高斯模糊，保留光影和颜色过渡信息
- **高频层**（High Frequency）：原图减去低频层，保留纹理和细节信息

**操作**:

1. 选择要处理的图层
2. 点击工具箱 **高低频** 按钮
3. 在弹窗或配置中指定模糊半径（默认 8px）
4. 插件自动创建「高低频」图层组：
   - 低频层 → 在此层上修光影、磨皮、调整色块
   - 高频层（线性光混合模式）→ 在此层上用图章/修复画笔修瑕疵

**特点**:

- 支持 8 位和 16 位文档
- 32 位文档暂不支持
- 自动编组，图层结构清晰

### 双曲线修图

**原理**: 创建两个曲线调整图层，蒙版填充黑色：

- **提亮层 (Dodge)**: 曲线向上偏移，提亮中间调
- **压暗层 (Burn)**: 曲线向下偏移，压暗中间调

**操作**:

1. 点击工具箱 **双曲线** 按钮
2. 插件自动创建「双曲线」图层组，内含两个蒙版全黑的曲线调整层
3. 用白色柔边画笔，在对应蒙版上涂抹：
   - 提亮层蒙版上涂白色 → 提亮该区域
   - 压暗层蒙版上涂白色 → 压暗该区域

**特点**:

- 非破坏性编辑，随时可调整
- 精细控制光影过渡，适合人像精修
- 默认强度 25%，可通过参数调节

### 辉光效果

**原理**: 复制图层 + 高斯模糊 + 混合模式，模拟 Orton 效应

**参数**:

- **半径** (radius): 高斯模糊半径，默认 20px
- **不透明度** (opacity): 效果强度，默认 50%
- **混合模式** (blendMode): screen / softLight / overlay / linearLight / colorDodge / lighten / normal

**操作**:

1. 选择要处理的图层
2. 点击工具箱 **辉光** 按钮
3. 插件自动创建「辉光」图层，完成模糊和混合模式设置

### 返图区域

**功能**:

- 结果图片预览（主预览区 + 缩略图栏）
- 缩放控制（25% ~ 300%）
- **贴回画布**: 将预览图片贴回 Photoshop 当前文档
- **新建图层**: 贴到新图层
- **对比模式**: Before/After 滑块对比
- **下载**: 导出图片到本地

**设计**: 樱花粉主题，玻璃拟态卡片，可折叠侧边面板

---

## 通信架构

插件采用**三层消息桥**架构：

```
┌──────────────────────────────────────────────────────────────────┐
│  WebView (app.html)      Panel (UXP Host)      Photoshop API    │
│                                                                  │
│  window.__uxpHost        panel-boot.js         host.js          │
│  .postMessage ───────►   CustomEvent ────────►  batchPlay       │
│                          "cosai-webview-        │                │
│  ◄─────── CustomEvent     message"              │                │
│          "cosai-host-    ◄───────────────────────┘                │
│           message"                                               │
└──────────────────────────────────────────────────────────────────┘
```

**关键通信协议**:

- WebView → Panel: `uxpHost.postMessage(JSON.stringify({id, method, args}))`
- Panel → WebView: `document.dispatchEvent(CustomEvent('cosai-host-message'))`
- 请求 ID 用于异步响应匹配
- 所有 Photoshop 操作均包裹在 `core.executeAsModal()` 内，并用共享互斥锁避免并发 modal 冲突

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 插件框架 | Adobe UXP v5 (Manifest v5) |
| 宿主脚本 | JavaScript (Photoshop UXP API) |
| 前端 UI | 手写原生 HTML/CSS/JS（`app.html` + `app.css`，不依赖框架） |
| 渲染引擎 | Chromium WebView (UXP embedded) |
| 通信协议 | postMessage + CustomEvent 桥接 |
| 底层 API | Photoshop batchPlay（action 层） |
| AI 接口 | 双平台：GRS 私有异步协议 + OpenAI 兼容网关（`/models` 探活，`generations`/`edits` 出图） |
| 版本控制 | Git |

---

## 项目结构

```
CosAI/
├── index.html          # 面板入口（host shell，加载 host.js + panel-boot.js）
├── host.js             # UXP 宿主脚本（核心 PS API、导出/贴回、HTTP 代理、日志落盘、Key 读取）
├── panel-boot.js       # WebView 创建与消息桥
├── app.html            # 前端唯一渲染源（手写原生 UI，含任务队列与分级日志）
├── app.css             # 样式文件
├── manifest.json       # 插件清单
├── icons/              # 插件图标（PNG + SVG 源文件）
├── 风月-高低频/         # 高低频分离独立参考模块（不直接加载）
├── 风月-双曲线/         # 双曲线修图独立参考模块（不直接加载）
├── 风月-辉光/           # 辉光效果独立参考模块（不直接加载）
└── 风月-返图区域/       # 返图区域模块（index.js 由 app.html 直接加载）
```

> **注意**: `风月-高低频` / `风月-双曲线` / `风月-辉光` 是独立的**参考实现**，**不直接加载**；实际运行时使用的是 `host.js` 中内联的 `ToolboxAPI`。仅 `风月-返图区域/index.js` 被 `app.html` 直接引入。修改运行行为需改 `host.js`，改 UI/队列/日志需改 `app.html`。

> **日志目录**: `cosai_logs/` 由 `host.js` 通过 `fs.getDataFolder()` 写入 **插件数据目录**（`PluginsStorage/com.cosai.psplugin/`），不在插件安装目录内，已加入 `.gitignore`。

### 遗留文件（当前版本已无引用）

`app.html` 手写 UI 自 v1.8.0 起成为唯一渲染源，React 版整体退场。以下文件保留在仓库中但**不被任何代码加载**，后续清理时可直接删除：

| 文件 | 原用途 |
|------|--------|
| `app.js` | React 应用代码（旧 UI 实现） |
| `assets/` | React 构建产物（`index-r3jHK-P2.js` / `index-CT5BbW2z.css`） |
| `boot.js` | React 引导脚本（动态加载 `app.js`，含 polyfill 与错误兜底） |
| `ext-test.js` | 早期外部脚本执行探针 |
| `wv-probe.js` | 早期 WebView 环境探针 |

---

## 迭代日志

### v1.8.2 (2026-09-23)

> 仓库卫生与版本信息校正（无功能改动）

- 版本号同步至 `1.8.2`：`manifest.json` 与 `host.js` 的 `COSAI_HOST_VERSION` 保持一致
- 清理手工备份文件 `app.html.bak.multipf` / `host.js.bak.multipf`（合计约 336KB）
- 移除历史遗留的**已跟踪**备份 `app.js.bak.old346k`（354KB）——`.gitignore` 对已入库文件无效，需 `git rm` 才真正退出仓库
- `.gitignore` 新增 `*.bak` / `*.bak.*` 规则（覆盖历次手工备份），并补充 `cosai_logs/`
- `.gitignore` 补充 `cosai_key.json` 作防御性兜底：密钥实际落盘在 UXP 插件数据目录，本不在仓库内，此规则仅防整目录拷贝时误入库
- README 校正：项目结构文件树、技术栈与架构图中已过时的 **React** 表述；标注 `app.js` / `assets/` / `boot.js` / `ext-test.js` / `wv-probe.js` 为无引用遗留文件

### v1.8.1 (2026-09-18)

> 多平台视觉模型适配（GRS + OpenAI 兼容网关）与贴入画布修复

- **平台对接**：模型配置支持 GRS 官方与 PsyDo/OpenAI 兼容平台切换，配置面板双卡片；GRS 保留私有异步协议，OpenAI 平台走 `/models` 探活 + `generations`/`edits` 出图
- OpenAI 地址自动规整 `/v1`，杜绝双 `v1` 与路径拼接错误；模型按 Key 分组实际 `/models` 自适应选择，`2.5` 不存在时自动降级 `gpt-image-2`
- 接入官方 5 端点池（`api` / `cn2` / `cf` / `ppx-ai` / `us`），5xx / 超时 / TLS 自动退避并转移端点
- `401/403/404/429/5xx` 按官方文档分类处理，错误携带真实请求 URL 与服务端返回
- **连接与权限**：host 新增 panel 层 HTTP 代理（含 multipart），绕过 webview CORS 限制；`manifest` 的 `network` / `webview.domains` 修正为字符串 `"all"`，修复 Permission denied；`callHost` 支持自定义超时，出图等待放宽至 5 分钟
- **贴入画布**：抽出 `_placeLayerFile`，新增 `saveAndPlaceImage` 原子接口（写盘后直接置入，大图 base64 只过一次消息桥）；贴入成败显式反馈，结果区按钮同步加固
- **配置持久化**：`cosai_key.json` 升级 v2 多平台结构，两平台互不覆盖并自动迁移旧档；切换平台即激活落盘，测试连接成功自动保存模型与平台

### v1.8.0 (2026-09-14)

> 风月 AI 首页 + 修图工具大师级重设计

- 新增「风月 AI」首页：极简美学极光光球动画、品牌标识、开始创作 / 修图工具双 CTA、功能入口卡片
- 修图工具面板重设计：玻璃拟态卡片、工具分组、SVG 图标、双语副标题、悬停反馈
- 修复「辉光效果 方法不可用」错误：向 `window.__cosai_ps_api` 暴露 `frequencySeparation` / `dodgeBurnCurves` / `glowEffect` / `stampVisible` / `mergeVisibleLayers`
- 修复文件中文字溢出：栈式布局 + 紧凑卡片 + `ellipsis` 省略号
- 自研 `cosaiConfirm` 确认弹窗替换原生 `confirm`（UXP webview 不支持）
- **架构收敛**：`app.html` 手写 UI 成为唯一渲染源，不再加载 React 版 `app.js`

### v1.7.0 (2026-09-11)

> 扩展图片处理能力：并发、一次多张、选区对齐返图、分级日志落盘

- **并发任务队列**：`generateImage` 重构为多任务队列，可连续入队多个生成任务，并发上限可配（1/2/3），调度器按上限依次运行、互不阻塞；每个任务独立卡片展示状态/阶段/进度/已得张数
- **一次生成 N 张**：新增「生成张数」配置（1/2/4），提交体携带期望张数，服务端返回不足时最多自动补齐重发 3 批
- **分级日志系统**：`window.__cosaiLog(level, module, msg)` 分级（debug/info/warn/error）+ 模块 + 毫秒时间戳，环形缓冲 500 条；去抖批量落盘到 `cosai_logs/cosai_日期.log`；「运行日志」面板支持级别过滤 / 导出 .log / 清空；`__dbg` 与 `addFeedback` 全部接入日志链路
- **选区对齐返图**：生成结果保存本地后贴回新图层，有选区时经 `transform` 严格贴合选区位置与尺寸（拉伸填满）
- 并发轮询状态改走磁盘日志，避免共享反馈面板刷屏

### v1.6.1 (2026-09-10)

- GRS 默认预设（默认 API 地址 `https://grsai.dakka.com.cn`、默认模型）
- 积分查询按钮实时显示用户积分（`getAPIKeyCredits`），会话/当日用量卡片
- 错误诊断优化：明确的失败原因提示与日志

### v1.6.0 (2026-09-10)

- 日志折叠交互
- AI API 连通性测试面板（保存配置后可测试连接）

### v1.5.1 (2026-09-08)

> 彻底修复工具箱图层复制失败核心问题

- 图层复制改为 **batchPlay 双保险**（DOM 复制 + 纯 batchPlay 回退），彻底绕开 batchPlay 后 `doc.activeLayer` 失同步导致的 `Cannot read undefined duplicate`
- `resolveNewLayerId` 增加 **三重保险**（batchPlay get targetEnum → DOM activeLayer → 前后 ID 差分），解决"定位新图层失败"问题
- 编组改用官方 `doc.createLayerGroup()`，保留 batchPlay 回退
- 增加版本标记 `COSAI_HOST_VERSION`，日志中可明确区分代码版本

### v1.5.0 (2026-09-08)

- 新增「风月-返图区域」独立模块
- 返图功能：预览、缩放、贴回画布、新建图层、对比模式、下载
- 樱花粉主题，玻璃拟态卡片设计
- 工具箱新增 ✨返图 按钮

### v1.4.0 (2026-09-08)

- **三个工具箱功能全部参考 HHPS 重写**
- 高低频：`applyImageEvent` 参数完全对齐 HHPS（`calculation` 对象类型、`subtract` 枚举值、`offset: 128`）
- 双曲线：曲线调整图层创建格式对齐 HHPS，蒙版填充优先 `imaging API`
- 辉光：全部操作走 batchPlay，支持多种混合模式
- 所有功能独立模块化（`风月-*` 文件夹）

### v1.3.0 (2026-09-08)

- 重写高低频分离，batchPlay 参数格式完全对齐 HHPS
- 所有 batchPlay 改为 `synchronousExecution: true`
- 新增独立模块文件夹 `风月-高低频/`

### v1.2.x (2026-09-08)

- v1.2.2：修复背景层场景，`doc.activeLayer` 为 null 时回退到 `doc.layers[0]`
- v1.2.1：工具箱函数移入 `executeAsModal`，修正 `applyImage` 参数与 offset
- v1.2.0：修复 React 通信桥接，改用 `uxpHost.postMessage`，三个工具箱按钮恢复正常

### v1.1.0 (2026-09-07)

- 新增工具箱三大功能：高低频分离、双曲线修图、辉光效果
- 全部在 `core.executeAsModal` 内执行，保证 PS 状态安全
- 顶部浮动工具箱栏（不依赖 React，直接 DOM 注入）

### v1.0.0 (2026-09-07)

- 初始版本，WebView 架构搭建完成
- 获取图片功能正常（exportAsBase64）
- 图层操作、选区操作、历史记录
- 修复双重 JSON 编码导致的通信失败
- 调试工具：诊断栏 + 调试条

---

## 许可证

本项目仅供学习和个人使用。基于 Adobe UXP 框架开发，Photoshop 插件需遵守 Adobe 相关许可协议。

---

*由 [yj9j6xt668](https://github.com/yj9j6xt668) 维护 — 风月 CosAI 修图助手*