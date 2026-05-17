# MangaLens AI Agent 协作指南

> 本文档供 AI Coding Agent 快速理解项目架构和开发规范

## 项目概述

**MangaLens** 是一个 Chrome 浏览器扩展，实时识别漫画图片中的日文文字并翻译为中文。

- **核心流程**: 图片检测 → OCR 识别 → 对话合并 → 翻译 → 覆盖层渲染
- **Manifest Version**: MV3
- **构建工具**: Vite + TypeScript

## 关键技术决策

### 1. OCR 方向锚点机制

**问题**: 腾讯云 OCR 在没有横向文本时可能错误判断图片方向

**解决方案**: 在发送给 OCR 的图片顶部和底部添加 `<この画像は横です>` 锚点文本，诱导 OCR 使用正确方向

```typescript
// 位置: src/modules/ocr-engine.ts - addDirectionAnchorText()
```

### 2. 对话合并算法

**问题**: OCR 识别结果是分散的文字片段，需要合并成完整句子

**解决方案**: 
- X轴分组：同一列的气泡 X 坐标差异 < 150px
- Y轴排序：组内按 Y 坐标排序
- 竖排合并：Y轴距离 < 50px 时合并

```typescript
// 位置: src/modules/dialog-merger.ts
// 配置: xThreshold=150, yThreshold=50, maxMergeDistance=300
```

### 3. CORS 跨域解决方案

**问题**: Content Script 中的 fetch 受页面 CORS 限制

**解决方案**: 所有 API 调用通过 Background Script 中转

```
Content Script → Background Script → OCR/翻译 API
```

### 4. TC3 签名（腾讯云）

**关键点**: 时间戳必须使用 UTC 时区

```javascript
const date = new Date(timestamp * 1000).toISOString().split('T')[0]; // UTC 日期
```

## 项目结构

```
manga-lens/
├── src/
│   ├── content-script.ts    # 入口，图片处理主流程
│   ├── background.ts        # API 中转（解决 CORS）
│   ├── modules/
│   │   ├── ocr-engine.ts          # OCR 引擎 + 锚点添加
│   │   ├── dialog-merger.ts       # 对话合并算法
│   │   ├── translation-overlay.ts # 覆盖层渲染
│   │   ├── batch-translator.ts    # 批量翻译（单图单次）
│   │   └── tencent-cloud-ocr-direct.ts  # 腾讯云 OCR 直连
│   └── popup/               # 扩展设置界面
├── dist/                    # 构建输出（加载到 Chrome）
└── cloud-functions/         # 云函数代码
```

## 核心流程时序

```
1. 页面加载 → image-detector 检测漫画图片
2. 图片预处理 → 添加方向锚点文本
3. OCR 识别 → 腾讯云 GeneralAccurateOCR (MulOCR)
4. 对话合并 → X轴分组 + Y轴排序 + 合并
5. 批量翻译 → MiniMax M2 模型，单图单次请求
6. 覆盖层渲染 → 竖排译文渲染到原文位置
```

## API 配置

| API | 用途 | 存储位置 |
|-----|------|---------|
| 腾讯云 OCR | 文字识别 | chrome.storage.local (tencentSecretId/Key) |
| MiniMax | 翻译 | chrome.storage.local (minimaxApiKey) |

**注意**: API 密钥通过 Popup UI 配置，不在代码中硬编码

## 开发命令

```bash
npm install      # 安装依赖
npm run dev      # 开发模式
npm run build    # 构建扩展到 dist/
```

## 构建产物

- `dist/content-script.js` - IIFE 格式，内容脚本
- `dist/background.js` - IIFE 格式，后台脚本
- `dist/popup.js` - IIFE 格式，Popup 脚本

## 常见问题

### Q: 翻译文本框没有融合？
A: 检查 `dialog-merger.ts` 的 `xThreshold`、`yThreshold` 参数，适当调大

### Q: OCR 方向错误？
A: 检查 `ocr-engine.ts` 的 `addDirectionAnchorText()` 方法，确保锚点文本正确添加

### Q: 旋转按钮报错？
A: 旋转功能已移除，如需恢复使用 CustomEvent 机制而非 chrome.runtime.sendMessage

## 代码规范

1. **类型安全**: 所有函数参数和返回值必须有类型注解
2. **日志输出**: 关键步骤使用 `console.log('[ModuleName] ...')`
3. **错误处理**: API 调用必须 try-catch，并输出有意义的错误信息
4. **不硬编码**: API 密钥必须从 chrome.storage 读取，不写在代码里
