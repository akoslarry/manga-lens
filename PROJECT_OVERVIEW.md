# MangaLens 项目概述

> 漫画实时翻译器 Chrome 扩展 - 项目文档

## 项目基本信息

- **项目名称**: MangaLens - 漫画实时翻译器
- **版本**: v2.0.0
- **Manifest Version**: MV3 (Manifest V3)
- **目标用户**: 阅读日文/韩文/英文漫画的用户
- **核心功能**: 自动识别漫画图片中的文字，调用 OCR 识别后翻译为中文

## 项目结构

```
manga-lens/
├── dist/                          # 构建输出目录（Chrome 扩展加载此目录）
│   ├── manifest.json              # 扩展配置
│   ├── background.js              # 后台脚本（Service Worker）
│   ├── content-script.js          # 内容脚本（注入到漫画页面）
│   ├── popup.js                   # 弹出窗口脚本
│   ├── content-styles.css         # 内容样式
│   ├── icons/                     # 扩展图标
│   └── src/popup/index.html       # Popup HTML
├── src/                           # 源代码目录
│   ├── background.ts              # 后台脚本源码
│   ├── content-script.ts          # 内容脚本源码
│   ├── manifest.json              # Manifest 配置
│   ├── popup/
│   │   ├── index.html             # Popup HTML
│   │   └── popup.js               # Popup 脚本
│   └── modules/                   # 核心模块
│       ├── ocr-engine.ts          # OCR 识别引擎
│       ├── translator.ts          # 翻译模块
│       ├── image-detector.ts      # 图片检测
│       ├── translation-overlay.ts  # 翻译覆盖层
│       ├── cloud-ocr-client.ts    # 云函数 OCR 客户端
│       └── tencent-cloud-ocr-direct.ts  # 腾讯云直连 OCR
├── public/                        # 静态资源
├── cloud-functions/               # 云函数代码（腾讯云）
│   └── tencent-ocr/              # OCR 云函数
├── package.json
├── vite.config.ts                # Vite 配置
├── tsconfig.json                 # TypeScript 配置
└── post-build.mjs               # 构建后处理脚本
```

## 构建流程

### 1. Vite 打包
```bash
npm run build  # vite build && node post-build.mjs
```
Vite 会将 TypeScript 源码打包并输出到 `dist/` 目录。

### 2. esbuild IIFE 打包（post-build.mjs）
将 `src/` 下的脚本通过 esbuild 重新打包为 **IIFE 格式**：
- `content-script.js` → IIFE
- `background.js` → IIFE
- `popup.js` → IIFE

**重要**: MV3 扩展的 content script 不支持 ES modules (import/export)，必须打包为 IIFE 格式。

### 3. 输出文件
| 文件 | 大小 | 说明 |
|------|------|------|
| content-script.js | ~47KB | 内容脚本 |
| background.js | ~10KB | 后台脚本 |
| popup.js | ~14KB | 弹出窗口脚本 |

## 核心运行逻辑

### 扩展架构
```
┌─────────────────────────────────────────────────────────────┐
│                     Chrome Extension                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐     │
│  │   Popup     │    │  Background │    │   Content   │     │
│  │  (popup.js) │◄──►│   (sw.js)   │◄──►│   Script    │     │
│  │             │    │             │    │             │     │
│  │ - UI 配置   │    │ - OCR 中转  │    │ - 图片检测  │     │
│  │ - API 测试  │    │ - 图片获取  │    │ - OCR 识别  │     │
│  │             │    │ - CORS 代理 │    │ - 翻译渲染  │     │
│  └─────────────┘    └─────────────┘    └─────────────┘     │
│                                              │               │
│                                              ▼               │
│                                    ┌─────────────────┐       │
│                                    │   漫画页面      │       │
│                                    │  (用户访问的网站) │       │
│                                    └─────────────────┘       │
└─────────────────────────────────────────────────────────────┘
```

### 工作流程

#### 1. 初始化阶段
1. Content Script 加载完成
2. 初始化 OCR 模块（加载配置）
3. 从 `chrome.storage.local` 加载 API 密钥
4. 扫描页面图片

