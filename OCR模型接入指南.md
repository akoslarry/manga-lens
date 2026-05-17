# MangaLens - OCR 模型接入指南

## 一、API 费用说明

### 腾讯混元翻译 API 费用

| 项目 | 说明 |
|------|------|
| **免费额度** | 100万 tokens（有效期1年） |
| **计费方式** | 按实际使用的 tokens 数计费 |
| **价格** | 输入 1.2元/百万tokens，输出 3.6元/百万tokens |
| **预估** | 翻译一本 200 页漫画 ≈ 几十元 |

### 费用预估示例

```
漫画对话翻译：
- 平均每段文字 20 个日文字符
- 约 30-40 tokens
- 一页漫画 10 段对话 ≈ 350 tokens

一本 200 页漫画：
- 200 × 350 = 70,000 tokens
- 费用 ≈ 0.07 元

如果日文翻译成中文（输出更长）：
- 约 2-3 倍 token 数
- 一本 200 页漫画 ≈ 0.15-0.2 元
```

### ⚠️ 注意事项

1. **免费额度用完后**才会扣费
2. **建议设置额度提醒**，避免意外超支
3. **使用缓存**可以大幅减少 API 调用（已实现）

---

## 二、OCR 模型的必要性

### 2.1 为什么需要 OCR？

```
┌─────────────────────────────────────────────────────────────┐
│                  没有 OCR = 无法工作                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   漫画图片 → ??? → 文字 → 翻译 → 显示                       │
│                    ↑                                        │
│                 必须有 OCR！                                │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 OCR 模型的价值

| 价值点 | 说明 |
|--------|------|
| **文字识别** | 从图片中提取日文文字 |
| **位置定位** | 知道文字在图片的哪个位置 |
| **文字方向** | 识别横排/竖排文字 |
| **多语言支持** | 日文汉字、平假名、片假名 |

### 2.3 可选的 OCR 方案

#### 方案 A：浏览器端 OCR（推荐用于比赛）

```typescript
// 使用 transformers.js 在浏览器中运行
import { pipeline } from '@huggingface/transformers';

const ocr = await pipeline('image-to-text', 'kha-white/manga-ocr-base');
const result = await ocr(imageData);
```

**优点**：
- ✅ 无需后端服务器
- ✅ 保护用户隐私
- ✅ 响应速度快
- ✅ 离线可用

**缺点**：
- ⚠️ 首次加载模型需要下载（约 400MB）
- ⚠️ 占用浏览器内存

#### 方案 B：云端 OCR API

| 服务 | 价格 | 特点 |
|------|------|------|
| 腾讯云 OCR | ¥0.1-0.3/次 | 中文识别好，日文一般 |
| Google Vision | $1.5/1000次 | 贵，日文支持一般 |
| Azure Computer Vision | 按量计费 | 贵 |
| DeepL API | 按字符计费 | 不适合图片 |

#### 方案 C：混合方案（比赛推荐）

```
┌─────────────────────────────────────────────────────────────┐
│                      混合 OCR 方案                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  图片 → 本地 manga-ocr (免费) → 文字                        │
│           ↓                                                │
│        如果失败 → 云端 OCR (备用)                           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## 三、接入真实 OCR 模型

### 3.1 安装依赖

```bash
cd manga-lens
npm install @huggingface/transformers
```

### 3.2 更新 OCR 模块

```typescript
// src/modules/ocr-engine.ts

import { pipeline, env } from '@huggingface/transformers';

export class MangaOCR {
  private ocrPipeline: any = null;
  private isInitialized = false;

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    console.log('[MangaLens] 正在下载 OCR 模型...');

    // 配置模型缓存路径
    env.cacheDir = './models';

    // 加载 manga-ocr 模型
    this.ocrPipeline = await pipeline(
      'image-to-text',
      'kha-white/manga-ocr-base',
      {
        device: 'wasm',           // 使用 WebAssembly，在浏览器运行
        progress_callback: (progress: any) => {
          if (progress.status === 'progress') {
            console.log(`[MangaLens] 下载进度: ${progress.progress.toFixed(1)}%`);
          }
        }
      }
    );

    console.log('[MangaLens] OCR 模型加载完成');
    this.isInitialized = true;
  }

  async recognize(imageElement: HTMLImageElement): Promise<OCRResult> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    // 调用模型识别
    const result = await this.ocrPipeline(imageElement);
    
    return this.parseResult(result);
  }

  private parseResult(result: any): OCRResult {
    const boxes = result.map((item: any) => ({
      x: item bbox?.x || 0,
      y: item.bbox?.y || 0,
      width: item.bbox?.width || 50,
      height: item.bbox?.height || 20,
      text: item.generated_text,
      confidence: item.score || 1,
      isVertical: (item.bbox?.height || 0) > (item.bbox?.width || 0)
    }));

    return {
      text: boxes.map((b: any) => b.text).join('\n'),
      boxes,
      confidence: boxes.reduce((sum: number, b: any) => sum + b.confidence, 0) / boxes.length
    };
  }
}
```

