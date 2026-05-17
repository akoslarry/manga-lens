# 📚 MangaLens - 漫画实时翻译器

> 让阅读生肉漫画不再是障碍，实时识别并翻译日文文字

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Chrome](https://img.shields.io/badge/Chrome-Extension-green.svg)](https://chrome.google.com/webstore)

## 🎯 项目简介

MangaLens 是一款 Chrome 浏览器扩展程序，能够实时识别网页漫画中的日文文字，并将其翻译成中文，让用户无需任何日语基础就能享受原版漫画。

### 核心特性

- 📖 **实时翻译** - 自动检测并翻译漫画图片中的日文
- 🎨 **原位覆盖** - 翻译文字覆盖在原位置，不影响阅读体验
- 🔒 **隐私保护** - API 密钥存储在本地，不上传服务器
- ⚡ **智能合并** - 对话片段自动合并为完整句子
- 📱 **响应式支持** - 支持滚动翻页、懒加载等动态内容

## 🛠️ 技术栈

| 类别 | 技术 |
|------|------|
| **OCR 引擎** | 腾讯云 OCR (GeneralAccurateOCR + MulOCR) |
| **翻译 API** | MiniMax M2 模型 |
| **扩展框架** | Chrome Extension (Manifest V3) |
| **构建工具** | Vite + TypeScript |
| **签名算法** | TC3-HMAC-SHA256 (腾讯云) |

## 🚀 快速开始

### 前置要求

- Node.js 18+
- npm 或 yarn
- 腾讯云账号（获取 OCR API 密钥）
- MiniMax 账号（获取翻译 API 密钥）

### 安装步骤

1. **克隆项目**
```bash
git clone https://github.com/your-username/manga-lens.git
cd manga-lens
```

2. **安装依赖**
```bash
npm install
```

3. **配置 API 密钥**

打开扩展 popup 界面（点击扩展图标），在设置页面填入：
- **MiniMax API Key**: 翻译用
- **腾讯云 SecretId/SecretKey**: OCR 识别用

4. **加载扩展**
   - 打开 Chrome，访问 `chrome://extensions/`
   - 开启"开发者模式"
   - 点击"加载已解压的扩展程序"
   - 选择项目中的 `dist/` 目录

5. **开始使用**
   - 访问漫画网站
   - 点击扩展图标
   - 开启翻译开关

## 🔑 API 密钥获取

### MiniMax 翻译 API

1. 访问 [MiniMax 控制台](https://www.minimaxi.com/user-center/basic-information/interface-key)
2. 创建 API Key
3. 在扩展设置中填入

### 腾讯云 OCR API

1. 访问 [腾讯云控制台](https://console.cloud.tencent.com/cam/capi)
2. 创建访问密钥（SecretId + SecretKey）
3. 开通 OCR 服务（通用印刷体识别/高精度版）
4. 在扩展设置中填入

## 📁 项目结构

```
manga-lens/
├── dist/                        # 构建输出（Chrome 扩展加载此目录）
│   ├── manifest.json            # 扩展配置
│   ├── background.js            # 后台脚本（Service Worker）
│   ├── content-script.js       # 内容脚本（注入到漫画页面）
│   └── popup.js                 # 弹出窗口脚本
├── src/                         # 源代码目录
│   ├── content-script.ts        # 内容脚本入口
│   ├── background.ts            # 后台脚本（API 中转）
│   ├── modules/
│   │   ├── ocr-engine.ts        # OCR 引擎 + 锚点机制
│   │   ├── dialog-merger.ts    # 对话合并算法
│   │   ├── translation-overlay.ts  # 翻译覆盖层渲染
│   │   ├── batch-translator.ts # 批量翻译（单图单次）
│   │   └── tencent-cloud-ocr-direct.ts  # 腾讯云 OCR 直连
│   └── popup/
│       └── index.html           # Popup 界面
├── cloud-functions/            # 云函数代码（可选）
│   └── tencent-ocr/            # OCR 云函数
├── package.json
├── tsconfig.json
├── vite.config.ts
└── README.md
```

## 🎮 使用说明

### 基本操作

1. **开启/关闭翻译**
   - 点击扩展图标
   - 切换右上角开关

2. **配置 API**
   - 点击扩展图标
   - 在对应标签页填写 API 密钥
   - 点击"保存配置"

3. **刷新翻译**
   - 点击"刷新页面翻译"按钮
   - 扩展会重新检测并翻译页面中的漫画

### 工作原理

```
漫画页面 → 图片检测 → 添加方向锚点 → OCR 识别
    ↓
对话合并（X轴分组 + Y轴排序）→ 批量翻译 → 覆盖层渲染
```

### 核心技术

#### 1. OCR 方向锚点

当漫画中没有横向文本时，OCR 可能错误判断图片方向。解决方案：

- 在发送给 OCR 的图片**顶部和底部**添加 `<この画像は横です>` 锚点文本
- 诱导 OCR 使用正确方向识别
- OCR 结果中过滤掉锚点文本

#### 2. 对话合并算法

OCR 识别结果是分散的文字片段，通过以下步骤合并：

1. **X轴分组**: 同一列的气泡 X 坐标差异 < 150px
2. **Y轴排序**: 组内按 Y 坐标排序
3. **合并判断**: Y轴距离 < 50px 时合并为同一对话

## 🔧 开发指南

### 本地开发

```bash
# 安装依赖
npm install

# 启动开发模式（热重载）
npm run dev

# 构建生产版本
npm run build
```

### 构建产物说明

| 文件 | 说明 |
|------|------|
| `dist/content-script.js` | IIFE 格式，内容脚本 |
| `dist/background.js` | IIFE 格式，后台脚本 |
| `dist/popup.js` | IIFE 格式，Popup 脚本 |

### 模块说明

| 模块 | 职责 |
|------|------|
| `ocr-engine.ts` | OCR 识别、锚点添加、TC3 签名 |
| `dialog-merger.ts` | 对话片段合并算法 |
| `translation-overlay.ts` | 翻译覆盖层渲染 |
| `batch-translator.ts` | MiniMax 批量翻译 |

## 🤝 贡献指南

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

### 协作文档

- [项目概述](PROJECT_OVERVIEW.md) - 详细架构说明
- [AI Agent 指南](AGENT_GUIDE.md) - 快速理解项目要点
- [Chrome 扩展开发指南](CHROME-EXTENSION-GUIDE.md)

## ⚠️ 注意事项

1. **API 密钥安全**: 所有 API 密钥存储在 `chrome.storage.local`，不会硬编码到代码
2. **.gitignore**: 已排除 `node_modules/`、`dist/`、`.env` 等
3. **CORS 解决**: 所有 API 调用通过 Background Script 中转

## 📝 License

MIT License

---

Made with ❤️ for manga lovers
