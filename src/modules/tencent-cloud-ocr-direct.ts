/**
 * 腾讯云 OCR API 直接调用客户端
 * 不依赖云函数，直接调用腾讯云 OCR API
 * 
 * 安全性说明：
 * - SecretId 和 SecretKey 会存储在浏览器扩展本地
 * - 不会上传到任何第三方服务器
 * - 建议仅用于个人使用，不要分发包含真实密钥的扩展
 * 
 * 签名参考: tencentcloud-sdk-nodejs/es/common/sign.js
 */

export interface TencentCloudOCRConfig {
  secretId: string;
  secretKey: string;
  region?: string;
  action?: 'GeneralBasicOCR' | 'GeneralAccurateOCR' | 'EnglishOCR' | 'HandwritingOCR';
  /**
   * OCR配置文件ID，用于多语言识别
   * MulOCR - 多语言识别配置，优先用于日文、韩文等非中英文场景
   * 不设置时默认中英文语境，日语识别能力较差
   */
  configId?: string;
}

export interface OCRItem {
  DetectedText: string;
  Confidence?: number;
  Polygon?: Array<{ x: number; y: number }>;
}

export interface TencentCloudOCRResult {
  text: string;
  items: OCRItem[];
  requestId?: string;
}

// ============================================
// TC3 签名（使用 Web Crypto API）
// ============================================

/**
 * TC3-HMAC-SHA256 签名
 * 参考腾讯云官方 SDK: tencentcloud-sdk-nodejs/es/common/sign.js
 * 
 * 注意：SDK 实现中签名的 headers 只有 content-type 和 host
 * 不包含 x-tc-action, x-tc-timestamp, x-tc-version
 */