### 3.3 模型说明

| 模型 | 大小 | 识别效果 | 适用场景 |
|------|------|----------|----------|
| `kha-white/manga-ocr-base` | ~400MB | ⭐⭐⭐⭐⭐ | 日文漫画（推荐） |
| `kha-white/manga-ocr` | ~400MB | ⭐⭐⭐⭐ | 日文漫画 |
| `naver-clova-ix/enocr` | ~300MB | ⭐⭐⭐ | 通用文字 |

---

## 四、下一步行动计划

### 当前状态

```
✅ 翻译模块已配置（腾讯混元 API）
⏳ OCR 模块待接入真实模型
⏳ 需要测试完整流程
```

### 立即行动

#### 步骤 1：安装 OCR 依赖

```bash
cd manga-lens
npm install @huggingface/transformers
```

#### 步骤 2：更新 OCR 代码

（我刚才已经创建了框架代码）

#### 步骤 3：测试翻译功能

1. 打开 Chrome
2. 加载扩展（`chrome://extensions/` → 开发者模式 → 加载已解压 → 选择 public）
3. 访问一个漫画网站
4. 点击扩展图标，配置 API
5. 查看控制台输出

#### 步骤 4：调试和优化

1. 检查翻译是否正常工作
2. 调整覆盖层样式
3. 测试不同网站

---

## 五、OCR 模型加载优化

### 5.1 预加载模型

```typescript
// 在 popup 或 background 中预加载
async function preloadOCR() {
  const ocr = new MangaOCR();
  await ocr.initialize();
  // 缓存模型，后续使用更快
}
```

### 5.2 模型懒加载

```typescript
// 首次翻译时才加载
async function lazyLoadOCR() {
  if (!this.ocrPipeline) {
    this.ocrPipeline = await pipeline('image-to-text', 'kha-white/manga-ocr-base');
  }
}
```

### 5.3 Service Worker 缓存

```javascript
// manifest.json 中配置
"content_security_policy": {
  "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self' https://huggingface.co"
}
```

---

## 六、常见问题

### Q1: 模型下载太慢怎么办？

**解决方案**：
1. 使用国内镜像：`env.remoteHost = 'https://hf-mirror.com'`
2. 预加载到 Service Worker
3. 使用更小的模型

### Q2: 模型占用内存太大？

**解决方案**：
1. 使用 `device: 'wasm'` 而非 `webgpu`
2. 设置 `onnx: false`
3. 使用量化版本

### Q3: OCR 识别不准？

**原因**：
- 漫画图片质量差
- 文字与背景对比度低
- 特殊字体

**解决方案**：
1. 预处理图片（提高对比度）
2. 使用更专门的模型
3. 结合规则后处理

---

## 七、总结

| 组件 | 状态 | 说明 |
|------|------|------|
| 翻译 API | ✅ 已配置 | 腾讯混元，100万token免费 |
| OCR 模型 | ⏳ 框架完成 | 需要安装依赖并测试 |
| 覆盖层 | ✅ 完成 | 支持横竖排 |
| 缓存 | ✅ 完成 | 减少重复调用 |

### 立即执行

```bash
# 1. 安装依赖
cd manga-lens
npm install @huggingface/transformers

# 2. 在 Chrome 中加载扩展
# - 打开 chrome://extensions/
# - 开发者模式
# - 加载已解压的扩展程序
# - 选择 manga-lens/public

# 3. 测试翻译功能
```
