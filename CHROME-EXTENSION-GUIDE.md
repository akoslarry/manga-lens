# MangaLens Chrome 扩展加载指南

## 🚀 快速开始

### 第一步：构建项目

```bash
cd manga-lens
npm run build
```

这会在 `dist` 目录生成以下文件：
- `manifest.json` - 扩展配置
- `background.js` - 后台脚本
- `content-script.js` - 页面注入脚本
- `popup.js` - 弹窗界面

### 第二步：加载到 Chrome

1. 打开 Chrome 浏览器
2. 访问 `chrome://extensions/`
3. 开启右上角的 **"开发者模式"**
4. 点击 **"加载已解压的扩展程序"**
5. 选择项目目录中的 `dist` 文件夹

```
manga-lens/
├── dist/           ← 选择这个目录
│   ├── manifest.json
│   ├── background.js
│   ├── content-script.js
│   ├── popup.js
│   └── src/
└── src/
```

### 第三步：测试扩展

1. 点击 Chrome 工具栏右上角的扩展图标 📚
2. 填写腾讯云 API 密钥（如果还没配置）
3. 访问任意漫画网站（如 hitomi.letters）
4. 点击 "刷新页面翻译" 按钮
5. 应该能看到翻译覆盖层

## 📝 配置 API 密钥

### 获取腾讯云密钥

1. 访问 [腾讯云密钥管理](https://console.cloud.tencent.com/cam/capi)
2. 创建访问密钥（如果还没有）
3. 复制 `SecretId` 和 `SecretKey`

### 在扩展中配置

1. 点击扩展图标打开 popup
2. 填写 SecretId 和 SecretKey
3. 点击 "保存配置"
4. 点击 "测试连接" 验证配置

## 🔧 开发模式

如果你想修改代码并实时看到效果：

```bash
npm run dev
```

这会启动 Vite 的 watch 模式，修改代码后会自动重新构建。

然后在 Chrome 中：
1. 在 `chrome://extensions/` 页面
2. 点击扩展卡片上的 "刷新" 按钮 🔄
3. 重新加载页面测试

## 🐛 常见问题

### Q: 扩展图标不显示？

确保：
1. 扩展已成功加载（没有错误）
2. Chrome 开发者模式已开启
3. 点击扩展图标旁边的拼图按钮 🧩
4. 将 MangaLens 固定到工具栏

### Q: 翻译不生效？

1. 检查 API 密钥是否正确
2. 点击 "测试连接" 查看是否有错误
3. 打开浏览器控制台（F12）查看日志
4. 确保页面是漫画图片页面（非视频、文字页面）

### Q: 翻译延迟高？

- 腾讯混元 API 有 100 万 token 免费额度
- 第一次翻译会加载 OCR 模型（约 10-30 秒）
- 后续翻译会使用缓存，速度更快

### Q: 如何卸载扩展？

1. 访问 `chrome://extensions/`
2. 找到 MangaLens 扩展
3. 点击 "移除" 按钮

## 📦 项目结构说明

```
manga-lens/
├── dist/                    # 构建输出目录（加载到 Chrome）
│   ├── manifest.json        # Chrome 扩展配置
│   ├── background.js        # 后台脚本（处理 API 调用等）
│   ├── content-script.js    # 内容脚本（注入到漫画页面）
│   ├── popup.js            # 弹窗界面
│   └── src/
│       └── popup/
│           └── index.html   # 弹窗 HTML
│
├── src/                     # 源代码目录
│   ├── modules/
│   │   ├── image-detector.ts      # 图片检测模块
│   │   ├── ocr-engine.ts          # OCR 识别模块
│   │   ├── translator.ts          # 翻译模块
│   │   └── translation-overlay.ts # 覆盖层渲染
│   ├── content-script.ts          # 内容脚本入口
│   ├── background.ts              # 后台脚本入口
│   └── popup/
│       ├── index.html             # 弹窗界面
│       └── popup.js              # 弹窗逻辑
│
├── public/                   # 静态资源（扩展配置）
│   └── manifest.json
│
└── package.json
```

## 🎯 下一步

- ✅ 加载扩展
- ✅ 配置 API 密钥
- ⏳ 在漫画网站测试翻译功能
- ⏳ 根据测试结果调整 OCR 和翻译效果
- ⏳ 优化性能和用户体验

## 📚 相关资源

- [Chrome Extensions 官方文档](https://developer.chrome.com/docs/extensions/)
- [腾讯混元翻译 API 文档](https://cloud.tencent.com/document/product/1729/97731)
- [manga-ocr-base 模型](https://huggingface.co/napados/manga-ocr-base)

---

**祝你比赛顺利！** 🎉
