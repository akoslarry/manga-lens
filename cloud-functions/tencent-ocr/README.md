# MangaLens 腾讯云OCR云函数

## 概述

这是一个腾讯云Serverless云函数，用于作为MangaLens Chrome扩展的OCR识别代理。

### 为什么使用云函数？

1. **安全性**：SecretKey存储在云端，不暴露在前端代码中
2. **稳定性**：使用腾讯云官方SDK，签名自动处理，避免手动实现的各种坑
3. **易维护**：SDK自动跟随API规范更新，无需手动维护签名算法
4. **成本低**：按调用次数计费，每月有免费额度

## 快速部署

### 方式一：腾讯云控制台手动部署（推荐）

> ⚠️ **重要更新**：API网关触发器已于2024年7月停止新建，2025年6月30日完全下线。请使用**函数URL**方式！

1. 登录腾讯云控制台，进入[云函数SCF](https://console.cloud.tencent.com/scf)

2. 创建函数
   - 选择**从头开始**
   - 函数名称：`mangalens-ocr`
   - 运行时：**Node.js 16.x**
   - 地域：选择靠近用户的区域（如广州 `ap-guangzhou`）

3. 上传代码
   ```bash
   # 在 cloud-functions/tencent-ocr 目录下执行
   npm install
   # 压缩为 zip
   zip -r mangalens-ocr.zip index.js node_modules package.json
   ```
   上传 `mangalens-ocr.zip`

4. 配置环境变量
   - `TENCENT_SECRET_ID`: 你的SecretId（AKID开头）
   - `TENCENT_SECRET_KEY`: 你的SecretKey

5. 配置函数URL（替代API网关触发器）
   - 左侧菜单选择 **"函数URL"**
   - 点击 **"创建函数URL"**
   - 配置：
     - **认证方式**：选择 **"无需认证"**（因为我们自己的扩展会控制访问）
     - **公网访问**：✅ 勾选启用
   - 点击确认后，获取URL地址

6. 获取函数URL地址
   - 创建成功后，页面会显示函数URL，形如：
     ```
     https://xxxxxxxx-xxxxxxxx.ap-guangzhou.tcbas.tencentcs.com/function-identifier
     ```
   - 这个URL就是前端扩展要填写的地址

### 方式二：使用腾讯云CLI部署

```bash
# 安装腾讯云CLI
npm install -g @cloudbase/cli

# 部署
tcb fn deploy mangalens-ocr --path ./cloud-functions/tencent-ocr
```

### 方式三：使用Serverless Framework

```bash
npm install -g serverless

# 创建 serverless.yml
serverless deploy
```

### 方式四：使用COS对象存储上传（代码包过大时）

当zip包超过50MB时，需要使用COS对象存储：

1. 上传代码包到COS存储桶
2. 创建函数时选择"通过COS上传代码"
3. 选择对应的存储桶和对象路径

## 配置说明

### 环境变量

| 变量名 | 说明 | 示例 |
|--------|------|------|
| TENCENT_SECRET_ID | 腾讯云SecretId | AKIDxxxxxx |
| TENCENT_SECRET_KEY | 腾讯云SecretKey | xxxxxxxxxxx |
| TENCENT_REGION | 地域（可选，默认ap-guangzhou） | ap-shanghai |

### 函数URL格式

创建函数URL后，会获得类似以下格式的地址：

```
https://xxxxxxxx-xxxxxxxx.ap-guangzhou.tcbas.tencentcs.com/mangalens-ocr
```

> 注意：函数URL的后缀通常与函数名相关，可以在函数URL设置页面查看完整地址。

### 请求格式

```javascript
POST https://<your-function-url>.ap-guangzhou.tcbas.tencentcs.com/

Content-Type: application/json

{
  "imageBase64": "base64编码的图片数据（不含data:image前缀）",
  "region": "ap-guangzhou",     // 可选，默认ap-guangzhou
  "action": "GeneralBasicOCR"   // 可选，默认GeneralBasicOCR
}
```

### 支持的OCR类型

| action | 说明 |
|--------|------|
| GeneralBasicOCR | 通用文字识别（默认） |
| GeneralAccurateOCR | 通用文字识别（高精度版） |
| EnglishOCR | 英语识别 |
| HandwritingOCR | 手写体识别 |

### 响应格式

成功：
```json
{
  "success": true,
  "data": {
    "textDetections": [
      {
        "DetectedText": "识别的文字",
        "Confidence": 99.5,
        "Polygon": [{"x": 0, "y": 0}, ...]
      }
    ],
    "requestId": "xxx",
    "action": "GeneralBasicOCR",
    "processedAt": "2026-04-25T12:00:00.000Z"
  }
}
```

失败：
```json
{
  "success": false,
  "error": "错误描述",
  "code": "ERROR_CODE"
}
```

## 成本说明

### 腾讯云通用文字识别定价

| 每日调用量 | 单价 |
|-----------|------|
| 0 - 1000次 | 免费 |
| 1000次以上 | ¥1.5/1000次 |

### 云函数费用

| 资源 | 配置 |
|------|------|
| 内存 | 256MB |
| 超时 | 60秒 |
| 每月免费额度 | 40万GB-秒 |

### 预估成本

对于个人用户：
- 假设每天识别100张漫画 → 3000次/月
- OCR费用：约 ¥3/月（超出免费额度2000次）
- 云函数费用：约 ¥0（免费额度内）

## 常见问题

### Q: 提示 "UnauthorizedOperation"

A: 检查以下几点：
1. SecretId/SecretKey 是否正确
2. 是否开通了通用文字识别服务
3. 账户余额是否充足

### Q: 提示 "InvalidParameter"

A: 检查图片是否：
1. Base64编码正确（不含data:image前缀）
2. 大小不超过10MB

### Q: 如何本地测试？

A:
```bash
cd cloud-functions/tencent-ocr
export TENCENT_SECRET_ID=你的SecretId
export TENCENT_SECRET_KEY=你的SecretKey
npm install
npm test
```

## 后续步骤

1. 部署云函数
2. 获取API网关地址
3. 更新Chrome扩展配置（`src/config.ts`）中的API地址
4. 测试完整流程
