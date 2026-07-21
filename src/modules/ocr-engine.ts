/**
 * OCR 识别模块
 * 
 * 支持两种OCR模式：
 * 1. 云函数模式：调用腾讯云OCR云函数
 * 2. 直接API模式：直接调用腾讯云OCR API（使用TC3签名）
 */

import CryptoJS from 'crypto-js';
import { 
  recognizeWithCloudOCR, 
  convertCloudResultToOCRResult,
  testCloudOCRConnection,
  CloudOCRConfig
} from './cloud-ocr-client';

import {
  convertToOCRResult,
  TencentCloudOCRConfig,
  TencentCloudOCRResult
} from './tencent-cloud-ocr-direct';

import {
  mergeDialogs,
  DialogMerger,
  OCRTextItem,
  MergedDialog,
  DialogMergerConfig
} from './dialog-merger';

import {
  BatchTranslator,
  batchTranslate,
  BatchTranslationResult,
  DialogTranslationItem
} from './batch-translator';

export interface OCRResult {
  text: string;
  boxes: BoundingBox[];
  confidence: number;
  /** 检测到的旋转角度（0, 90, 180, 270） */
  rotationAngle?: number;
  /** 是否检测到旋转 */
  hasRotation?: boolean;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  confidence: number;
  isVertical: boolean;
}

/**
 * 锚点标记（支持四角 + 中间位置）
 */
export interface AnchorMarker {
  id: number;      // 锚点编号 1-8
  x: number;       // x 坐标
  y: number;       // y 坐标
  text: string;    // 显示文本
  type: 'corner' | 'mid';  // 锚点类型：corner=角，mid=中间
}

// 保持向后兼容
export type CornerMarker = AnchorMarker;

/**
 * 旋转检测结果
 */
export interface RotationResult {
  /** 是否检测到旋转 */
  hasRotation: boolean;
  /** 旋转角度（0, 90, 180, 270） */
  rotationAngle: number;
  /** 检测到的角位置映射（OCR识别的角 → 原图角） */
  cornerMapping: Map<number, number>;
  /** 原始角位置 */
  detectedCorners: CornerMarker[];
  /** 预期角位置 */
  expectedCorners: CornerMarker[];
}

/**
 * 坐标转换结果
 */
export interface CoordinateTransform {
  /** 转换后的 x 坐标 */
  x: number;
  /** 转换后的 y 坐标 */
  y: number;
}

// 扩展配置接口
interface ExtensionConfig {
  ocr: {
    provider: 'cloud' | 'direct';
    cloudFunctionUrl?: string;
    region?: string;
    action?: string;
    tencentSecretId?: string;
    tencentSecretKey?: string;
  };
  translation: {
    provider: 'deepseek' | 'tencent' | 'mymemory';
    deepseekApiKey?: string;
    deepseekEndpoint?: string;
    deepseekModel?: string;
  };
}

/** 完整翻译流程的结果 */
export interface RecognitionTranslationResult {
  /** 合并后的对话列表（含气泡边界） */
  dialogs: MergedDialog[];
  /** 翻译结果 */
  translation: {
    successCount: number;
    failureCount: number;
    items: DialogTranslationItem[];
  };
  /** 原始 OCR 结果 */
  rawResult: OCRResult;
  /** 图片尺寸 */
  imageSize: { width: number; height: number };
}

// ============================================
// 腾讯云 TC3 签名（使用 crypto-js，可在 content-script 中运行）
// ============================================

/**
 * 计算 TC3-HMAC-SHA256 签名
 * 按照腾讯云官方 Node.js SDK 实现
 */
