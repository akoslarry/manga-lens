/**
 * 腾讯云OCR云函数 - MangaLens项目
 * 
 * 使用腾讯云官方SDK处理OCR请求
 * 优点：
 * 1. 签名自动处理，无需手动实现TC3算法
 * 2. SecretKey安全存储在云端环境变量
 * 3. 维护简单，API变化时SDK自动更新
 * 
 * 部署方式：
 * 1. 将此目录压缩为 zip
 * 2. 上传到腾讯云SCF控制台
 * 3. 配置环境变量：TENCENT_SECRET_ID, TENCENT_SECRET_KEY
 * 4. 设置超时时间：建议60秒
 * 5. 设置内存：建议256MB
 * 
 * @author MangaLens Team
 * @version 1.0.0
 */

// 腾讯云SDK - 签名自动处理
const tencentcloud = require("tencentcloud-sdk-nodejs");

// 导入OCR和TEOB相关模块
const OcrClient = tencentcloud.ocr.v20181119.Client;
const { Credential } = tencentcloud.common;

exports.main_handler = async (event, context) => {
  console.log("MangaLens OCR 云函数被调用");
  console.log("请求时间:", new Date().toISOString());
  
  // CORS预检请求处理
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: ""
    };
  }
  
  try {
    // 解析请求体
    let body;
    if (typeof event.body === "string") {
      body = JSON.parse(event.body);
    } else {
      body = event.body || {};
    }
    
    const { 
      imageBase64, 
      region = "ap-guangzhou",
      action = "GeneralBasicOCR"  // 支持多种OCR类型
    } = body;
    
    // 参数验证
    if (!imageBase64) {
      return {
        statusCode: 400,
        headers: getCorsHeaders(),
        body: JSON.stringify({
          success: false,
          error: "缺少必需参数: imageBase64"
        })
      };
    }
    
    // 检查图片大小（限制10MB）
    const sizeInMB = (imageBase64.length * 3) / 4 / (1024 * 1024);
    if (sizeInMB > 10) {
      return {
        statusCode: 400,
        headers: getCorsHeaders(),
        body: JSON.stringify({
          success: false,
          error: `图片过大: ${sizeInMB.toFixed(2)}MB，最大支持10MB`
        })
      };
    }
    
    console.log(`处理OCR请求，Region: ${region}, Action: ${action}`);
    console.log(`图片大小: ${sizeInMB.toFixed(2)}MB`);
    
    // 从环境变量获取凭证（推荐方式）
    // 配置路径：函数管理 → 环境配置 → 环境变量
    const secretId = process.env.TENCENT_SECRET_ID;
    const secretKey = process.env.TENCENT_SECRET_KEY;
    
    if (!secretId || !secretKey) {
      return {
        statusCode: 500,
        headers: getCorsHeaders(),
        body: JSON.stringify({
          success: false,
          error: "云函数环境变量未配置：请在函数管理中设置 TENCENT_SECRET_ID 和 TENCENT_SECRET_KEY"
        })
      };
    }
    
    // 创建OCR客户端 - SDK自动处理签名！
    const client = new OcrClient({
      credential: {
        secretId: secretId,
        secretKey: secretKey,
      },
      region: region,
      profile: {
        httpProfile: {
          endpoint: "ocr.tencentcloudapi.com",
        },
      },
    });
    
    // 根据action选择OCR接口
    let result;
    switch (action) {
      case "GeneralBasicOCR":
        result = await client.GeneralBasicOCR({
          ImageBase64: imageBase64,
        });
        break;
      case "GeneralAccurateOCR":
        result = await client.GeneralAccurateOCR({
          ImageBase64: imageBase64,
        });
        break;
      case "EnglishOCR":
        result = await client.EnglishOCR({
          ImageBase64: imageBase64,
        });
        break;
      case "HandwritingOCR":
        result = await client.HandwritingOCR({
          ImageBase64: imageBase64,
        });
        break;
      default:
        result = await client.GeneralBasicOCR({
          ImageBase64: imageBase64,
        });
    }
    
    console.log("OCR识别成功，返回结果数:", result.TextDetections?.length || 0);
    
    // 返回结果
    return {
      statusCode: 200,
      headers: getCorsHeaders(),
      body: JSON.stringify({
        success: true,
        data: {
          // 标准化返回格式
          textDetections: result.TextDetections || [],
          requestId: result.RequestId || "",
          // 额外信息
          action: action,
          region: region,
          processedAt: new Date().toISOString()
        }
      })
    };
    
  } catch (error) {
    console.error("OCR识别失败:", error);
    
    // 解析腾讯云错误
    let errorMessage = error?.message || error?.toString() || "未知错误";
    let errorCode = error?.code || "UNKNOWN_ERROR";
    
    // 常见错误处理
    if (errorCode === "InvalidParameter" || errorCode === "InvalidParameterValue") {
      return {
        statusCode: 400,
        headers: getCorsHeaders(),
        body: JSON.stringify({
          success: false,
          error: `参数错误: ${errorMessage}`,
          code: errorCode
        })
      };
    }
    
    if (errorCode === "UnauthorizedOperation" || errorCode === "Forbidden") {
      return {
        statusCode: 403,
        headers: getCorsHeaders(),
        body: JSON.stringify({
          success: false,
          error: "没有权限访问OCR服务，请确认已开通相关服务并配置了SecretId/SecretKey",
          code: errorCode
        })
      };
    }
    
    if (errorCode === "ResourceUnavailable" || errorCode === "InternalError") {
      return {
        statusCode: 503,
        headers: getCorsHeaders(),
        body: JSON.stringify({
          success: false,
          error: "腾讯云服务暂时不可用，请稍后重试",
          code: errorCode
        })
      };
    }
    
    // 默认错误返回
    return {
      statusCode: 500,
      headers: getCorsHeaders(),
      body: JSON.stringify({
        success: false,
        error: errorMessage,
        code: errorCode
      })
    };
  }
};

/**
 * 获取CORS头信息
 */
function getCorsHeaders() {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}