async function signTC3(params: {
  secretId: string;
  secretKey: string;
  method: string;
  url: string;
  payload: string;
  timestamp: number;
  service: string;
}): Promise<string> {
  const { secretId, secretKey, method, url, payload, timestamp, service } = params;
  
  // 解析 URL
  const urlObj = new URL(url);
  const hostname = urlObj.hostname;
  
  // 构建 headers 字符串（SDK 只使用 content-type 和 host）
  let headersStr = `content-type:application/json\n`;
  let signedHeaders = 'content-type';
  
  headersStr += `host:${hostname}\n`;
  signedHeaders += ';host';
  
  // 计算 payload hash (使用 Web Crypto API)
  const payloadBuffer = new TextEncoder().encode(payload || '');
  const payloadHashBuffer = await crypto.subtle.digest('SHA-256', payloadBuffer);
  const payloadHash = Array.from(new Uint8Array(payloadHashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  // 构建规范请求串
  const path = urlObj.pathname || '/';
  const querystring = urlObj.search.slice(1) || '';
  
  const canonicalRequest = [
    method,
    path,
    querystring,
    headersStr,
    signedHeaders,
    payloadHash
  ].join('\n');
  
  // 计算日期
  const date = new Date(timestamp * 1000);
  const dateStr = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  
  // 构建签名字符串
  const credentialScope = `${dateStr}/${service}/tc3_request`;
  
  // 计算 Hashed Canonical Request
  const canonicalRequestBuffer = new TextEncoder().encode(canonicalRequest);
  const hashedCanonicalBuffer = await crypto.subtle.digest('SHA-256', canonicalRequestBuffer);
  const hashedCanonicalRequest = Array.from(new Uint8Array(hashedCanonicalBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  const stringToSign = [
    'TC3-HMAC-SHA256',
    timestamp.toString(),
    credentialScope,
    hashedCanonicalRequest
  ].join('\n');
  
  // 计算签名密钥
  // kDate = HMAC-SHA256("TC3" + secretKey, date)
  const kDateKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('TC3' + secretKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const kDateBuffer = await crypto.subtle.sign('HMAC', kDateKey, new TextEncoder().encode(dateStr));
  const kDate = Array.from(new Uint8Array(kDateBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  // kService = HMAC-SHA256(kDate, service)
  const kServiceKey = await crypto.subtle.importKey(
    'raw',
    hexToBytes(kDate),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const kServiceBuffer = await crypto.subtle.sign('HMAC', kServiceKey, new TextEncoder().encode(service));
  const kService = Array.from(new Uint8Array(kServiceBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  // kSigning = HMAC-SHA256(kService, "tc3_request")
  const kSigningKey = await crypto.subtle.importKey(
    'raw',
    hexToBytes(kService),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const kSigningBuffer = await crypto.subtle.sign('HMAC', kSigningKey, new TextEncoder().encode('tc3_request'));
  const kSigning = Array.from(new Uint8Array(kSigningBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  // signature = HMAC-SHA256(kSigning, stringToSign)
  const signatureKey = await crypto.subtle.importKey(
    'raw',
    hexToBytes(kSigning),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign('HMAC', signatureKey, new TextEncoder().encode(stringToSign));
  const signature = Array.from(new Uint8Array(signatureBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  
  // 构建 Authorization 头
  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  
  return authorization;
}

/**
 * 将十六进制字符串转换为 Uint8Array
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

/**
 * 直接调用腾讯云 OCR API
 */
export async function recognizeWithTencentCloudAPI(
  imageBase64: string,
  config: TencentCloudOCRConfig
): Promise<TencentCloudOCRResult> {
  const {
    secretId,
    secretKey,
    region = 'ap-guangzhou',
    action = 'GeneralAccurateOCR'
  } = config;
  
  // 移除 data:image 前缀
  const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
  
  console.log('[TencentCloudOCR] 正在调用腾讯云 OCR API...');
  console.log('[TencentCloudOCR] 区域:', region);
  console.log('[TencentCloudOCR] Action:', action);
  
  const timestamp = Math.floor(Date.now() / 1000);
  const host = 'ocr.tencentcloudapi.com';
  const version = '2018-11-19';
  const url = `https://${host}/`;
  
  // 构建请求体 - 包含必要字段和多语言配置
  // ConfigId=MulOCR 启用多语言识别模式，显著提升日语识别准确度
  // 注意：腾讯云 OCR API 的多语言识别配置使用 ConfigId 参数
  const payload = JSON.stringify({
    "ImageBase64": cleanBase64,
    "ConfigID": "MulOCR"
  });
  
  // 计算签名（使用 SDK 兼容的签名逻辑）
  const authorization = await signTC3({
    secretId,
    secretKey,
    method: 'POST',
    url,
    payload,
    timestamp,
    service: 'ocr'
  });
  
  console.log('[TencentCloudOCR] Authorization header built');
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Host': host,
        'X-TC-Action': action,
        'X-TC-Version': version,
        'X-TC-Timestamp': timestamp.toString(),
        'X-TC-Region': region,
        'Authorization': authorization
      },
      body: payload
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[TencentCloudOCR] HTTP错误:', response.status, errorText);
      throw new Error(`OCR API调用失败: ${response.status} - ${errorText}`);
    }
    
    const result = await response.json();
    
    // 解析腾讯云标准响应格式
    if (result.Response && result.Response.Error) {
      const error = result.Response.Error;
      console.error('[TencentCloudOCR] API错误:', error.Code, error.Message);
      throw new Error(`${error.Code}: ${error.Message}`);
    }
    
    const ocrData = result.Response;
    const textDetections = ocrData.TextDetections || [];
    
    console.log('[TencentCloudOCR] 识别成功，返回结果数:', textDetections.length);
    
    return {
      text: textDetections.map((item: any) => item.DetectedText).join('\n') || '',
      items: textDetections,
      requestId: ocrData.RequestId
    };
    
  } catch (error) {
    console.error('[TencentCloudOCR] 调用失败:', error);
    throw error;
  }
}

/**
 * 测试腾讯云 OCR API 连接
 * 注意：由于 CORS 限制，此函数需要在 background script 中调用
 */
export async function testTencentCloudOCRConnection(
  config: TencentCloudOCRConfig
): Promise<{
  success: boolean;
  message: string;
  requestId?: string;
}> {
  // 使用1x1红色像素图片测试
  const testImageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';
  
  try {
    const result = await recognizeWithTencentCloudAPI(testImageBase64, config);
    return {
      success: true,
      message: `腾讯云 OCR 连接成功！识别到 ${result.items.length} 个文字区域`,
      requestId: result.requestId
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : '连接测试失败'
    };
  }
}

/**
 * 转换为标准 OCR 结果格式
 * @param cloudResult 腾讯云 OCR 返回的结果
 * @param sourceWidth 原图宽度（不含锚点）
 * @param sourceHeight 原图高度（不含锚点）
 * @param anchorOffset 锚点偏移量（顶部锚点区域的高度），用于校正 y 坐标
 */
export function convertToOCRResult(
  cloudResult: TencentCloudOCRResult,
  sourceWidth: number,
  sourceHeight: number,
  anchorOffset: number = 0  // 顶部锚点区域的高度
): {
  text: string;
  boxes: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
    confidence: number;
    isVertical: boolean;
  }>;
  confidence: number;
} {
  // 锚点文本关键词（用于诱导 OCR 方向，会被过滤掉）
  // 包含完整锚点和可能被分词识别的情况
  const ANCHOR_KEYWORDS = [
    'この画像は横です',  // 核心关键词
    '横です',           // 部分匹配
    '画像',             // 日语"图片"
    '横',               // "横"
  ];
  
  /**
   * 检查文本是否为锚点文本（需要过滤）
   */
  function isAnchorText(text: string): boolean {
    if (!text || text.trim() === '') return false;
    
    // 检查是否是孤立的符号
    const trimmed = text.trim();
    if (/^[<>【】\[\]（）\(\)]+$/.test(trimmed)) {
      return true; // 单独的括号符号
    }
    
    // 检查是否包含锚点关键词
    for (const keyword of ANCHOR_KEYWORDS) {
      if (text.includes(keyword)) {
        return true;
      }
    }
    
    return false;
  }
  
  // 过滤掉锚点文本
  const filteredItems = cloudResult.items.filter(item => {
    const text = item.DetectedText || '';
    if (isAnchorText(text)) {
      return false;
    }
    return true;
  });
  
  const boxes = filteredItems.map((item) => {
    let x = 0, y = 0, width = 50, height = 20;
    let isVertical = false;
    
    // 优先使用 ItemPolygon（更可靠）
    if (item.ItemPolygon) {
      x = item.ItemPolygon.X || item.ItemPolygon.x || 0;
      y = item.ItemPolygon.Y || item.ItemPolygon.y || 0;
      width = item.ItemPolygon.Width || item.ItemPolygon.width || 50;
      height = item.ItemPolygon.Height || item.ItemPolygon.height || 20;
      isVertical = height > width;
    } 
    // 其次使用 Polygon（四边形顶点）
    else if (item.Polygon && item.Polygon.length >= 4) {
      const xs = item.Polygon.map(p => p.X || p.x);
      const ys = item.Polygon.map(p => p.Y || p.y);
      x = Math.min(...xs);
      y = Math.min(...ys);
      width = Math.max(...xs) - x;
      height = Math.max(...ys) - y;
      isVertical = height > width;
    }
    else {
      x = sourceWidth * 0.1;
      y = sourceHeight * 0.4;
      width = sourceWidth * 0.8;
      height = sourceHeight * 0.1;
    }
    
    // 【关键修复】校正 y 坐标：由于原图向下偏移了 anchorOffset，
    // OCR 返回的 y 坐标需要减去这个偏移量才能对应原图的真实位置
    const correctedY = y - anchorOffset;
    
    return {
      x,
      y: correctedY,  // 使用校正后的 y 坐标
      width,
      height,
      text: item.DetectedText,
      confidence: (item.Confidence || 80) / 100,
      isVertical
    };
  });
  
  const avgConfidence = boxes.length > 0
    ? boxes.reduce((sum, b) => sum + b.confidence, 0) / boxes.length
    : 0.7;
  
  // 过滤纯锚点文本，生成纯文本内容
  const pureText = filteredItems.map(item => item.DetectedText).join('\n').trim();
  
  return {
    text: pureText,
    boxes,
    confidence: avgConfidence
  };
}
