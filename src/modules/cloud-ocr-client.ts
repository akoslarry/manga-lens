/**
 * 云函数OCR客户端
 * 用于调用部署在腾讯云SCF上的OCR云函数
 * 
 * 使用方式：
 * 1. 部署 cloud-functions/tencent-ocr 到腾讯云
 * 2. 获取云函数的API网关地址
 * 3. 在扩展设置中配置API地址
 * 
 * 优点：
 * - SecretKey安全存储在云端
 * - 使用官方SDK，签名自动处理
 * - 避免前端直接调用腾讯云的各种坑
 */

export interface CloudOCRConfig {
  // 云函数API网关地址（部署后获取）
  apiUrl: string;
  // 区域（可选，默认ap-guangzhou）
  region?: string;
  // OCR类型（可选，默认GeneralBasicOCR）
  action?: 'GeneralBasicOCR' | 'GeneralAccurateOCR' | 'EnglishOCR' | 'HandwritingOCR';
  /**
   * OCR配置文件ID，用于多语言识别
   * MulOCR - 多语言识别配置，优先用于日文、韩文等非中英文场景
   * 不设置时默认中英文语境，日语识别能力较差
   */
  configId?: string;
}

export interface CloudOCRResult {
  text: string;
  items: Array<{
    DetectedText: string;
    Confidence?: number;
    Polygon?: Array<{ x: number; y: number }>;
  }>;
  requestId?: string;
}

/**
 * 调用云函数进行OCR识别
 */
export async function recognizeWithCloudOCR(
  imageBase64: string,
  config: CloudOCRConfig
): Promise<CloudOCRResult> {
  const { apiUrl, region = 'ap-guangzhou', action = 'GeneralAccurateOCR' } = config;
  
  // 移除data:image前缀
  const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
  
  console.log('[CloudOCR] 正在调用云函数...');
  console.log('[CloudOCR] API地址:', apiUrl);
  console.log('[CloudOCR] 区域:', region);
  console.log('[CloudOCR] Action:', action);
  
  const startTime = Date.now();
  
  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        "imageBase64": cleanBase64,
        "region": region,
        "action": action,
        "ConfigID": "MulOCR"  // 多语言识别配置，显著提升日语识别准确度
      })
    });
    
    const duration = Date.now() - startTime;
    console.log(`[CloudOCR] 请求完成，耗时: ${duration}ms`);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[CloudOCR] HTTP错误:', response.status, errorText);
      throw new Error(`云函数调用失败: ${response.status} - ${errorText}`);
    }
    
    const result = await response.json();
    
    if (!result.success) {
      console.error('[CloudOCR] 业务错误:', result.error, result.code);
      throw new Error(result.error || 'OCR识别失败');
    }
    
    console.log('[CloudOCR] 识别成功，返回结果数:', result.data.textDetections?.length || 0);
    
    return {
      text: result.data.textDetections?.map((item: any) => item.DetectedText).join('\n') || '',
      items: result.data.textDetections || [],
      requestId: result.data.requestId
    };
    
  } catch (error) {
    console.error('[CloudOCR] 调用失败:', error);
    throw error;
  }
}

/**
 * 测试云函数连接
 */
export async function testCloudOCRConnection(config: CloudOCRConfig): Promise<{
  success: boolean;
  message: string;
  requestId?: string;
}> {
  // 使用1x1红色像素图片作为测试
  const testImageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';
  
  try {
    const result = await recognizeWithCloudOCR(testImageBase64, config);
    return {
      success: true,
      message: `云函数连接成功！识别到 ${result.items.length} 个文字区域`,
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
 * 将云函数返回的结果转换为标准OCR结果格式
 * @param cloudResult 云函数返回的结果
 * @param sourceWidth 原图宽度（不含锚点）
 * @param sourceHeight 原图高度（不含锚点）
 * @param anchorOffset 锚点偏移量（顶部锚点区域的高度），用于校正 y 坐标
 */
export function convertCloudResultToOCRResult(
  cloudResult: CloudOCRResult,
  sourceWidth: number,
  sourceHeight: number,
  anchorOffset: number = 0
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
  // 锚点文本关键词
  const ANCHOR_KEYWORDS = [
    'この画像は横です',
    '横です',
    '画像',
    '横',
  ];
  
  /**
   * 检查文本是否为锚点文本
   */
  function isAnchorText(text: string): boolean {
    if (!text || text.trim() === '') return false;
    const trimmed = text.trim();
    if (/^[<>【】\[\]（）\(\)]+$/.test(trimmed)) {
      return true;
    }
    for (const keyword of ANCHOR_KEYWORDS) {
      if (text.includes(keyword)) {
        return true;
      }
    }
    return false;
  }
  
  // 过滤锚点文本
  const filteredItems = cloudResult.items.filter(item => {
    if (isAnchorText(item.DetectedText || '')) {
      return false;
    }
    return true;
  });
  
  const boxes = filteredItems.map((item) => {
    let x = 0, y = 0, width = 50, height = 20;
    let isVertical = false;
    
    if (item.Polygon && item.Polygon.length >= 4) {
      // 计算边界框
      const xs = item.Polygon.map(p => p.x);
      const ys = item.Polygon.map(p => p.y);
      x = Math.min(...xs);
      y = Math.min(...ys);
      width = Math.max(...xs) - x;
      height = Math.max(...ys) - y;
      
      // 判断是否竖排文字（高度大于宽度）
      isVertical = height > width;
    } else {
      // 默认位置
      x = sourceWidth * 0.1;
      y = sourceHeight * 0.4;
      width = sourceWidth * 0.8;
      height = sourceHeight * 0.1;
    }
    
    // 校正 y 坐标
    const correctedY = y - anchorOffset;
    
    return {
      x,
      y: correctedY,
      width,
      height,
      text: item.DetectedText,
      confidence: (item.Confidence || 80) / 100,
      isVertical
    };
  });
  
  // 计算平均置信度
  const avgConfidence = boxes.length > 0
    ? boxes.reduce((sum, b) => sum + b.confidence, 0) / boxes.length
    : 0.7;
  
  // 过滤纯锚点文本
  const pureText = filteredItems.map(item => item.DetectedText).join('\n').trim();
  
  return {
    text: pureText,
    boxes,
    confidence: avgConfidence
  };
}
