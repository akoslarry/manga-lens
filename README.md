# MangaLens - 漫画实时翻译器

> 一款 Chrome 浏览器扩展，实时识别并翻译漫画图片中的日文文字，支持 PDF 导出

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Chrome Web Store](https://img.shields.io/badge/Chrome-Extension-green)](https://chrome.google.com/webstore)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-5.0-brightgreen)](https://vitejs.dev/)

---

## 功能特性

### 核心翻译管线

| 功能 | 说明 |
|------|------|
| **腾讯云 OCR** | 支持通用印刷体、高精度版、手写体、英文四种识别模式 |
| **DeepSeek V4 Pro 翻译** | 智能日→中翻译，上下文感知 |
| **并发控制** | OCR 队列（3并发）+ 翻译队列（5并发），10 任务上限自动暂停 |
| **对话合并** | 基于距离聚类的智能分组算法，竖排/横排自适应方向检测 |
| **四角锚点** | 8 点锚点自动检测图片旋转并校正坐标 |
| **RTL 支持** | 日漫从右往左阅读模式 |
| **本地翻译缓存** | IndexedDB 持久化存储，刷新页面无需重新调用 API，节省 Token |

### PDF 导出编辑

| 功能 | 说明 |
|------|------|
| **进入导出模式** | Popup 一键进入编辑态 |
| **双击编辑文字** | 双击覆盖层直接修改翻译文本 |
| **拖拽移动** | 拖拽覆盖层调整位置 |
| **缩放手柄** | 四角拖拽调整覆盖层尺寸 |
| **字号调节** | 单个覆盖层独立字号设置 |
| **透明度控制** | 独立调节覆盖层透明度 |
| **删除覆盖层** | 移除不需要的翻译气泡 |
| **工具栏** | 选中覆盖层弹出编辑工具栏（字号/透明/删除） |
| **PDF 导出** | jsPDF + html2canvas 合成 PDF，支持自定义保存子目录 |
| **退出自动保存** | 退出时自动持久化所有编辑到本地缓存 |

---

## 技术架构

```
┌─────────────────────────────────────────────────────────────────┐
│                         Chrome Extension                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐      ┌───────────────────┐                   │
│  │  popup.html  │ ←──→ │  content-script   │                   │
│  │  (原生 HTML) │      │    (主脚本)        │                   │
│  └──────────────┘      └─────────┬─────────┘                   │
│                                  │                              │
│                         chrome.runtime.sendMessage               │
│                                  │                              │
│                         ┌─────────▼─────────┐                   │
│                         │    background.js  │                   │
│                         │   (Service Worker) │                  │
│                         └─────────┬─────────┘                   │
│                                   │                              │
│                    ┌──────────────┼──────────────┐              │
│                    │              │              │              │
│              ┌─────▼─────┐ ┌──────▼─────┐ ┌─────▼─────┐        │
│              │ 图片获取  │ │ 腾讯云 OCR  │ │ DeepSeek  │        │
│              │           │ │  (Base64)  │ │ 翻译 API  │        │
│              └───────────┘ └────────────┘ └───────────┘        │
│                                                                  │
│  本地存储层:  translation-cache (IndexedDB 持久化翻译结果)     │
│  PDF 导出层:  export-pdf (jsPDF + html2canvas 合成)             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 技术栈

| 类别 | 技术 |
|------|------|
| 扩展框架 | Chrome Extension Manifest V3 |
| 构建工具 | Vite 5 + TypeScript 5 |
| 签名算法 | TC3-HMAC-SHA256 (腾讯云) |
| 加密库 | CryptoJS |
| OCR 引擎 | 腾讯云 OCR API |
| 翻译引擎 | DeepSeek V4 Pro |
| PDF 导出 | jsPDF + html2canvas + pdf-lib |
| 本地存储 | IndexedDB (idb-keyval) |

---

## 安装部署

### 前置要求

- Node.js 18+
- npm
- Chrome 浏览器

### 安装步骤

```bash
# 1. 克隆项目
git clone https://github.com/akoslarry/manga-lens.git
cd manga-lens

# 2. 安装依赖
npm install

# 3. 构建扩展
npm run build

# 4. 加载扩展
#    - 打开 Chrome，访问 chrome://extensions/
#    - 开启"开发者模式"
#    - 点击"加载已解压的扩展程序"
#    - 选择项目中的 dist/ 目录
```

### 开发模式

```bash
npm run dev     # 启动开发服务器（热重载）
npm run build   # 构建生产版本
```

---

## 配置说明

打开扩展 popup 界面（点击扩展图标），配置以下选项：

| 配置项 | 说明 | 必填 |
|--------|------|------|
| **翻译开关** | 开启/关闭翻译功能 | 是 |
| **本地翻译缓存** | 启用后刷新页面直接读缓存 | 推荐开启 |
| **DeepSeek API Key** | 翻译 API 密钥 | 是（支持环境变量 `DEEPSEEK_API_KEY`） |
| **腾讯云 SecretId** | OCR API 身份标识 | 是 |
| **腾讯云 SecretKey** | OCR API 密钥 | 是 |
| **腾讯云地域** | 如 ap-guangzhou | 是 |
| **OCR 模式** | 高精度/基础/手写体/英文 | 是 |
| **字体大小** | 覆盖层默认字号（10-36px）| 默认 22px |
| **单次翻译上限** | 每批次最大图片数（1-100）| 默认 30 |
| **PDF 保存子目录** | 下载目录下的子目录名 | 默认 manga-exports |

### API 密钥获取

**腾讯云 OCR**：访问 [腾讯云控制台](https://console.cloud.tencent.com/cam/capi) → 创建子用户并授权 `QcloudOCRFullAccess` → 获取 SecretId/SecretKey → 开通 [通用文字识别（高精度版）](https://console.cloud.tencent.com/ocr/overview)。

**DeepSeek 翻译**：访问 [DeepSeek 控制台](https://platform.deepseek.com/api_keys) → 创建 API Key → 填入扩展配置或设置环境变量 `DEEPSEEK_API_KEY`。

---

## 项目结构

```
manga-lens/
├── dist/                          # 构建输出目录
│   ├── manifest.json
│   ├── background.js              # Service Worker
│   ├── content-script.js          # 内容脚本（主入口）
│   ├── popup.html                 # 弹出窗口
│   └── content-styles.css         # 覆盖层样式
│
├── public/                        # 静态资源
│   ├── manifest.json              # 扩展清单
│   ├── popup.html                 # Popup 页面
│   └── content-styles.css         # 内容页样式
│
├── src/                           # 源代码
│   ├── content-script.ts          # 内容脚本入口（翻译管线 + PDF模式）
│   ├── background.ts              # 后台脚本（API 中转 + 图片获取）
│   │
│   └── modules/                   # 功能模块
│       ├── ocr-engine.ts          # OCR 引擎 + 四角锚点机制
│       ├── tencent-cloud-ocr-direct.ts  # 腾讯云 OCR 直连客户端
│       ├── cloud-ocr-client.ts    # 云端 OCR 请求封装
│       ├── translator.ts          # DeepSeek V4 Pro 翻译器
│       ├── batch-translator.ts    # 批量翻译调度
│       ├── dialog-merger.ts       # 对话合并算法（距离聚类）
│       ├── translation-overlay.ts # 翻译覆盖层渲染引擎
│       ├── translation-cache.ts   # IndexedDB 本地翻译缓存
│       ├── export-pdf.ts          # PDF 导出编辑引擎（编辑/缩放/透明度/合成）
│       └── image-detector.ts      # 漫画图片检测
│
├── package.json
├── vite.config.ts
├── tsconfig.json
├── post-build.mjs                 # 构建后处理脚本
└── README.md
```

---

## 核心模块说明

### 1. content-script.ts — 内容脚本主入口

漫画页面的图片检测、OCR 排队、翻译渲染、PDF 编辑模式的全部调度中心。

**并发控制机制**:

```
OCR 队列: 3 并发
翻译队列: 5 并发
任务上限: 10（队列满时暂停 OCR）
批次上限: 默认 30 张/次（可在 Popup 中配置 1-100）
```

**消息类型**:

| 消息 | 来源 | 功能 |
|------|------|------|
| `TOGGLE_ENABLED` | Popup | 开关翻译 |
| `CONFIGURE_API` | Popup | 更新 API 配置 |
| `REFRESH` | Popup | 刷新页面翻译 |
| `SELECT_IMAGE` | Popup | 手动选择图片 |
| `GET_STATUS` | Popup | 获取处理状态 |
| `ENTER_PDF_MODE` | Popup | 进入 PDF 导出编辑模式 |

### 2. background.ts — Service Worker

API 请求中转，解决浏览器跨域限制。核心能力：图片 URL→Base64 转换、腾讯云 OCR 签名请求（Base64 及 URL 两种模式）。

### 3. dialog-merger.ts — 对话合并

距离聚类算法将 OCR 碎片合并为完整对话。

**合并流程**：预处理（边界计算 + 竖排/横排判断）→ 分离方向 → 按行/列分组 → 组内排序（竖排按Y、横排按 RTL 规则）→ 距离阈值合并。

### 4. translation-cache.ts — 本地翻译缓存

基于 IndexedDB 的持久化翻译缓存。刷新页面时直接读取缓存渲染，避免重复调用 OCR/翻译 API。在 PDF 编辑模式下自动同步用户修改（文字/位置/字号/透明度/删除）。

### 5. export-pdf.ts — PDF 导出编辑引擎

完整的所见即所得编辑系统：

- **选择系统**：点击选中覆盖层，边框高亮 + 缩放四角手柄
- **文本编辑**：双击覆盖层进入文字编辑模式
- **拖拽移动**：选中后拖拽平移覆盖层位置
- **缩放手柄**：四角拖拽缩放覆盖层尺寸
- **工具栏**：选中后弹出浮动工具栏（字号调节/透明度滑块/删除按钮）
- **PDF 合成**：jsPDF + html2canvas 渲染整页为 PDF
- **自动保存**：退出时自动持久化所有编辑到 IndexedDB 缓存

### 6. ocr-engine.ts — OCR 引擎

腾讯云 OCR 调用与四角锚点机制。在图片四角及四边中点添加 8 个锚点标记，OCR 识别锚点后对比预期位置检测旋转角度，校正所有文字坐标。

---

## 使用方法

### 基础操作

1. **配置 API**：点击扩展图标 → 分别配置翻译 API 和 OCR 设置 → 保存并测试连接
2. **开启翻译**：打开右上角开关，页面自动开始处理漫画图片
3. **手动选择**：点击"手动选择图片或重新翻译" → 点击页面上的目标图片
4. **刷新翻译**：点击"刷新页面翻译"按钮

### PDF 导出流程

1. 等待所有目标图片翻译完成
2. 点击 Popup 中的「进入PDF导出模式」
3. 在编辑模式下调整覆盖层：双击改文字、拖拽改位置、缩放改大小、工具栏调字号/透明度
4. 点击「退出PDF导出模式」→ 自动保存所有修改到本地缓存
5. 下一次进入同一页面时，编辑结果会从缓存直接加载

---

## 常见问题

**Q: OCR 识别不准确？**
检查图片清晰度，漫画推荐使用「高精度识别」模式。锚点机制会自动检测和校正旋转。

**Q: 翻译很慢？**
检查网络连接和 API 配额。翻译瓶颈通常在 DeepSeek API 响应速度，OCR 3 并发可充分并行。

**Q: 如何卸载扩展？**
打开 `chrome://extensions/`，找到 MangaLens，点击"移除"。

**Q: 退出 PDF 模式后编辑丢失？**
v1.1.0 起退出时自动弹窗确认并持久化。选择"保留修改"即写入本地缓存，刷新页面不丢失。

---

## 更新日志

### v1.1.0

- **PDF 导出编辑系统**：完整的所见即所得编辑，支持双击改文字、拖拽移动、缩放调整
- **覆盖层透明度**：单个覆盖层独立透明度控制（滑块调节）
- **覆盖层删除**：移除不需要的翻译气泡
- **浮动工具栏**：选中覆盖层弹出编辑工具栏（字号/透明/删除）
- **退出自动保存**：修复退出时不触发保存的 bug（缩放未标记脏数据 + 退出前条件跳过），确保编辑结果持久化
- **本地翻译缓存**：IndexedDB 持久化管理，支持启用/禁用开关
- **单次翻译上限**：可配置批次最大图片数
- 移除 Hugging Face 本地 OCR 依赖，统一使用腾讯云 OCR

### v1.0.5

- 支持腾讯云 OCR 直接 API 模式
- 实现 OCR/翻译双队列并发控制
- 四角锚点机制：自动检测图片旋转并校正坐标
- 对话合并算法优化：基于距离的智能分组

---

## 未来规划

- [ ] **主流漫画网站反爬适配** — Pixiv/FANBOX 等网站的 Referer/Cookie/UA 反爬处理
- [ ] **批量 PDF 导出** — 多页面/分章节一键导出
- [ ] **跨平台桌面版** — Electron 桌面应用，脱离浏览器扩展限制
- [ ] **SaaS 云服务化** — 统一管理 API 密钥，订阅制一键翻译

---

## 致谢

- [腾讯云 OCR](https://cloud.tencent.com/product/ocr) — 文字识别服务
- [DeepSeek](https://www.deepseek.com/) — 翻译 API
- [jsPDF](https://github.com/parallax/jsPDF) — PDF 生成
- [html2canvas](https://html2canvas.hertzen.com/) — 页面截图渲染
