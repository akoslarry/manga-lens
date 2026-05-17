/**
 * 本地测试脚本
 * 用于在部署前测试云函数逻辑
 */

const tencentcloud = require("tencentcloud-sdk-nodejs");
const OcrClient = tencentcloud.ocr.v20181119.Client;
const { Credential } = tencentcloud.common;

async function testOCR() {
  // 从环境变量或直接配置获取凭证
  const secretId = process.env.TENCENT_SECRET_ID || "YOUR_SECRET_ID";
  const secretKey = process.env.TENCENT_SECRET_KEY || "YOUR_SECRET_KEY";
  const region = process.env.TENCENT_REGION || "ap-guangzhou";

  // 测试图片（1x1红色像素）
  const testImageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";

  console.log("=".repeat(60));
  console.log("MangaLens OCR 云函数本地测试");
  console.log("=".repeat(60));
  console.log("Region:", region);
  console.log("SecretId:", secretId.substring(0, 10) + "***");
  console.log("");

  try {
    console.log("正在连接腾讯云OCR...");

    const client = new OcrClient({
      credential: new Credential(secretId, secretKey),
      region: region,
      profile: {
        httpProfile: {
          endpoint: "ocr.tencentcloudapi.com",
        },
      },
    });

    console.log("发送OCR请求...");
    const startTime = Date.now();

    const result = await client.GeneralBasicOCR({
      ImageBase64: testImageBase64,
    });

    const duration = Date.now() - startTime;

    console.log("");
    console.log("✅ OCR识别成功!");
    console.log("耗时:", duration + "ms");
    console.log("识别结果数:", result.TextDetections?.length || 0);
    console.log("RequestId:", result.RequestId);
    console.log("");
    console.log("详细结果:");
    console.log(JSON.stringify(result, null, 2));

  } catch (error) {
    console.error("");
    console.error("❌ OCR识别失败!");
    console.error("错误码:", error.code);
    console.error("错误信息:", error.message);
    console.error("请求ID:", error.requestId);

    // 提供解决建议
    if (error.code === "UnauthorizedOperation") {
      console.error("");
      console.error("💡 可能的原因:");
      console.error("   1. SecretId 或 SecretKey 错误");
      console.error("   2. 未开通通用文字识别服务");
      console.error("   3. 账户余额不足");
    }

    if (error.code === "InvalidParameter") {
      console.error("");
      console.error("💡 可能的原因:");
      console.error("   1. 图片格式不正确");
      console.error("   2. 图片Base64编码错误");
    }
  }

  console.log("");
  console.log("=".repeat(60));
}

// 运行测试
testOCR();
