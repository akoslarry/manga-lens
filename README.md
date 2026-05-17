# MangaLens - 漫画实时翻译器

> 一款 Chrome 浏览器扩展，实时识别并翻译漫画图片中的日文文字

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Chrome Web Store](https://img.shields.io/badge/Chrome-Extension-green)](https://chrome.google.com/webstore)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-5.0-brightgreen)](https://vitejs.dev/)

---

## 功能特性

### 核心功能

| 功能 | 说明 |
|------|------|
| **多引擎 OCR** | 支持腾讯云 OCR（通用印刷体/高精度版）和 Hugging Face 本地模型（PaddleOCR） |
| **智能翻译** | 支持 MiniMax API 翻译，可选本地机器翻译引擎 |
| **并发控制** | OCR 队列（3并发）+ 翻译队列（5并发），避免 API 限流 |
| **对话合并** | 基于距离聚类算法，将分散文字合并为完整句子 |
| **四角锚点** | 8点锚点标记，自动检测图片旋转并校正坐标 |
| **RTL 支持** | 日漫从右往左阅读模式 |

---

## 技术架构

### 架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                         Chrome Extension                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐      ┌───────────────────┐                   │
│  │  popup.html  │ ←──→ │  content-script   │                   │
│  │   (Vue UI)   │      │    (主脚本)        │                   │
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
│              │ 图片获取  │ │ 腾讯云 OCR  │ │ MiniMax   │        │
│              │           │ │  (Base64)  │ │ 翻译 API  │        │
│              └───────────┘ └────────────┘ └───────────┘        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 技术栈

| 类别 | 技术 |
|------|------|
| 扩展框架 | Chrome Extension Manifest V3 |
| 构建工具 | Vite 5 + TypeScript 5 |
| UI 框架 | Vue 3 |
| 签名算法 | TC3-HMAC-SHA256 (腾讯云) |
| 加密库 | CryptoJS |
| OCR 引擎 | 腾讯云 OCR API / PaddleOCR (本地) |

---

## 安装部署

### 前置要求

- Node.js 18+
- npm 或 yarn
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

### 扩展配置项

打开扩展 popup 界面（点击扩展图标），配置以下选项：

| 配置项 | 说明 | 必填 |
|--------|------|------|
| **翻译开关** | 开启/关闭翻译功能 | 是 |
| **腾讯云 SecretId** | OCR API 身份标识 | 是 |
| **腾讯云 SecretKey** | OCR API 密钥 | 是 |
| **MiniMax API Key** | 翻译 API 密钥 | 是 |
| **OCR 模式** | 云函数 / 直接 API / 本地模型 | 是 |
| **腾讯云地域** | 如 ap-guangzhou | 是 |

### API 密钥获取

#### 腾讯云 OCR

1. 访问 [腾讯云控制台](https://console.cloud.tencent.com/cam/capi)
2. 创建访问密钥，获取 SecretId 和 SecretKey
3. 开通 [通用印刷体识别](https://console.cloud.tencent.com/ocr/overview) 服务

#### MiniMax 翻译

1. 访问 [MiniMax 控制台](https://www.minimaxi.com/user-center/basic-information/interface-key)
2. 创建 API Key

---

## 项目结构

```
manga-lens/
├── dist/                         # 构建输出目录
│   ├── manifest.json            # 扩展配置
│   ├── background.js            # 后台脚本
│   ├── content-script.js        # 内容脚本
│   ├── popup.html               # 弹出窗口
│   ├── popup.js                 # Popup 逻辑
│   └── content-styles.css       # 内容样式
│
├── public/                       # 静态资源
│   ├── manifest.json            # 扩展配置
│   ├── popup.html               # Popup HTML
│   └── content-styles.css       # 内容页样式
│
├── src/                          # 源代码
│   ├── content-script.ts         # 内容脚本入口
│   ├── background.ts             # 后台脚本（API 中转）
│   │
│   └── modules/                  # 功能模块
│       ├── ocr-engine.ts         # OCR 引擎 + 锚点机制
│       ├── translator.ts         # 翻译模块（MiniMax）
│       ├── local-translator.ts   # 本地翻译（可选）
│       ├── translation-overlay.ts # 翻译覆盖层渲染
│       ├── dialog-merger.ts      # 对话合并算法
│       ├── batch-translator.ts   # 批量翻译
│       ├── image-detector.ts     # 图片检测
│       ├── cloud-ocr-client.ts   # 云函数 OCR 客户端
│       └── tencent-cloud-ocr-direct.ts # 腾讯云 OCR 直连
│
├── cloud-functions/              # 云函数代码
│   └── tencent-ocr/             # 腾讯云 OCR 云函数
│
├── package.json                  # 项目配置
├── vite.config.ts               # Vite 配置
├── tsconfig.json                 # TypeScript 配置
└── README.md                    # 本文件
```

---

## 核心模块说明

### 1. content-script.ts - 内容脚本

负责漫画页面的图片检测、OCR 排队和翻译渲染。

**并发控制机制**:

```typescript
const OCR_CONCURRENCY = 3;           // 最多 3 个并发 OCR
const TRANSLATION_CONCURRENCY = 5;  // 最多 5 个并发翻译
const TRANSLATION_QUEUE_LIMIT = 10;  // 队列满时暂停 OCR
```

**消息类型**:

| 消息 | 来源 | 功能 |
|------|------|------|
| `TOGGLE_ENABLED` | Popup | 开关翻译 |
| `CONFIGURE_API` | Popup | 更新 API 配置 |
| `REFRESH` | Popup | 刷新页面翻译 |
| `SELECT_IMAGE` | Popup | 手动选择图片 |
| `GET_STATUS` | Popup | 获取处理状态 |

### 2. background.ts - 后台脚本

作为中转服务，解决 CORS 问题。

**核心功能**:

| 函数 | 功能 |
|------|------|
| `fetchImageAsBase64()` | 获取图片并转为 Base64 |
| `backgroundRecognizeWithTencentCloudAPI_Base64()` | 腾讯云 OCR (Base64 模式) |
| `backgroundRecognizeWithTencentCloudAPI_ImageUrl()` | 腾讯云 OCR (URL 模式) |

### 3. dialog-merger.ts - 对话合并

将分散的 OCR 结果合并为完整的对话。

**合并算法**:

```typescript
interface DialogMergerConfig {
  xThreshold: 40,        // X轴容差：同一列判定
  yThreshold: 40,        // Y轴容差：同一行判定
  rtlMode: true,         // 日漫从右往左阅读
  bubblePadding: 8,
  maxMergeDistance: 300  // 最大合并距离
}
```

**合并流程**:

1. **预处理**：计算边界 + 判断方向（竖排/横排）
2. **分离方向**：按宽高比分为竖排片段和横排片段
3. **分组**：
   - 竖排：按 X 起始点分组（同一列）
   - 横排：按 Y 起始点分组（同一行）
4. **组内排序**：
   - 竖排：按 Y 坐标排序（从上到下）
   - 横排：按 X 坐标排序（从右往左/从左往右）
5. **合并**：基于距离判断是否合并为同一对话

### 4. translation-overlay.ts - 翻译覆盖层

在原图片位置渲染翻译文字。

**渲染选项**:

| 选项 | 说明 |
|------|------|
| 字体 | 可选多种字体 |
| 背景 | 半透明黑色背景 |
| 描边 | 文字描边防止覆盖 |
| 字号 | 根据原文长度自动调整 |

### 5. ocr-engine.ts - OCR 引擎

负责 OCR 调用和四角锚点机制。

**四角锚点机制**:

```
在图片四角和四边中点添加8个锚点标记：
┌─────────────────────────────────────┐
│ 左上      上中      右上            │
│                                     │
│ 左中                    右中          │
│                                     │
│ 左下      下中      右下            │
└─────────────────────────────────────┘

锚点文本：左上、右上、右下、左下、上中、下中、左中、右中
```

**工作流程**:

1. 在图片上绘制 8 个锚点标记
2. 发送带锚点的图片到 OCR
3. OCR 识别锚点位置
4. 对比预期位置与实际位置，检测旋转角度
5. 校正所有文字坐标到正确方向
6. 过滤掉锚点文本

---

## 使用方法

### 基础操作

1. **开启翻译**
   - 点击扩展图标
   - 开启右上角开关
   - 页面自动开始处理漫画图片

2. **手动选择图片**
   - 点击扩展图标
   - 点击"手动选择图片"按钮
   - 点击页面上的漫画图片

3. **刷新翻译**
   - 点击"刷新页面翻译"按钮

4. **查看状态**
   - 点击扩展图标
   - 查看处理进度和统计

### 调试功能

打开浏览器控制台 (F12)，可使用：

```javascript
window.debugPixivImage()           // 调试 Pixiv 图片请求
window.testPixivReferer(imageUrl)  // 测试 Referer 头
```

---

## 常见问题

### Q: OCR 识别不准确？

A: 检查以下事项：
- 图片清晰度：建议使用高清漫画源站
- API 配置：确认腾讯云 OCR 服务已开通
- 文字方向：四角锚点机制会自动检测和校正

### Q: 翻译很慢？

A:
- 检查网络连接
- 确认 API 配额充足
- 减少单页漫画数量

### Q: 如何卸载扩展？

A: 打开 `chrome://extensions/`，找到 MangaLens，点击"移除"。

---

## 更新日志

### v1.0.5 (当前版本)

- 支持腾讯云 OCR 直接 API 模式
- 新增 Hugging Face 本地 PaddleOCR 模型
- 实现 OCR/翻译双队列并发控制
- 四角锚点机制：自动检测图片旋转并校正坐标
- 对话合并算法优化：基于距离的智能分组

---

## License

本项目采用 **MIT License** 开源许可证。

### MIT License 是什么？

MIT License 是一种开源许可证，具有以下特点：

**允许**：
- ✅ 商业使用
- ✅ 修改代码
- ✅ 分发代码
- ✅ 私有使用

**要求**：
- ⚠️ 必须包含原始版权声明和许可证文本

**禁止**（无此限制）：
- ❌ 不禁止任何使用方式

### 简而言之

使用本项目代码时，只需在项目中包含 LICENSE 文件并保留原作者版权声明即可。你可以自由地使用、修改、甚至商业化本项目的代码。

详细内容请参阅 [LICENSE](LICENSE) 文件。

---

## 致谢

- [腾讯云 OCR](https://cloud.tencent.com/product/ocr) - 文字识别服务
- [MiniMax](https://www.minimaxi.com/) - 翻译 API
- [Hugging Face](https://huggingface.co/) - 开源模型托管
- [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) - 开源 OCR 引擎