function calculateTC3Signature(
  secretId: string,
  secretKey: string,
  payload: string,
  timestamp: number,
  action: string
): string {
  const date = new Date(timestamp * 1000).toISOString().split('T')[0];
  
  // Canonical Request
  const httpRequestMethod = 'POST';
  const canonicalUri = '/';
  const canonicalQueryString = '';
  
  // Canonical Headers - 按字母顺序排列（所有参与签名的 header）
  // 必须包含：content-type, host, x-tc-action, x-tc-timestamp, x-tc-version
  const canonicalHeaders = [
    `content-type:application/json`,
    `host:ocr.tencentcloudapi.com`,
    `x-tc-action:${action.toLowerCase()}`,
    `x-tc-timestamp:${timestamp}`,
    `x-tc-version:2018-11-19`
  ].sort((a, b) => a.split(':')[0].localeCompare(b.split(':')[0])).join('\n') + '\n';
  
  const signedHeaders = 'content-type;host;x-tc-action;x-tc-timestamp;x-tc-version';
  
  const hashedPayload = CryptoJS.SHA256(payload).toString();
  
  const canonicalRequest = [
    httpRequestMethod,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    hashedPayload
  ].join('\n');
  
  const hashedCanonicalRequest = CryptoJS.SHA256(canonicalRequest).toString();
  
  // StringToSign - 按照腾讯云标准格式
  const credentialScope = `${date}/ocr/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256',
    timestamp.toString(),
    credentialScope,
    hashedCanonicalRequest
  ].join('\n');
  
  // TC3 签名算法（按照腾讯云官方 SDK）
  // ⚠️ 关键：必须使用 "TC3" + secretKey 作为第一个 HMAC 的密钥
  // 1. 先用 "TC3" + SecretKey 对 date 进行 HMAC
  const kDate = CryptoJS.HmacSHA256("TC3" + secretKey, date);
  // 2. 用 kDate 对 'ocr' 进行 HMAC
  const kService = CryptoJS.HmacSHA256(kDate, 'ocr');
  // 3. 用 kService 对 'tc3_request' 进行 HMAC
  const kSigning = CryptoJS.HmacSHA256(kService, 'tc3_request');
  // 4. 用 kSigning 对 stringToSign 进行 HMAC 得到最终签名
  const signature = CryptoJS.HmacSHA256(stringToSign, kSigning).toString();

  console.log('[OCR] === TC3 签名调试 ===');
  console.log('[OCR] SecretId:', secretId);
  console.log('[OCR] Timestamp:', timestamp);
  console.log('[OCR] Date (UTC):', date);
  console.log('[OCR] CredentialScope:', credentialScope);
  console.log('[OCR] HashedPayload:', hashedPayload);
  console.log('[OCR] CanonicalRequest:', JSON.stringify(canonicalRequest));
  console.log('[OCR] HashedCanonicalRequest:', hashedCanonicalRequest);
  console.log('[OCR] StringToSign:', JSON.stringify(stringToSign));
  console.log('[OCR] kDate:', kDate.toString());
  console.log('[OCR] kService:', kService.toString());
  console.log('[OCR] kSigning:', kSigning.toString());
  console.log('[OCR] Signature:', signature);
  
  return signature;
}

/**
 * 直接调用腾讯云 OCR API（不通过 background script）
 */
async function callTencentCloudOCRDirect(
  imageBase64: string,
  config: TencentCloudOCRConfig
): Promise<TencentCloudOCRResult> {
  const { secretId, secretKey, region = 'ap-guangzhou', action = 'GeneralAccurateOCR' } = config;
  const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');
  
  console.log('[OCR] 调用腾讯云 OCR API...');
  console.log('[OCR] SecretId:', secretId.substring(0, 8) + '...');
  console.log('[OCR] Region:', region);
  console.log('[OCR] Action:', action);
  
  const timestamp = Math.floor(Date.now() / 1000);
  const host = 'ocr.tencentcloudapi.com';
  const version = '2018-11-19';
  const endpoint = `https://${host}`;
  
  const payload = JSON.stringify({
    ImageBase64: cleanBase64,
    ConfigID: "MulOCR"  // 多语言识别配置，显著提升日语识别准确度
  });
  
  // 计算 TC3 签名（只传递 action，不传 region）
  const signature = calculateTC3Signature(secretId, secretKey, payload, timestamp, action);
  
  // 构建 Authorization 头 - 按照腾讯云标准格式
  const date = new Date(timestamp * 1000).toISOString().split('T')[0];
  const credentialScope = `${date}/ocr/tc3_request`;
  const credential = `${secretId}/${credentialScope}`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const authorization = `TC3-HMAC-SHA256 Credential=${credential}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  
  console.log('[OCR] Authorization header built');
  console.log('[OCR] Credential:', credential);
  
  const response = await fetch(endpoint, {
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
    console.error('[OCR] HTTP Error:', response.status, errorText);
    throw new Error(`OCR API调用失败: ${response.status} - ${errorText}`);
  }
  
  const result = await response.json();
  
  if (result.Response && result.Response.Error) {
    const error = result.Response.Error;
    console.error('[OCR] API Error:', error.Code, error.Message);
    throw new Error(`${error.Code}: ${error.Message}`);
  }
  
  const ocrData = result.Response;
  const textDetections = ocrData.TextDetections || [];
  
  console.log('[OCR] OCR识别成功，返回', textDetections.length, '个文字区域');
  
  return {
    text: textDetections.map((item: any) => item.DetectedText).join('\n') || '',
    items: textDetections,
    requestId: ocrData.RequestId
  };
}

/**
 * 测试腾讯云 OCR 连接（直接调用）
 */
async function testTencentCloudOCRConnectionDirect(
  config: TencentCloudOCRConfig
): Promise<{ success: boolean; message: string; requestId?: string }> {
  try {
    // 使用1x1红色像素图片测试
    const testImageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';
    const result = await callTencentCloudOCRDirect(testImageBase64, config);
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
 * 从 chrome.storage.local 获取扩展配置
 */
async function getExtensionConfig(): Promise<ExtensionConfig> {
  return new Promise((resolve) => {
    chrome.storage.local.get([
      'ocrMode', 'cloudFunctionUrl', 'ocrRegion', 'ocrAction',
      'tencentSecretId', 'tencentSecretKey', 'directRegion', 'directAction'
    ], (result) => {
      const config: ExtensionConfig = {
        ocr: {
          provider: (result.ocrMode as 'cloud' | 'direct') || 'direct',
          cloudFunctionUrl: result.cloudFunctionUrl || '',
          region: result.directRegion || result.ocrRegion || 'ap-guangzhou',
          action: result.directAction || result.ocrAction || 'GeneralAccurateOCR',
          tencentSecretId: result.tencentSecretId || '',
          tencentSecretKey: result.tencentSecretKey || ''
        }
      };
      console.log('[MangaLens] 从 chrome.storage 加载 OCR 配置:', config.ocr.provider);
      resolve(config);
    });
  });
}

/**
 * 保存扩展配置到 chrome.storage.local
 */
async function saveExtensionConfig(config: ExtensionConfig): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({
      ocrMode: config.ocr.provider,
      cloudFunctionUrl: config.ocr.cloudFunctionUrl,
      directRegion: config.ocr.region,
      directAction: config.ocr.action,
      tencentSecretId: config.ocr.tencentSecretId,
      tencentSecretKey: config.ocr.tencentSecretKey
    }, () => {
      console.log('[MangaLens] 配置已保存到 chrome.storage');
      resolve();
    });
  });
}

export class MangaOCR {
  private isInitialized = false;
  private config: ExtensionConfig | null = null;
  private cloudConfig: CloudOCRConfig | null = null;
  private directConfig: TencentCloudOCRConfig | null = null;

  /**
   * 加载配置（异步）
   */
  private async loadConfig(): Promise<void> {
    if (this.config) return;
    this.config = await getExtensionConfig();
    
    if (this.config.ocr.provider === 'cloud' && this.config.ocr.cloudFunctionUrl) {
      this.cloudConfig = {
        apiUrl: this.config.ocr.cloudFunctionUrl,
        region: this.config.ocr.region || 'ap-guangzhou',
        action: (this.config.ocr.action as any) || 'GeneralAccurateOCR'
      };
    } else if (this.config.ocr.provider === 'direct' && 
               this.config.ocr.tencentSecretId && 
               this.config.ocr.tencentSecretKey) {
      this.directConfig = {
        secretId: this.config.ocr.tencentSecretId,
        secretKey: this.config.ocr.tencentSecretKey,
        region: this.config.ocr.region || 'ap-guangzhou',
        action: (this.config.ocr.action as any) || 'GeneralAccurateOCR'
      };
    }
  }

  /**
   * 初始化 OCR 模块
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    console.log('[MangaLens] OCR 模块初始化...');
    
    await this.loadConfig();
    
    console.log('[MangaLens] OCR模式:', this.config?.ocr.provider || 'unknown');
    
    if (this.config.ocr.provider === 'cloud') {
      if (this.config.ocr.cloudFunctionUrl) {
        console.log('[MangaLens] 云函数地址:', this.config.ocr.cloudFunctionUrl);
        try {
          const testResult = await testCloudOCRConnection(this.cloudConfig!);
          if (testResult.success) {
            console.log('[MangaLens] 云函数连接测试成功');
          } else {
            console.warn('[MangaLens] 云函数连接测试失败:', testResult.message);
          }
        } catch (e) {
          console.warn('[MangaLens] 云函数连接测试异常:', e);
        }
      }
    } else if (this.config.ocr.provider === 'direct') {
      if (this.config.ocr.tencentSecretId && this.config.ocr.tencentSecretKey) {
        console.log('[MangaLens] 直接API模式，使用腾讯云 OCR');
        console.log('[MangaLens] SecretId:', this.config.ocr.tencentSecretId.substring(0, 8) + '...');
        // 测试连接（通过 background script 避免 CORS）
        try {
          const testResult = await this.testConnectionViaBackground(this.directConfig!);
          if (testResult.success) {
            console.log('[MangaLens] 直接API连接测试成功');
          } else {
            console.warn('[MangaLens] 直接API连接测试失败:', testResult.message);
          }
        } catch (e) {
          console.warn('[MangaLens] 直接API连接测试异常:', e);
        }
      }
    }

    this.isInitialized = true;
    console.log('[MangaLens] OCR 模块初始化完成');
  }

  /**
   * 识别图片中的文字
   * 
   * 双重保险流程：
   * 1. 优先使用 Base64 模式：通过 Background Fetch 获取图片，然后调用 OCR
   * 2. 回退使用 ImageUrl 模式：腾讯云服务器端直接获取图片
   */
  async recognize(imageElement: HTMLImageElement): Promise<OCRResult> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    if (!this.config) {
      await this.loadConfig();
    }

    // 获取图片 URL 和页面 URL
    const imageSrc = imageElement.src || imageElement.currentSrc;
    const pageUrl = window.location.href;
    console.log('[MangaLens] 准备识别图片:', imageSrc);

    // 检查是否配置了直接 API
    if (!this.directConfig) {
      throw new Error('未配置腾讯云 OCR API，请先在设置中配置');
    }

    // ========== 第一步：尝试 Base64 模式 ==========
    console.log('[MangaLens] 步骤1: 尝试 Base64 模式 (Background Fetch + OCR)...');
    
    try {
      const base64Result = await this.recognizeWithBase64Mode(imageElement, imageSrc, pageUrl);
      console.log('[MangaLens] ✓ Base64 模式成功！');
      return base64Result;
    } catch (base64Error) {
      console.warn('[MangaLens] ✗ Base64 模式失败:', base64Error);
      console.log('[MangaLens] 步骤2: 回退到 ImageUrl 模式...');
    }
    
    // ========== 第二步：回退到 ImageUrl 模式 ==========
    console.log('[MangaLens] 使用 ImageUrl 模式进行 OCR...');
    
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          target: 'background',
          type: 'DIRECT_OCR_RECOGNIZE_URL',
          imageUrl: imageSrc,
          secretId: this.directConfig!.secretId,
          secretKey: this.directConfig!.secretKey,
          region: this.directConfig!.region || 'ap-guangzhou',
          action: this.directConfig!.action || 'GeneralBasicOCR'
        },
        (response) => {
          if (response && response.success) {
            console.log('[MangaLens] ImageUrl OCR 成功，返回', response.items?.length || 0, '个文字区域');
            
            // 使用 convertToOCRResult 转换结果（保留锚点文本过滤等功能）
            const imageWidth = imageElement.naturalWidth || imageElement.width;
            const imageHeight = imageElement.naturalHeight || imageElement.height;
            const ocrResult = convertToOCRResult(
              {
                text: response.text || '',
                items: response.items || [],
                requestId: response.requestId
              },
              imageWidth,
              imageHeight,
              0  // ImageUrl 模式无锚点偏移
            );
            
            resolve(ocrResult);
          } else {
            console.error('[MangaLens] ImageUrl OCR 失败:', response?.message);
            reject(new Error(response?.message || 'OCR 识别失败'));
          }
        }
      );
    });
  }

  /**
   * Base64 模式 OCR
   * 流程：
   * 1. 通过 Background Fetch 获取图片（带防盗链处理）
   * 2. 添加锚点到图片
   * 3. 发送带锚点的图片到 OCR
   * 4. 处理锚点检测和坐标转换
   */
  private recognizeWithBase64Mode(
    imageElement: HTMLImageElement,
    imageUrl: string,
    pageUrl: string
  ): Promise<OCRResult> {
    return new Promise((resolve, reject) => {
      // 第一步：通过 background 获取图片 Base64
      chrome.runtime.sendMessage(
        {
          target: 'background',
          type: 'FETCH_IMAGE_AS_BASE64',
          imageUrl: imageUrl,
          pageUrl: pageUrl
        },
        async (response) => {
          if (!response || !response.success) {
            console.error('[MangaLens] Base64 模式：图片获取失败');
            reject(new Error(response?.message || '图片获取失败'));
            return;
          }
          
          try {
            // 第二步：将 Base64 转换为 Image 对象
            const img = new Image();
            await new Promise<void>((res, rej) => {
              img.onload = () => res();
              img.onerror = () => rej(new Error('图片加载失败'));
              img.src = response.base64;
            });
            
            // 第三步：添加锚点到图片
            const anchorResult = this.addDirectionAnchorTextToImage(img);
            
            // 第四步：发送带锚点的图片到 OCR
            const ocrResponse = await new Promise<any>((res, rej) => {
              chrome.runtime.sendMessage(
                {
                  target: 'background',
                  type: 'DIRECT_OCR_RECOGNIZE',
                  imageBase64: anchorResult.base64WithAnchor,
                  secretId: this.directConfig!.secretId,
                  secretKey: this.directConfig!.secretKey,
                  region: this.directConfig!.region || 'ap-guangzhou',
                  action: this.directConfig!.action || 'GeneralBasicOCR'
                },
                (resp) => {
                  if (resp && resp.success) {
                    res(resp);
                  } else {
                    rej(new Error(resp?.message || 'OCR识别失败'));
                  }
                }
              );
            });
            
            console.log(`[MangaLens] Base64 OCR 返回了 ${ocrResponse.items?.length || 0} 个识别项`);
            
            // 第五步：处理锚点检测和坐标转换（使用 recognizeWithDirectAPIForAnchor 的逻辑）
            const ocrResult = await this.processOCRWithAnchor(
              ocrResponse,
              anchorResult.originalWidth,
              anchorResult.originalHeight,
              anchorResult.cornerMarkers
            );
            
            console.log(`[MangaLens] ✓ Base64 模式完成，检测到 ${ocrResult.boxes.length} 个文字区域`);
            resolve(ocrResult);
            
          } catch (error) {
            console.error('[MangaLens] Base64 OCR 处理失败:', error);
            reject(error);
          }
        }
      );
    });
  }
  
  /**
   * 处理带锚点的 OCR 结果
   * 包含锚点检测、旋转检测、坐标转换等完整流程
   */
  private async processOCRWithAnchor(
    ocrResponse: any,
    originalWidth: number,
    originalHeight: number,
    expectedCorners: CornerMarker[]
  ): Promise<OCRResult> {
    // 步骤1: 识别四角锚点
    const detectedCorners = this.detectCornerMarkers(ocrResponse.items || [], expectedCorners);
    
    // 步骤2: 检测旋转
    const rotationResult = this.detectRotation(detectedCorners, expectedCorners, originalWidth, originalHeight);
    
    // 步骤3: 过滤角标记文本
    const filteredItems = this.filterCornerMarkers(ocrResponse.items || []);
    
    // 步骤4: 过滤无意义文本
    const noiseFilteredItems = this.filterNoiseText(filteredItems);
    
    // 步骤5: 坐标转换
    const transformedBoxes = this.transformCoordinates(
      noiseFilteredItems,
      rotationResult,
      originalWidth,
      originalHeight
    );
    
    return {
      text: transformedBoxes.map(b => b.text).join('\n'),
      boxes: transformedBoxes,
      confidence: 0.8,
      rotationAngle: rotationResult.rotationAngle,
      hasRotation: rotationResult.hasRotation
    };
  }

  /**
   * 【修改】通过 background 添加四角锚点
   * 由于 content-script 中的 canvas 可能被跨域图片污染，
   * 所以需要将图片转回 Image 对象再绘制
   */
  private async addAnchorViaBackground(
    base64Image: string
  ): Promise<{
    base64WithAnchor: string;
    originalWidth: number;
    originalHeight: number;
    cornerMarkers: CornerMarker[];
  }> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const result = this.addDirectionAnchorTextToImage(img);
          resolve(result);
        } catch (e) {
          reject(e);
        }
      };
      img.onerror = (e) => {
        reject(new Error('图片加载失败'));
      };
      // 移除 data:image 前缀，因为 new Image() 需要完整的 data URL
      img.src = base64Image;
    });
  }

  /**
   * 【新版】将四角锚点添加到图片
   * 使用circled numbers ①②③④作为角标记，便于OCR识别
   * 
   * 角位置设计（保持原图尺寸）：
   *  ① ────────────── ②
   *  │                 │
   *  │    原图内容      │
   *  │                 │
   *  ④ ────────────── ③
   * 
   * @returns 包含带锚点图片和四个角预期位置的元组
   */
  private addDirectionAnchorTextToImage(
    img: HTMLImageElement
  ): { 
    base64WithAnchor: string; 
    originalWidth: number; 
    originalHeight: number; 
    cornerMarkers: CornerMarker[];
  } {
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    
    // 锚点标记大小（确保 OCR 能识别）
    const markerSize = Math.max(50, Math.floor(width * 0.06));
    const fontSize = markerSize * 0.8;
    
    // 锚点距边缘的距离
    const margin = markerSize * 0.8;
    
    // 定义所有锚点位置（8个锚点：四角 + 四边中点）
    // 锚点 ID: 1-4 为四角，5-8 为中间锚点
    const allMarkers: AnchorMarker[] = [
      { id: 1, x: margin, y: margin, text: '左上', type: 'corner' },           // 左上
      { id: 2, x: width - margin, y: margin, text: '右上', type: 'corner' },   // 右上
      { id: 3, x: width - margin, y: height - margin, text: '右下', type: 'corner' }, // 右下
      { id: 4, x: margin, y: height - margin, text: '左下', type: 'corner' },  // 左下
      { id: 5, x: width / 2, y: margin, text: '上中', type: 'mid' },           // 上中
      { id: 6, x: width / 2, y: height - margin, text: '下中', type: 'mid' },  // 下中
      { id: 7, x: margin, y: height / 2, text: '左中', type: 'mid' },           // 左中
      { id: 8, x: width - margin, y: height / 2, text: '右中', type: 'mid' },  // 右中
    ];
    
    // 创建 canvas（保持原图尺寸）
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    
    if (!ctx) {
      throw new Error('无法创建 Canvas 上下文');
    }
    
    // 绘制原图
    ctx.drawImage(img, 0, 0);
    
    // 绘制所有锚点标记
    this.drawAllMarkers(ctx, allMarkers, markerSize, fontSize);
    
    // 生成 DataURL（JPEG 压缩以控制在 10MB 以内，质量 0.85 对锚点文字无实质影响）
    const base64WithAnchor = canvas.toDataURL('image/jpeg', 0.85);
    
    return {
      base64WithAnchor,
      originalWidth: width,
      originalHeight: height,
      cornerMarkers: allMarkers
    };
  }
  
  /**
   * 绘制所有锚点标记（角 + 中间位置）
   */
  private drawAllMarkers(
    ctx: CanvasRenderingContext2D,
    markers: AnchorMarker[],
    markerSize: number,
    fontSize: number
  ): void {
    markers.forEach((marker) => {
      const text = marker.text;
      
      // 测量文本尺寸
      ctx.font = `bold ${fontSize}px "Microsoft YaHei", "SimHei", "Arial Unicode MS", sans-serif`;
      const metrics = ctx.measureText(text);
      const textWidth = metrics.width;
      const textHeight = fontSize;
      
      // 背景块尺寸（根据文本大小动态调整）
      const padding = fontSize * 0.4;
      const bgWidth = textWidth + padding * 2;
      const bgHeight = textHeight + padding * 2;
      const bgX = marker.x - bgWidth / 2;
      const bgY = marker.y - bgHeight / 2;
      
      // 根据类型选择样式（角锚点用圆形背景，中间锚点用方形）
      if (marker.type === 'corner') {
        // 角锚点：黑色外框 + 白色背景
        ctx.fillStyle = '#000000';
        ctx.fillRect(bgX - 3, bgY - 3, bgWidth + 6, bgHeight + 6);
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(bgX, bgY, bgWidth, bgHeight);
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 3;
        ctx.strokeRect(bgX, bgY, bgWidth, bgHeight);
      } else {
        // 中间锚点：灰色背景 + 黑色边框（区分于角锚点）
        ctx.fillStyle = '#333333';
        ctx.fillRect(bgX - 2, bgY - 2, bgWidth + 4, bgHeight + 4);
        ctx.fillStyle = '#E0E0E0';
        ctx.fillRect(bgX, bgY, bgWidth, bgHeight);
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 2;
        ctx.strokeRect(bgX, bgY, bgWidth, bgHeight);
      }
      
      // 绘制锚点文本
      ctx.fillStyle = '#000000';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      
      // 白色描边使文字更突出
      ctx.shadowColor = marker.type === 'corner' ? '#FFFFFF' : '#FFFFFF';
      ctx.shadowBlur = 2;
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2;
      ctx.strokeText(text, marker.x, marker.y);
      ctx.fillText(text, marker.x, marker.y);
      ctx.shadowBlur = 0;
    });
  }

  /**
   * 从OCR识别结果中检测四角锚点位置
   * 
   * @param ocrItems OCR识别的文本项
   * @param expectedMarkers 预期的所有锚点位置
   * @returns 检测到的锚点位置列表
   */
  private detectCornerMarkers(
    ocrItems: any[],
    expectedMarkers: AnchorMarker[]
  ): AnchorMarker[] {
    const detectedMarkers: AnchorMarker[] = [];
    // 所有锚点文本
    const allMarkerTexts = expectedMarkers.map(m => m.text);
    
    // 锚点的大小（用于确定匹配范围）
    const markerSize = Math.max(50, Math.floor(expectedMarkers[0]?.x || 75) * 0.6);
    const searchRadius = markerSize * 4;
    
    for (const item of ocrItems) {
      const text = item.DetectedText?.trim();
      if (!text) continue;
      
      // 检查是否是锚点标记（支持精确匹配和部分匹配）
      let markerIndex = -1;
      for (let i = 0; i < allMarkerTexts.length; i++) {
        if (allMarkerTexts[i] && text === allMarkerTexts[i]) {
          markerIndex = i;
          break;
        }
      }
      // 尝试部分匹配
      if (markerIndex === -1) {
        for (let i = 0; i < allMarkerTexts.length; i++) {
          if (allMarkerTexts[i] && (text.includes(allMarkerTexts[i]) || allMarkerTexts[i].includes(text))) {
            markerIndex = i;
            break;
          }
        }
      }
      if (markerIndex === -1) continue;
      
      // 获取文本位置
      let x = 0, y = 0;
      if (item.ItemPolygon) {
        x = item.ItemPolygon.X || item.ItemPolygon.x || 0;
        y = item.ItemPolygon.Y || item.ItemPolygon.y || 0;
      } else if (item.Polygon && item.Polygon.length >= 4) {
        const xs = item.Polygon.map((p: any) => p.X || p.x);
        const ys = item.Polygon.map((p: any) => p.Y || p.y);
        x = (Math.min(...xs) + Math.max(...xs)) / 2;
        y = (Math.min(...ys) + Math.max(...ys)) / 2;
      } else {
        continue;
      }
      
      const expected = expectedMarkers[markerIndex];
      if (expected) {
        const dx = Math.abs(x - expected.x);
        const dy = Math.abs(y - expected.y);
        
        // 即使偏差超过阈值，也保留锚点用于旋转检测
        // 旋转后的锚点位置会完全不同，所以不能用固定阈值过滤
        detectedMarkers.push({
          id: expected.id,
          x: x,
          y: y,
          text: expected.text,
          type: expected.type
        });
        
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < searchRadius * 2) {
          const okMsg = '[OCR] 检测到锚点' + expected.id + ' ' + expected.text + ': (' + x.toFixed(0) + ', ' + y.toFixed(0) + '), 预期: (' + expected.x.toFixed(0) + ', ' + expected.y.toFixed(0) + '), 距离: ' + dist.toFixed(0) + 'px ✓';
          console.log(okMsg);
        } else {
          const warnMsg = '[OCR] 检测到锚点' + expected.id + ' ' + expected.text + ': (' + x.toFixed(0) + ', ' + y.toFixed(0) + '), 预期: (' + expected.x.toFixed(0) + ', ' + expected.y.toFixed(0) + '), 距离: ' + dist.toFixed(0) + 'px ⚠️';
          console.log(warnMsg);
        }
      }
    }
    
    // 分类统计
    const corners = detectedMarkers.filter(m => m.type === 'corner');
    const mids = detectedMarkers.filter(m => m.type === 'mid');
    
    // 🔍 调试日志：锚点检测完成
    console.log('[OCR] ✅ 锚点检测完成: 共检测到', detectedMarkers.length, '个锚点');
    console.log('[OCR]   角锚点:', corners.length, '个');
    console.log('[OCR]   中间锚点:', mids.length, '个');
    
    return detectedMarkers;
  }

  /**
   * 检测图片旋转角度
   * 
   * @param detectedCorners 检测到的角位置
   * @param expectedCorners 预期的角位置
   * @param width 图片宽度
   * @param height 图片高度
   * @returns 旋转检测结果
   */
  private detectRotation(
    detectedMarkers: AnchorMarker[],
    expectedMarkers: AnchorMarker[],
    width: number,
    height: number
  ): RotationResult {
    // 🔍 调试日志：开始旋转检测
    console.log('[OCR] ═══════════════════════════════════════════════');
    console.log('[OCR] 🔄 开始旋转检测');
    console.log('[OCR] 📐 图片尺寸:', width, 'x', height);
    console.log('[OCR] 📍 预期锚点数量:', expectedMarkers.length);
    console.log('[OCR] 📍 检测到锚点数量:', detectedMarkers.length);
    
    // 分离角锚点和中间锚点
    const detectedCorners = detectedMarkers.filter(m => m.type === 'corner');
    const detectedMids = detectedMarkers.filter(m => m.type === 'mid');
    const expectedCorners = expectedMarkers.filter(m => m.type === 'corner');
    const expectedMids = expectedMarkers.filter(m => m.type === 'mid');
    
    console.log('[OCR]   角锚点: 预期', expectedCorners.length, ', 检测', detectedCorners.length);
    console.log('[OCR]   中间锚点: 预期', expectedMids.length, ', 检测', detectedMids.length);
    
    // 统计检测到的锚点数量
    const totalDetected = detectedMarkers.length;
    
    // 如果检测到的锚点太少，无法判断旋转
    if (totalDetected < 2) {
      console.log('[OCR] ⚠️ 检测到的锚点不足(<2)，无法判断旋转，假设无旋转');
      console.log('[OCR] ═══════════════════════════════════════════════');
      return {
        hasRotation: false,
        rotationAngle: 0,
        cornerMapping: new Map(),
        detectedCorners,
        expectedCorners
      };
    }
    
    // 创建一个映射：检测到的锚点ID -> 预期的锚点ID
    const cornerMapping = new Map<number, number>();
    
    // 【新算法】基于几何关系判断旋转
    // 核心思路：通过分析检测到的锚点实际位置，判断它们形成了什么形状
    
    // 1. 根据检测到的角锚点位置，找出它们形成的四边形的四个角
    // 2. 分析每个角锚点"认为"自己应该在的位置 vs 实际位置
    // 3. 计算偏移向量，判断整体偏移模式
    
    // 锚点文本到位置的映射（0°时的预期位置）
    const textToExpectedPos: Record<string, 'top-left' | 'top-right' | 'bottom-right' | 'bottom-left' | 'top' | 'bottom' | 'left' | 'right'> = {
      '左上': 'top-left', '右上': 'top-right', '右下': 'bottom-right', '左下': 'bottom-left',
      '上中': 'top', '下中': 'bottom', '左中': 'left', '右中': 'right'
    };
    
    // 分析每个检测到的锚点
    const rotationVotes = { 0: 0, 90: 0, 180: 0, 270: 0 };
    
    // 找出检测到的角锚点中的最左、最右、最上、最下
    let minXMarker: AnchorMarker | null = null;
    let maxXMarker: AnchorMarker | null = null;
    let minYMarker: AnchorMarker | null = null;
    let maxYMarker: AnchorMarker | null = null;
    
    for (const marker of detectedCorners) {
      if (!minXMarker || marker.x < minXMarker.x) minXMarker = marker;
      if (!maxXMarker || marker.x > maxXMarker.x) maxXMarker = marker;
      if (!minYMarker || marker.y < minYMarker.y) minYMarker = marker;
      if (!maxYMarker || marker.y > maxYMarker.y) maxYMarker = marker;
    }
    
    // 确定检测到的四边形的四个角
    const detectedPositions = new Map<string, AnchorMarker>();
    
    // 根据相对位置判断每个锚点实际在图像中的位置
    for (const marker of detectedCorners) {
      const isLeft = marker.x <= (minXMarker!.x + maxXMarker!.x) / 2;
      const isTop = marker.y <= (minYMarker!.y + maxYMarker!.y) / 2;
      
      let actualPos: string;
      if (isLeft && isTop) actualPos = 'top-left';
      else if (!isLeft && isTop) actualPos = 'top-right';
      else if (!isLeft && !isTop) actualPos = 'bottom-right';
      else actualPos = 'bottom-left';
      
      detectedPositions.set(actualPos, marker);
    }
    
    // 分析每个锚点的文本与实际位置的差异
    for (const [actualPos, marker] of detectedPositions) {
      const expectedPos = textToExpectedPos[marker.text];
      
      // 根据文本预期位置 vs 实际位置 判断旋转
      if (expectedPos === 'top-left' && actualPos === 'top-left') rotationVotes[0] += 2;
      if (expectedPos === 'top-left' && actualPos === 'top-right') rotationVotes[90] += 2;
      if (expectedPos === 'top-left' && actualPos === 'bottom-right') rotationVotes[180] += 2;
      if (expectedPos === 'top-left' && actualPos === 'bottom-left') rotationVotes[270] += 2;
      
      if (expectedPos === 'top-right' && actualPos === 'top-right') rotationVotes[0] += 2;
      if (expectedPos === 'top-right' && actualPos === 'bottom-right') rotationVotes[90] += 2;
      if (expectedPos === 'top-right' && actualPos === 'bottom-left') rotationVotes[180] += 2;
      if (expectedPos === 'top-right' && actualPos === 'top-left') rotationVotes[270] += 2;
      
      if (expectedPos === 'bottom-right' && actualPos === 'bottom-right') rotationVotes[0] += 2;
      if (expectedPos === 'bottom-right' && actualPos === 'bottom-left') rotationVotes[90] += 2;
      if (expectedPos === 'bottom-right' && actualPos === 'top-left') rotationVotes[180] += 2;
      if (expectedPos === 'bottom-right' && actualPos === 'top-right') rotationVotes[270] += 2;
      
      if (expectedPos === 'bottom-left' && actualPos === 'bottom-left') rotationVotes[0] += 2;
      if (expectedPos === 'bottom-left' && actualPos === 'top-left') rotationVotes[90] += 2;
      if (expectedPos === 'bottom-left' && actualPos === 'top-right') rotationVotes[180] += 2;
      if (expectedPos === 'bottom-left' && actualPos === 'bottom-right') rotationVotes[270] += 2;
    }
    
    // 添加中间锚点的投票
    for (const marker of detectedMids) {
      const expectedPos = textToExpectedPos[marker.text];
      const isTop = marker.y <= height / 2;
      const isBottom = marker.y > height / 2;
      const isLeft = marker.x <= width / 2;
      const isRight = marker.x > width / 2;
      
      let actualPos: string;
      if (isTop) actualPos = 'top';
      else if (isBottom) actualPos = 'bottom';
      if (isLeft) actualPos = 'left';
      else if (isRight) actualPos = 'right';
      
      if (expectedPos === 'top' && actualPos === 'top') rotationVotes[0] += 1;
      if (expectedPos === 'top' && actualPos === 'right') rotationVotes[90] += 1;
      if (expectedPos === 'top' && actualPos === 'bottom') rotationVotes[180] += 1;
      if (expectedPos === 'top' && actualPos === 'left') rotationVotes[270] += 1;
      
      if (expectedPos === 'bottom' && actualPos === 'bottom') rotationVotes[0] += 1;
      if (expectedPos === 'bottom' && actualPos === 'left') rotationVotes[90] += 1;
      if (expectedPos === 'bottom' && actualPos === 'top') rotationVotes[180] += 1;
      if (expectedPos === 'bottom' && actualPos === 'right') rotationVotes[270] += 1;
      
      if (expectedPos === 'left' && actualPos === 'left') rotationVotes[0] += 1;
      if (expectedPos === 'left' && actualPos === 'top') rotationVotes[90] += 1;
      if (expectedPos === 'left' && actualPos === 'right') rotationVotes[180] += 1;
      if (expectedPos === 'left' && actualPos === 'bottom') rotationVotes[270] += 1;
      
      if (expectedPos === 'right' && actualPos === 'right') rotationVotes[0] += 1;
      if (expectedPos === 'right' && actualPos === 'bottom') rotationVotes[90] += 1;
      if (expectedPos === 'right' && actualPos === 'left') rotationVotes[180] += 1;
      if (expectedPos === 'right' && actualPos === 'top') rotationVotes[270] += 1;
    }
    
    const voteMsg = '[OCR] 旋转投票: 0=' + rotationVotes[0] + ', 90=' + rotationVotes[90] + ', 180=' + rotationVotes[180] + ', 270=' + rotationVotes[270];
    console.log(voteMsg);
    
    // 找出得票最多的旋转角度
    const bestRotation = Object.entries(rotationVotes).reduce((a, b) => 
      rotationVotes[parseInt(a[0]) as keyof typeof rotationVotes] > rotationVotes[parseInt(b[0]) as keyof typeof rotationVotes] ? a : b
    );
    
    const detectedRotation = parseInt(bestRotation[0]);
    const confidence = bestRotation[1];
    
    console.log('[OCR] 📊 最高票角度:', detectedRotation + '°', '置信度:', confidence);
    
    // 如果最高票数过低，认为无旋转
    if (confidence < 2) {
      console.log('[OCR] ⚠️ 旋转检测置信度过低(<2)，假设无旋转');
      console.log('[OCR] ═══════════════════════════════════════════════');
      return {
        hasRotation: false,
        rotationAngle: 0,
        cornerMapping,
        detectedCorners,
        expectedCorners
      };
    }
    
    const resultMsg = '[OCR] ✅ 检测到旋转角度: ' + detectedRotation + '° (置信度: ' + confidence + ')';
    console.log(resultMsg);
    console.log('[OCR] ═══════════════════════════════════════════════');
    return {
      hasRotation: true,
      rotationAngle: detectedRotation,
      cornerMapping,
      detectedCorners,
      expectedCorners
    };
  }

  /**
   * 过滤掉所有锚点标记文本
   */
  private filterCornerMarkers(ocrItems: any[]): any[] {
    // 所有锚点文本（8个）
    const allMarkerTexts = ['左上', '右上', '右下', '左下', '上中', '下中', '左中', '右中'];
    // 旧的 circled number 标记（兼容性）
    const oldMarkers = ['①', '②', '③', '④'];
    
    return ocrItems.filter(item => {
      const text = item.DetectedText?.trim();
      
      // 检查是否是锚点标记
      if (allMarkerTexts.includes(text)) {
        return false;
      }
      // 也过滤旧的 circled number 标记（兼容性）
      if (oldMarkers.includes(text)) {
        return false;
      }
      return true;
    });
  }

  /**
   * 过滤无意义文本
   * 
   * 只过滤字符长度为1的文字段
   * 
   * @param ocrItems OCR识别的文本项
   */
  private filterNoiseText(ocrItems: any[]): any[] {
    return ocrItems.filter(item => {
      const text = item.DetectedText?.trim();
      
      if (!text || text.length === 0) {
        return false;
      }
      
      // 过滤单字符
      if (text.length === 1) {
        console.log('[OCR] 过滤单字符: "' + text + '"');
        return false;
      }
      
      return true;
    });
  }

  /**
   * 根据旋转检测结果，将OCR坐标转换回原图坐标系
   * 
   * @param ocrItems OCR识别的文本项
   * @param rotationResult 旋转检测结果
   * @param width 原图宽度
   * @param height 原图高度
   * @returns 转换后的文字区域
   */
  private transformCoordinates(
    ocrItems: any[],
    rotationResult: RotationResult,
    width: number,
    height: number
  ): BoundingBox[] {
    const boxes: BoundingBox[] = [];
    
    // 🔍 调试日志：坐标转换开始
    console.log('[OCR] ═══════════════════════════════════════════════');
    console.log('[OCR] 📍 开始坐标转换');
    console.log('[OCR] 📐 图片尺寸:', width, 'x', height);
    console.log('[OCR] 🔄 旋转检测结果:', rotationResult.hasRotation ? rotationResult.rotationAngle + '° (有旋转)' : '0° (无旋转)');
    console.log('[OCR] 📝 待转换文本项数量:', ocrItems.length);
    console.log('[OCR] ═══════════════════════════════════════════════');
    
    for (const item of ocrItems) {
      // 提取文本位置
      let x = 0, y = 0, w = 50, h = 20;
      
      if (item.ItemPolygon) {
        x = item.ItemPolygon.X || item.ItemPolygon.x || 0;
        y = item.ItemPolygon.Y || item.ItemPolygon.y || 0;
        w = item.ItemPolygon.Width || item.ItemPolygon.width || 50;
        h = item.ItemPolygon.Height || item.ItemPolygon.height || 20;
      } else if (item.Polygon && item.Polygon.length >= 4) {
        const xs = item.Polygon.map((p: any) => p.X || p.x);
        const ys = item.Polygon.map((p: any) => p.Y || p.y);
        x = Math.min(...xs);
        y = Math.min(...ys);
        w = Math.max(...xs) - x;
        h = Math.max(...ys) - y;
      } else {
        // 默认位置（中间偏上）
        x = width * 0.3;
        y = height * 0.3;
      }
      
      // 根据旋转角度进行坐标转换
      let transformedX = x;
      let transformedY = y;
      let transformedW = w;
      let transformedH = h;
      
      if (rotationResult.hasRotation) {
        const angle = rotationResult.rotationAngle;
        
        switch (angle) {
          case 90:
            // 顺时针90°: (x, y) → (y, height - x)
            // 宽高也需要交换：原本横排的变成竖排
            transformedX = y;
            transformedY = height - x;
            transformedW = h;
            transformedH = w;
            break;
          case 180:
            // 180°: (x, y) → (width - x, height - y)
            // 宽高不变（旋转180°后，文字方向不变）
            transformedX = width - x;
            transformedY = height - y;
            transformedW = w;
            transformedH = h;
            break;
          case 270:
            // 逆时针90°/顺时针270°: (x, y) → (width - y, x)
            // 宽高需要交换
            transformedX = width - y;
            transformedY = x;
            transformedW = h;
            transformedH = w;
            break;
        }
        
        const coordMsg = '[OCR] 坐标转换: (' + x.toFixed(0) + ', ' + y.toFixed(0) + ', ' + w.toFixed(0) + 'x' + h.toFixed(0) + ') -> (' + transformedX.toFixed(0) + ', ' + transformedY.toFixed(0) + ', ' + transformedW.toFixed(0) + 'x' + transformedH.toFixed(0) + ') [旋转' + angle + '度]';
        console.log(coordMsg);
        
        // 调试：显示文字方向
        const originalDirection = h > w * 1.2 ? '竖排' : '横排';
        const newDirection = transformedH > transformedW * 1.2 ? '竖排' : '横排';
        if (originalDirection !== newDirection) {
          console.log('[OCR] 📐 文字方向: ' + originalDirection + ' → ' + newDirection + ' [旋转' + angle + '度]');
        }
      }
      
      // 判断是否为竖排文字（基于转换后的宽高）
      const isVertical = transformedH > transformedW * 1.2;
      
      boxes.push({
        x: transformedX,
        y: transformedY,
        width: transformedW,
        height: transformedH,
        text: item.DetectedText || '',
        confidence: (item.Confidence || 80) / 100,
        isVertical
      });
    }
    
    // 🔍 调试日志：坐标转换完成
    console.log('[OCR] ✅ 坐标转换完成，共', boxes.length, '个文本框');
    console.log('[OCR] ═══════════════════════════════════════════════');
    
    return boxes;
  }

  /**
   * 通过 Canvas 直接从页面元素提取图片（如果 CORS 允许）
   * @param imageElement 页面上的图片元素
   * @returns base64 图片数据
   */
  private extractImageViaCanvas(imageElement: HTMLImageElement): Promise<string> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      // 关键：设置 crossOrigin 为 anonymous，让浏览器在加载图片时带上 CORS 头
      img.crossOrigin = 'anonymous';
      img.src = imageElement.src || imageElement.currentSrc;

      img.onload = () => {
        try {
          // 创建 canvas 并绘制图片
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('无法获取 Canvas 上下文'));
            return;
          }
          ctx.drawImage(img, 0, 0);
          
          // 尝试获取图片数据
          const dataUrl = canvas.toDataURL('image/png');
          
          // 验证：检查是否返回了有效数据（不是 "data:,"）
          if (dataUrl === 'data:,') {
            console.warn('[MangaLens] Canvas 数据为空，可能 CORS 不支持');
            reject(new Error('CORS_NOT_SUPPORTED'));
            return;
          }
          
          console.log('[MangaLens] Canvas 提取图片成功（绕过 background）');
          resolve(dataUrl);
        } catch (e) {
          console.warn('[MangaLens] Canvas 提取失败:', e);
          reject(new Error('CANVAS_EXTRACT_FAILED'));
        }
      };

      img.onerror = () => {
        console.warn('[MangaLens] 图片加载失败');
        reject(new Error('IMAGE_LOAD_FAILED'));
      };
    });
  }

  /**
   * 获取图片：优先使用 Canvas 截图，如果图片未加载则回退到 Background Fetch
   * 
   * 方案：
   * 1. 如果图片已在页面上加载（用户已登录 Pixiv），直接用 Canvas 截图
   * 2. 如果图片未加载（Background Fetch 会 403），尝试 Background Fetch
   * 
   * @param imageElement 页面上的图片元素
   * @param imageUrl 图片 URL
   * @param pageUrl 页面 URL
   */
  private async getImageBase64(
    imageElement: HTMLImageElement,
    imageUrl: string,
    pageUrl: string
  ): Promise<string> {
    // 优先尝试 Canvas 截图（利用浏览器已加载的图片）
    console.log('[MangaLens] 尝试 Canvas 截图（利用浏览器已加载的图片）...');
    try {
      // 检查页面上的图片是否已加载
      if (imageElement.complete && imageElement.naturalWidth > 0) {
        const base64 = await this.captureImageToBase64(imageElement);
        console.log('[MangaLens] Canvas 截图成功！');
        return base64;
      } else {
        console.log('[MangaLens] 页面图片未加载完成，尝试查找其他同名图片...');
        const base64 = await this.fetchImageViaCanvas(imageUrl);
        console.log('[MangaLens] Canvas 截图成功（通过 URL 查找）！');
        return base64;
      }
    } catch (canvasError) {
      console.warn('[MangaLens] Canvas 截图失败，回退到 Background Fetch:', canvasError);
      // 回退到 Background Fetch
      return this.fetchImageViaBackground(imageUrl, pageUrl);
    }
  }

  /**
   * 通过 Canvas 截图获取图片（解决防盗链问题）
   * 
   * 原理：
   * - 当用户已登录 Pixiv 时，<img> 标签可以直接加载图片（浏览器自动处理 cookie 和 Referer）
   * - 不需要通过 Background Script fetch（会因为防盗链返回 403）
   * - 直接将页面上的 <img> 绘制到 Canvas，然后导出为 Base64
   * 
   * @param imageUrl 图片 URL
   */
  private async fetchImageViaCanvas(imageUrl: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // 查找页面上已经加载的同名图片
      const pageImages = document.querySelectorAll<HTMLImageElement>('img[src], img[data-src]');
      let targetImg: HTMLImageElement | null = null;
      
      // 匹配 URL（忽略查询参数差异，如尺寸参数）
      for (const img of pageImages) {
        const imgSrc = img.src.split('?')[0];
        const targetSrc = imageUrl.split('?')[0];
        if (imgSrc === targetSrc || imgSrc.includes(targetSrc) || targetSrc.includes(imgSrc)) {
          targetImg = img;
          break;
        }
      }
      
      if (!targetImg) {
        reject(new Error('未找到页面上的图片元素'));
        return;
      }
      
      // 检查图片是否已加载
      if (!targetImg.complete || targetImg.naturalWidth === 0) {
        // 图片未加载完成，等待加载
        targetImg.onload = () => {
          this.captureImageToBase64(targetImg!).then(resolve).catch(reject);
        };
        targetImg.onerror = () => {
          reject(new Error('图片加载失败'));
        };
      } else {
        // 图片已加载，直接截图
        this.captureImageToBase64(targetImg).then(resolve).catch(reject);
      }
    });
  }
  
  /**
   * 将图片绘制到 Canvas 并导出为 Base64
   */
  private captureImageToBase64(img: HTMLImageElement): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        // 创建临时 Canvas
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('无法创建 Canvas 上下文'));
          return;
        }
        
        // 绘制图片（不设置 crossOrigin，让浏览器直接使用已有状态）
        ctx.drawImage(img, 0, 0);
        
        // 导出为 Base64
        // 注意：这里可能会失败如果图片是跨域的且服务器不允许
        // 但对于已登录用户，图片应该已经正确加载且没有 taint
        try {
          const dataUrl = canvas.toDataURL('image/png');
          
          // 验证数据是否有效（非tainted）
          if (dataUrl.startsWith('data:,')) {
            reject(new Error('Canvas 被污染，无法导出图片数据'));
            return;
          }
          
          console.log('[MangaLens] Canvas 截图成功，尺寸:', canvas.width, 'x', canvas.height);
          resolve(dataUrl);
        } catch (e) {
          // Canvas taint 错误
          reject(new Error('Canvas 被污染（tainted），可能需要服务器允许跨域访问'));
        }
      } catch (e) {
        reject(e);
      }
    });
  }

  /**
   * 通过 Background Script 获取图片（解决防盗链问题）
   * 
   * 作为 Canvas 截图失败后的备选方案
   * Background Script 可以正确设置 Referer 等防盗链头
   * 
   * @param imageUrl 图片 URL
   * @param pageUrl 当前页面 URL，用于构造 Referer 头
   */
  private fetchImageViaBackground(imageUrl: string, pageUrl?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          target: 'background',
          type: 'FETCH_IMAGE_AS_BASE64',
          imageUrl: imageUrl,
          pageUrl: pageUrl || window.location.href
        },
        (response) => {
          if (response && response.success) {
            console.log('[MangaLens] Background Fetch 成功获取图片，长度:', response.base64?.length);
            resolve(response.base64);
          } else {
            console.error('[MangaLens] Background Fetch 失败:', response?.message);
            reject(new Error(response?.message || 'Background Fetch 图片获取失败'));
          }
        }
      );
    });
  }

  /**
   * 通过 background script 进行 OCR（解决 CORS 和跨域问题）
   * 1. Background fetch 图片（无 CORS 限制）
   * 2. Background 调用 OCR API（无 CORS 限制）
   */
  private async recognizeViaBackground(
    imageElement: HTMLImageElement,
    imageUrl: string
  ): Promise<OCRResult> {
    console.log('[MangaLens] 通过 background script 进行 OCR...');
    
    if (!this.directConfig) {
      throw new Error('未配置腾讯云 OCR');
    }

    const pageUrl = window.location.href;

    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          target: 'background',
          type: 'FETCH_IMAGE_AND_OCR',
          imageUrl: imageUrl,
          pageUrl: pageUrl,
          secretId: this.directConfig!.secretId,
          secretKey: this.directConfig!.secretKey,
          region: this.directConfig!.region || 'ap-guangzhou',
          action: this.directConfig!.action || 'GeneralAccurateOCR'
        },
        (response) => {
          if (response && response.success) {
            console.log('[MangaLens] Background OCR 成功，返回', response.items?.length || 0, '个区域');
            const ocrResult = convertToOCRResult(
              {
                text: response.text,
                items: response.items,
                requestId: response.requestId
              },
              imageElement.naturalWidth || imageElement.width,
              imageElement.naturalHeight || imageElement.height
            );
            resolve(ocrResult);
          } else {
            reject(new Error(response?.message || 'OCR识别失败'));
          }
        }
      );
    });
  }

  /**
   * 使用云函数进行OCR识别（带四角锚点）
   */
  private async recognizeWithCloud(
    imageElement: HTMLImageElement, 
    base64Image: string,
    expectedCorners: CornerMarker[]
  ): Promise<OCRResult> {
    try {
      const ocrResponse = await recognizeWithCloudOCR(base64Image, this.cloudConfig!);
      
      // 检测四角锚点
      const detectedCorners = this.detectCornerMarkers(ocrResponse.items || [], expectedCorners);
      
      // 检测旋转
      const rotationResult = this.detectRotation(
        detectedCorners, 
        expectedCorners,
        imageElement.naturalWidth || imageElement.width,
        imageElement.naturalHeight || imageElement.height
      );
      
      // 过滤角标记
      const filteredItems = this.filterCornerMarkers(ocrResponse.items || []);
      
      // 坐标转换
      const boxes = this.transformCoordinates(
        filteredItems,
        rotationResult,
        imageElement.naturalWidth || imageElement.width,
        imageElement.naturalHeight || imageElement.height
      );
      
      const ocrResult: OCRResult = {
        text: boxes.map(b => b.text).join('\n'),
        boxes: boxes,
        confidence: 0.8
      };
      
      console.log(`[MangaLens] ✓ 云函数OCR识别完成，检测到 ${ocrResult.boxes.length} 个文字区域`);
      return ocrResult;
      
    } catch (error) {
      console.error('[MangaLens] 云函数OCR失败:', error);
      throw error;
    }
  }

  /**
   * 直接使用腾讯云API进行OCR识别
   */
  private async recognizeWithDirectAPI(
    imageElement: HTMLImageElement,
    base64Image: string
  ): Promise<OCRResult> {
    try {
      console.log('[MangaLens] 使用直接API模式OCR...');
      const result = await callTencentCloudOCRDirect(base64Image, this.directConfig!);
      
      const ocrResult = convertToOCRResult(
        result,
        imageElement.naturalWidth || imageElement.width,
        imageElement.naturalHeight || imageElement.height
      );
      
      console.log(`[MangaLens] ✓ 直接API OCR识别完成，检测到 ${ocrResult.boxes.length} 个文字区域`);
      return ocrResult;
      
    } catch (error) {
      console.error('[MangaLens] 直接API OCR失败:', error);
      throw error;
    }
  }

  /**
   * 【新版】使用带四角锚点的 base64 图片进行直接API OCR
   * 通过 background script 转发请求，绕过 CORS 限制
   * 
   * 流程：
   * 1. 发送带锚点的图片到 OCR
   * 2. 识别四角锚点位置
   * 3. 检测旋转角度
   * 4. 过滤角标记文本
   * 5. 将文字区域坐标转换回原图坐标系
   */
  private async recognizeWithDirectAPIForAnchor(
    imageElement: HTMLImageElement,
    base64Image: string,
    originalWidth: number,
    originalHeight: number,
    expectedCorners: CornerMarker[]
  ): Promise<OCRResult> {
    try {
      // 通过 background script 发送 OCR 请求
      const ocrResponse = await new Promise<any>((resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            target: 'background',
            type: 'DIRECT_OCR_RECOGNIZE',
            imageBase64: base64Image,
            secretId: this.directConfig!.secretId,
            secretKey: this.directConfig!.secretKey,
            region: this.directConfig!.region || 'ap-guangzhou',
            action: this.directConfig!.action || 'GeneralAccurateOCR'
          },
          (response) => {
            if (response && response.success) {
              resolve(response);
            } else {
              reject(new Error(response?.message || 'OCR识别失败'));
            }
          }
        );
      });
      
      // 步骤1: 识别四角锚点
      const detectedCorners = this.detectCornerMarkers(ocrResponse.items || [], expectedCorners);
      
      // 步骤2: 检测旋转
      const rotationResult = this.detectRotation(detectedCorners, expectedCorners, originalWidth, originalHeight);
      
      // 步骤3: 过滤角标记文本
      const filteredItems = this.filterCornerMarkers(ocrResponse.items || []);
      
      // 步骤4: 过滤无意义文本（单个字符、纯标点等）
      console.log('[MangaLens] 步骤4: 过滤无意义文本...');
      const noiseFilteredItems = this.filterNoiseText(filteredItems);
      console.log(`[MangaLens] 过滤无意义文本后剩余 ${noiseFilteredItems.length} 个文字区域`);
      
      // 步骤5: 坐标转换
      console.log('[MangaLens] 步骤5: 坐标转换...');
      const transformedBoxes = this.transformCoordinates(
        noiseFilteredItems,
        rotationResult,
        originalWidth,
        originalHeight
      );
      
      const ocrResult: OCRResult = {
        text: transformedBoxes.map(b => b.text).join('\n'),
        boxes: transformedBoxes,
        confidence: 0.8
      };
      
      return ocrResult;
      
    } catch (error) {
      console.error('[MangaLens] 直接API OCR失败:', error);
      throw error;
    }
  }

  /**
   * 通过 background script 测试 OCR 连接
   */
  private testConnectionViaBackground(
    config: TencentCloudOCRConfig
  ): Promise<{ success: boolean; message: string; requestId?: string }> {
    return new Promise((resolve) => {
      // 使用1x1红色像素图片测试
      const testImageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';
      
      chrome.runtime.sendMessage(
        {
          target: 'background',
          type: 'DIRECT_OCR_RECOGNIZE',
          imageBase64: testImageBase64,
          secretId: config.secretId,
          secretKey: config.secretKey,
          region: config.region || 'ap-guangzhou',
          action: config.action || 'GeneralAccurateOCR'
        },
        (response) => {
          if (response && response.success) {
            resolve({
              success: true,
              message: `腾讯云 OCR 连接成功！识别到 ${response.items?.length || 0} 个文字区域`,
              requestId: response.requestId
            });
          } else {
            resolve({
              success: false,
              message: response?.message || '连接测试失败'
            });
          }
        }
      );
    });
  }

  /**
   * 将图片元素转换为 Base64
   */
  private imageToBase64(img: HTMLImageElement): Promise<string> {
    return new Promise((resolve, reject) => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('无法创建 Canvas 上下文'));
        return;
      }
      
      ctx.drawImage(img, 0, 0);
      
      // 【修改】添加方向锚点文本（顶部和底部，诱导 OCR 使用正确方向）
      const anchorResult = this.addDirectionAnchorText(ctx, canvas.width, canvas.height);
      
      // 转换为较小的图片以加快处理
      const maxSize = 1024;
      let targetWidth = canvas.width;
      let targetHeight = canvas.height;
      
      if (targetWidth > maxSize || targetHeight > maxSize) {
        const ratio = Math.min(maxSize / targetWidth, maxSize / targetHeight);
        targetWidth = Math.floor(targetWidth * ratio);
        targetHeight = Math.floor(targetHeight * ratio);
        
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = targetWidth;
        tempCanvas.height = targetHeight;
        const tempCtx = tempCanvas.getContext('2d');
        if (tempCtx) {
          tempCtx.drawImage(canvas, 0, 0, targetWidth, targetHeight);
          canvas.width = targetWidth;
          canvas.height = targetHeight;
          ctx.drawImage(tempCanvas, 0, 0);
        }
      }
      
      try {
        const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
        resolve(dataUrl);
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * 【修改】添加方向锚点文本（顶部和底部）
   * 在图片顶部和底部都添加横向文本，诱导 OCR 使用正确方向
   * 锚点文本会被过滤掉，不会显示在翻译结果中
   */
  private addDirectionAnchorText(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number
  ): { canvas: HTMLCanvasElement; dataUrl: string } {
    // 锚点文本
    const ANCHOR_TEXT = '<この画像は横です>';
    
    // 计算字体大小（根据图片宽度调整）
    const fontSize = Math.max(16, Math.floor(width / 40));
    
    // 文本高度和间距
    const textHeight = fontSize * 2.5;
    const textPadding = 10;
    
    // 创建新的 canvas（增加顶部和底部空间）
    const newCanvas = document.createElement('canvas');
    newCanvas.width = width;
    newCanvas.height = height + textHeight * 2;  // 上下都要留空间
    const newCtx = newCanvas.getContext('2d');
    
    if (!newCtx) {
      console.warn('[OCR] 无法创建新的 Canvas 上下文');
      return { canvas: ctx.canvas, dataUrl: '' };
    }
    
    // 填充白色背景
    newCtx.fillStyle = '#FFFFFF';
    newCtx.fillRect(0, 0, newCanvas.width, newCanvas.height);
    
    // 绘制原图（在中间位置）
    newCtx.drawImage(ctx.canvas, 0, textHeight);
    
    // ============ 顶部锚点文本 ============
    // 绘制顶部文本背景
    newCtx.fillStyle = '#F0F0F0';
    newCtx.fillRect(0, 0, width, textHeight);
    
    // 绘制顶部边框线
    newCtx.strokeStyle = '#CCCCCC';
    newCtx.lineWidth = 1;
    newCtx.beginPath();
    newCtx.moveTo(0, textHeight);
    newCtx.lineTo(width, textHeight);
    newCtx.stroke();
    
    // 绘制顶部锚点文本（居中）
    newCtx.font = `${fontSize}px "Microsoft YaHei", "SimHei", sans-serif`;
    newCtx.fillStyle = '#666666';
    newCtx.textAlign = 'center';
    newCtx.textBaseline = 'middle';
    newCtx.fillText(ANCHOR_TEXT, width / 2, textHeight / 2);
    
    // ============ 底部锚点文本 ============
    // 绘制底部文本背景
    newCtx.fillStyle = '#F0F0F0';
    newCtx.fillRect(0, height + textHeight, width, textHeight);
    
    // 绘制底部边框线
    newCtx.strokeStyle = '#CCCCCC';
    newCtx.lineWidth = 1;
    newCtx.beginPath();
    newCtx.moveTo(0, height + textHeight);
    newCtx.lineTo(width, height + textHeight);
    newCtx.stroke();
    
    // 绘制底部锚点文本（居中）
    newCtx.fillStyle = '#666666';
    newCtx.fillText(ANCHOR_TEXT, width / 2, height + textHeight + textHeight / 2);
    
    // 将新 canvas 的内容复制回原 canvas
    ctx.canvas.width = newCanvas.width;
    ctx.canvas.height = newCanvas.height;
    ctx.drawImage(newCanvas, 0, 0);
    
    // 生成 DataURL
    const dataUrl = newCanvas.toDataURL('image/png');
    
    return { canvas: ctx.canvas, dataUrl };
  }

  /**
   * 配置云函数
   */
  async configureCloudFunction(url: string, region?: string, action?: string): Promise<boolean> {
    if (!url) {
      console.warn('[MangaLens] 云函数URL不能为空');
      return false;
    }
    
    this.config!.ocr.provider = 'cloud';
    this.config!.ocr.cloudFunctionUrl = url;
    if (region) this.config!.ocr.region = region;
    if (action) this.config!.ocr.action = action;
    
    this.cloudConfig = {
      apiUrl: url,
      region: region || 'ap-guangzhou',
      action: (action as any) || 'GeneralAccurateOCR'
    };
    
    await saveExtensionConfig(this.config!);
    
    try {
      const result = await testCloudOCRConnection(this.cloudConfig);
      if (result.success) {
        console.log('[MangaLens] 云函数配置成功并测试通过');
        return true;
      } else {
        console.warn('[MangaLens] 云函数测试失败:', result.message);
        return false;
      }
    } catch (e) {
      console.error('[MangaLens] 云函数配置测试异常:', e);
      return false;
    }
  }

  /**
   * 配置直接API模式
   */
  async configureDirectAPI(
    secretId: string,
    secretKey: string,
    region?: string,
    action?: string
  ): Promise<boolean> {
    if (!secretId || !secretKey) {
      console.warn('[MangaLens] SecretId 或 SecretKey 不能为空');
      return false;
    }
    
    this.config!.ocr.provider = 'direct';
    this.config!.ocr.tencentSecretId = secretId;
    this.config!.ocr.tencentSecretKey = secretKey;
    if (region) this.config!.ocr.region = region;
    if (action) this.config!.ocr.action = action;
    
    this.directConfig = {
      secretId: secretId,
      secretKey: secretKey,
      region: region || 'ap-guangzhou',
      action: (action as any) || 'GeneralAccurateOCR'
    };
    
    await saveExtensionConfig(this.config!);
    
    // 测试连接（通过 background script 避免 CORS）
    try {
      const result = await this.testConnectionViaBackground(this.directConfig);
      if (result.success) {
        console.log('[MangaLens] 直接API配置成功并测试通过');
        return true;
      } else {
        console.warn('[MangaLens] 直接API测试失败:', result.message);
        return false;
      }
    } catch (e) {
      console.error('[MangaLens] 直接API配置测试异常:', e);
      return false;
    }
  }

  /**
   * 获取当前配置
   */
  getConfig(): ExtensionConfig {
    return { ...this.config };
  }

  /**
   * 检查是否使用云函数模式
   */
  isUsingCloudMode(): boolean {
    return this.config?.ocr.provider === 'cloud' && !!this.config.ocr.cloudFunctionUrl;
  }

  /**
   * 检查是否使用直接API模式
   */
  isUsingDirectMode(): boolean {
    return this.config?.ocr.provider === 'direct' && 
           !!this.config?.ocr.tencentSecretId && 
           !!this.config?.ocr.tencentSecretKey;
  }

  /**
   * 识别图片并合并对话
   * 
   * 先进行 OCR 识别，然后将识别结果通过对话合并器处理，
   * 将分散的文字片段按阅读顺序合并成完整的句子。
   * 最后计算每个对话的气泡边界。
   */
  async recognizeAndMerge(
    imageElement: HTMLImageElement,
    mergerConfig?: Partial<DialogMergerConfig>
  ): Promise<{
    /** 合并后的对话列表（含气泡边界） */
    dialogs: MergedDialog[];
    /** 原始 OCR 结果 */
    rawResult: OCRResult;
    /** 图片尺寸 */
    imageSize: { width: number; height: number };
  }> {
    console.log('[MangaLens] 开始识别并合并对话...');
    
    // 1. 执行 OCR 识别
    const rawResult = await this.recognize(imageElement);
    console.log(`[MangaLens] OCR 识别到 ${rawResult.boxes.length} 个文字区域`);
    
    // 获取图片尺寸
    const imageWidth = imageElement.naturalWidth || imageElement.width;
    const imageHeight = imageElement.naturalHeight || imageElement.height;
    
    // 2. 转换为对话合并器需要的格式
    const ocrItems: OCRTextItem[] = rawResult.boxes.map(box => ({
      text: box.text,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      confidence: box.confidence,
      isVertical: box.isVertical
    }));
    
    // 3. 记录旋转信息（用于日志）
    const rotationAngle = rawResult.rotationAngle || 0;
    const hasRotation = rawResult.hasRotation || false;
    if (hasRotation) {
      console.log(`[MangaLens] 检测到图片旋转: ${rotationAngle}°（坐标已转换到统一坐标系）`);
    }
    
    // 4. 根据旋转角度决定合并策略
    // 0°/180°：文字原本是竖排 → verticalMode=true
    // 90°/270°：文字原本是横排 → verticalMode=false
    const calculatedVerticalMode = rotationAngle === 0 || rotationAngle === 180;
    
    // 创建合并配置：根据旋转角度决定是否使用竖排模式
    const effectiveConfig: Partial<DialogMergerConfig> = {
      ...mergerConfig,
      verticalMode: mergerConfig?.verticalMode !== undefined 
        ? mergerConfig.verticalMode 
        : calculatedVerticalMode
    };
    
    console.log(`[MangaLens] 对话合并策略: ${effectiveConfig.verticalMode ? '竖排' : '横排'}模式 [verticalMode=${effectiveConfig.verticalMode}]`);
    
    // 5. 执行对话合并
    const dialogs = mergeDialogs(ocrItems, effectiveConfig);
    console.log(`[MangaLens] 对话合并完成，生成 ${dialogs.length} 个对话`);
    
    // 6. 计算每个对话的气泡边界
    const merger = new DialogMerger(effectiveConfig);
    const dialogsWithBounds = merger.calculateAllBubbleBounds(dialogs, imageWidth, imageHeight);
    
    // 6. 打印合并结果详情
    dialogsWithBounds.forEach((dialog, index) => {
      console.log(`[MangaLens] 对话 ${index + 1}: "${dialog.text}" (${dialog.charCount}字)`);
      if (dialog.bubbleBounds) {
        const b = dialog.bubbleBounds.clipped;
        console.log(`[MangaLens]   气泡边界: x=${b.x}, y=${b.y}, w=${b.width}, h=${b.height}`);
      }
    });
    
    return { 
      dialogs: dialogsWithBounds, 
      rawResult,
      imageSize: { width: imageWidth, height: imageHeight }
    };
  }

  /**
   * 完整流程：识别 + 合并 + 批量翻译
   * 
   * 将 OCR 识别、对话合并、批量翻译整合为一个方法，
   * 一次性完成从图片到翻译结果的全流程。
   * 
   * @param imageElement 图片元素
   * @param mergerConfig 对话合并配置
   * @param deepseekApiKey DeepSeek API Key
   * @param onProgress 进度回调（可选）
   */
  async recognizeAndTranslate(
    imageElement: HTMLImageElement,
    mergerConfig?: Partial<DialogMergerConfig>,
    deepseekApiKey?: string,
    onProgress?: (stage: string, progress: number) => void
  ): Promise<RecognitionTranslationResult> {
    console.log('[MangaLens] 开始完整翻译流程...');

    // 阶段1：OCR 识别 + 对话合并
    onProgress?.('ocr', 0);
    const { dialogs, rawResult, imageSize } = await this.recognizeAndMerge(imageElement, mergerConfig);
    onProgress?.('ocr', 100);

    if (dialogs.length === 0) {
      console.log('[MangaLens] 未检测到文字');
      return {
        dialogs,
        translation: { successCount: 0, failureCount: 0, items: [] },
        rawResult,
        imageSize
      };
    }

    // 阶段2：批量翻译
    onProgress?.('translating', 0);
    
    // 获取 DeepSeek API Key（优先使用传入的参数，其次使用配置）
    const apiKey = deepseekApiKey || this.config?.translation?.deepseekApiKey;
    
    if (!apiKey) {
      console.warn('[MangaLens] 未配置 DeepSeek API Key，无法翻译');
      return {
        dialogs,
        translation: { 
          successCount: 0, 
          failureCount: dialogs.length, 
          items: dialogs.map((d, i) => ({
            id: i + 1,
            originalText: d.text,
            success: false,
            error: '未配置 DeepSeek API Key'
          }))
        },
        rawResult,
        imageSize
      };
    }

    // 准备翻译数据：给每个对话分配唯一 ID
    const translationItems = dialogs.map((dialog, index) => ({
      id: index + 1,
      text: dialog.text
    }));

    // 批量翻译
    const translator = new BatchTranslator({ apiKey });
    const translationResult = await translator.translateInBatches(
      translationItems,
      (completed, total) => {
        onProgress?.('translating', Math.round((completed / total) * 100));
      }
    );

    // 将翻译结果映射回对话（按编号 1-based 索引匹配）
    const translatedDialogs = dialogs.map((dialog, index) => {
      const id = index + 1;  // 对话 ID，从 1 开始
      const translationItem = translationResult.items.find(t => t.id === id);
      
      if (translationItem && translationItem.success) {
        return {
          ...dialog,
          id,
          translatedText: translationItem.translatedText || '',
          translationSuccess: true
        };
      } else {
        // 翻译失败，保留原文
        return {
          ...dialog,
          id,
          translatedText: dialog.text,  // 翻译失败时使用原文
          translationSuccess: false
        };
      }
    });

    onProgress?.('translating', 100);

    console.log(`[MangaLens] 翻译完成: ${translationResult.successCount}/${dialogs.length} 成功`);

    return {
      dialogs: translatedDialogs,
      translation: {
        successCount: translationResult.successCount,
        failureCount: translationResult.failureCount,
        items: translationResult.items
      },
      rawResult,
      imageSize
    };
  }
}

// 导出单例和测试函数
export const mangaOCR = new MangaOCR();
export { testTencentCloudOCRConnectionDirect };

// 重新导出对话合并相关类型
export type { 
  MergedDialog, 
  TranslatedDialog,
  DialogMergerConfig, 
  OCRTextItem,
  BubbleBounds,
  EstimatedSize 
} from './dialog-merger';
export { DialogMerger, mergeDialogs } from './dialog-merger';

// 重新导出批量翻译相关类型
export type {
  DialogTranslationItem,
  BatchTranslationResult
} from './batch-translator';
export { BatchTranslator, batchTranslate } from './batch-translator';

// 重新导出完整流程结果类型
export type { RecognitionTranslationResult } from './ocr-engine';