#### 2. 图片处理流程
```
页面加载 → 检测图片 → 提取图片 URL
                          │
                          ▼
              通过 Background 获取图片（解决跨域）
                          │
                          ▼
                    调用腾讯云 OCR API
                          │
                          ▼
                   返回文字区域坐标 + 文字
                          │
                          ▼
                      调用翻译 API
                          │
                          ▼
                  渲染翻译覆盖层到图片上
```

#### 3. OCR 调用流程（重要 - CORS 解决方案）
```
Content Script 收到图片 URL
          │
          ▼
┌─────────────────────────────────┐
│  方式 A: 云函数模式              │
│  发送消息到 Background          │
│  Background 调用云函数（无CORS） │
└─────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────┐
│  方式 B: 直接 API 模式           │
│  发送 FETCH_IMAGE_AND_OCR 消息  │
│  Background:                    │
│    1. fetch 图片（无 CORS）      │
│    2. 计算 TC3 签名              │
│    3. 调用腾讯云 OCR API         │
└─────────────────────────────────┘
```

### 消息通信

| 消息类型 | 来源 → 目标 | 用途 |
|---------|------------|------|
| `TEST_DIRECT_OCR` | Popup → Background | 测试腾讯云 OCR 连接 |
| `DIRECT_OCR_RECOGNIZE` | Content → Background | 使用腾讯云 OCR 识别图片 |
| `FETCH_IMAGE_AS_BASE64` | Content → Background | 通过 Background 获取跨域图片 |
| `FETCH_IMAGE_AND_OCR` | Content → Background | 获取图片 + OCR 识别（组合操作） |
| `CONFIGURE_API` | Popup → Content | 更新翻译 API 配置 |
| `TOGGLE_ENABLED` | Popup → Content | 开关翻译功能 |

## API 配置

### MiniMax 翻译 API
- **用途**: 翻译识别出的文字
- **配置位置**: Popup > MiniMax 翻译 标签页
- **API 类型**: REST API (Bearer Token)
- **免费额度**: Token Plan Key 免费额度高

### 腾讯云 OCR API
- **用途**: 识别漫画图片中的文字
- **配置位置**: Popup > OCR 设置 > 直接API模式
- **认证方式**: TC3-HMAC-SHA256 签名
- **区域**: ap-guangzhou / ap-beijing / ap-shanghai 等

#### TC3 签名格式（重点）
```
Credential = SecretId/Date/Service/Region/tc3_request
例如: AKIDxxx/2026-04-26/ocr/ap-beijing/tc3_request
```

## 当前问题（待修复）

### 1. Popup UI 按钮无响应
- **状态**: 已修复路径问题 (`../../popup.js`)
- **原因**: `popup.js` 输出到 `dist/popup.js`，但 HTML 引用相对路径错误

### 2. CORS 限制
- **状态**: 已通过 Background Script 中转解决
- **方案**: 所有 API 调用通过 `background.ts` 中的 `FETCH_IMAGE_AND_OCR` 消息处理

### 3. 跨域图片处理
- **状态**: 已解决
- **方案**: Background Script 可以 fetch 任意 URL，将图片转为 base64 后再处理

### 4. TC3 签名格式
- **状态**: 已修复
- **问题**: Credential Scope 顺序错误
- **正确格式**: `SecretId/Date/Service/Region/tc3_request`

## 技术要点

### Chrome Extension MV3 限制
1. **Content Script**: 不支持 ES modules，必须打包为 IIFE
2. **Service Worker**: 可能被终止，不能依赖内存状态
3. **CORS**: Content Script 中的 fetch 受页面 Origin 限制
4. **解决方案**: 通过 Background Script 作为代理中转请求

### 构建要点
1. 使用 `post-build.mjs` 重新打包为 IIFE 格式
2. 移除 `manifest.json` 中的 `"type": "module"`
3. Popup HTML 路径使用 `../../popup.js` 引用

### 关键文件
- `src/background.ts` - 后台脚本，核心中转逻辑
- `src/modules/ocr-engine.ts` - OCR 识别引擎
- `src/popup/popup.js` - Popup UI 逻辑

## 测试方法

1. 打开 `chrome://extensions/`
2. 加载 `manga-lens/dist/` 目录作为扩展
3. 点击扩展图标打开 Popup
4. 配置 API 密钥
5. 访问漫画页面测试

## 开发命令

```bash
npm install        # 安装依赖
npm run build      # 构建扩展
npm run dev        # 开发模式（Vite）
```
