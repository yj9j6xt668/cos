# CosAI — Photoshop 漫展修图助手

[![Version](https://img.shields.io/badge/version-1.5.1-blue.svg)]()
[![Platform](https://img.shields.io/badge/platform-Photoshop%202026+-green.svg)]()
[![Framework](https://img.shields.io/badge/framework-UXP%20v5-orange.svg)]()

> 一款专为漫展 Cosplay 人像精修设计的 Adobe Photoshop UXP 插件。提供高低频分离、双曲线修图、辉光效果三大核心修图工具，以及结果返图区域，让漫展修图高效、专业。

---

## 目录

- [功能简介](#功能简介)
- [架构概览](#架构概览)
- [安装指南](#安装指南)
- [使用说明](#使用说明)
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

CosAI 是一款面向 Photoshop 2026+ 的 UXP 面板插件，为漫展 Cosplay 人像后期提供一站式修图工具：

| 功能 | 说明 |
|------|------|
| **高低频分离** | 将图像分离为低频（光影/颜色层）和高频（纹理/细节层），互不干扰地精细修图 |
| **双曲线修图** | 用曲线调整图层建立提亮/压暗两支画笔，精准控制光影过渡 |
| **辉光效果** | 一键添加柔光/发光效果，模拟 Orton 效应，提升氛围感 |
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
│  │  │  (PS API) │    │  (React UI)          │   │ │
│  │  └──────────┘    └──────────────────────┘   │ │
│  └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

- **host.js**: 运行在 UXP 宿主环境，直接调用 Photoshop 原生 API（batchPlay、DOM 操作）
- **WebView**: 运行在 Chromium 渲染环境，承载 React 前端 UI
- **通信**: 通过 `uxpHost.postMessage` + `CustomEvent` 双向桥接

---

## 安装指南

### 系统要求

- Adobe Photoshop 2026 (v25.0.0+) — **仅支持 UXP v5 架构**
- macOS / Windows

### 安装步骤

1. **下载或构建** 插件代码
2. 将插件文件夹放置到 Photoshop 插件目录：
   - **macOS**: `~/Library/Application Support/Adobe/UXP/Plugins/External/`
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

---

## 使用说明

### 打开插件

Photoshop 菜单栏 → **窗口 → 扩展(旧版) → CosAI**（或 菜单栏 → 插件 → CosAI）

### 界面布局

- **顶部工具箱**: 浮动工具栏，包含所有修图功能按钮
- **主区域**: 图片预览、AI 处理结果展示（React 应用界面）
- **底部调试条**: 显示通信状态和错误信息（开发调试用）

### 注意事项

> ⚠️ 修改 `host.js` 后，必须**完全退出 Photoshop（Cmd+Q）** 再重新打开，新代码才会生效。仅关闭面板窗口或重新加载面板不会刷新 UXP 脚本缓存。

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
│  WebView (React)         Panel (UXP Host)      Photoshop API    │
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
- 所有 Photoshop 操作均包裹在 `core.executeAsModal()` 内

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 插件框架 | Adobe UXP v5 (Manifest v5) |
| 宿主脚本 | JavaScript (Photoshop UXP API) |
| 前端 UI | React (app.html / app.js) |
| 渲染引擎 | Chromium WebView (UXP embedded) |
| 通信协议 | postMessage + CustomEvent 桥接 |
| 底层 API | Photoshop batchPlay (action 层) |
| 版本控制 | Git |

---

## 项目结构

```
CosAI/
├── index.html          # 面板入口（host shell）
├── host.js             # UXP 宿主脚本（核心 PS API 调用）
├── panel-boot.js       # WebView 创建与消息桥
├── app.html            # React 应用入口（WebView 内）
├── app.js              # React 应用代码
├── app.css             # 样式文件
├── manifest.json       # 插件清单
├── boot.js             # 引导脚本
├── ext-test.js         # 测试脚本
├── wv-probe.js         # WebView 探测
├── icons/              # 插件图标
│   ├── icon-32.png
│   ├── icon-48.png
│   └── ...
├── 风月-高低频/         # 高低频分离独立模块（参考实现）
│   └── index.js
├── 风月-双曲线/         # 双曲线修图独立模块
│   └── index.js
├── 风月-辉光/           # 辉光效果独立模块
│   └── index.js
└── 风月-返图区域/       # 返图区域独立模块
    └── index.js
```

> **注意**: `风月-*` 文件夹是独立的参考实现模块，**不直接加载**。实际运行时使用的是 `host.js` 中内联的 `ToolboxAPI`。修改运行行为需改 `host.js`。

---

## 迭代日志

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

### v1.2.2 (2026-09-08)

- 修复背景层场景：`doc.activeLayer` 为 null 时回退到 `doc.layers[0]`
- 新增 `getSourceLayer()` 辅助函数

### v1.2.1 (2026-09-08)

- 修复工具箱函数：所有操作移到 `executeAsModal` 内部
- 修正 `applyImage` 参数格式和 offset 值
- 增加详细步骤日志

### v1.2.0 (2026-09-08)

- 修复 React 通信桥接，打通前端工具箱按钮
- 根因：`CustomEvent` 经 `window.uxp.entrypoints.panel.dispatchEvent` 不可靠，改用 `uxpHost.postMessage`
- 所有 React 按钮（高低频/双曲线/辉光）恢复正常调用

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