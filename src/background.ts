/**
 * Background Script - 后台服务
 * 处理扩展生命周期和消息中转
 * 使用腾讯云官方 SDK 签名逻辑（TC3-HMAC-SHA256）
 */

import CryptoJS from 'crypto-js';
import type { TencentCloudOCRConfig, TencentCloudOCRResult } from './modules/tencent-cloud-ocr-direct';

// ============================================
// Pixiv Cookie 缓存
// ============================================
let pixivCookiesCache: string | null = null;
let cookiesCacheTime = 0;
const COOKIES_CACHE_DURATION = 5 * 60 * 1000; // 缓存 5 分钟

/**
 * 获取用户的 Pixiv Cookie
 * 通过 chrome.cookies API 获取用户已登录的 Cookie
 */
async function getPixivCookies(): Promise<string | null> {
  const now = Date.now();
  
  // 使用缓存
  if (pixivCookiesCache && (now - cookiesCacheTime) < COOKIES_CACHE_DURATION) {
    console.log('[Background] 使用缓存的 Pixiv Cookie');
    return pixivCookiesCache;
  }
  
  try {
    console.log('[Background] 获取 Pixiv Cookie...');
    
    // 获取主域名的所有 Cookie
    const cookies = await chrome.cookies.getAll({ domain: '.pixiv.net' });
    
    if (cookies.length === 0) {
      console.warn('[Background] 未找到 Pixiv Cookie，用户可能未登录');
      return null;
    }
    
    // 构造 Cookie 字符串
    const cookieString = cookies
      .map(c => `${c.name}=${c.value}`)
      .join('; ');
    
    console.log(`[Background] 获取到 ${cookies.length} 个 Pixiv Cookie`);
    
    // 更新缓存
    pixivCookiesCache = cookieString;
    cookiesCacheTime = now;
    
    return cookieString;
  } catch (error) {
    console.error('[Background] 获取 Pixiv Cookie 失败:', error);
    return null;
  }
}

// ============================================
// 图片获取（使用正确的 Pixiv 请求格式）
// ============================================

/**
 * 判断是否为 Pixiv 图片域名
 */
function isPixivImageDomain(url: string): boolean {
  return url.includes('pximg.net') || 
         url.includes('pixiv.net') ||
         url.includes('pixiv.me');
}

/**
 * 构建 fetch 选项
 * @param imageUrl 图片 URL，用于判断是否为 Pixiv 图片
 * @param referer 自适应 Referer，根据作品页面动态生成
 */
function buildFetchOptions(imageUrl: string, referer: string = 'https://www.pixiv.net/'): RequestInit {
  const isPixiv = isPixivImageDomain(imageUrl);
  
  // Pixiv 图片需要特殊的请求头来绕过防盗链
  if (isPixiv) {
    // 参考爬虫项目：Pixiv 图片使用 same-origin + cors 模式
    const headers: Record<string, string> = {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
      'accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9',
      'accept-encoding': 'gzip, deflate, br',
      'referer': referer,  // 指向作品页面
      'sec-fetch-dest': 'image',
      'sec-fetch-mode': 'cors',           // ✅ 修正：使用 cors 模式
      'sec-fetch-site': 'same-origin',     // ✅ 修正：告诉服务器这是同源请求
      'sec-fetch-storage-access': 'active',
      'sec-ch-ua': '"Chromium";v="147", "Google Chrome";v="147", "Not)A;Brand";v="8"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"'
    };
    
    return {
      mode: 'cors',
      credentials: 'omit',
      cache: 'reload',
      headers
    };
  }
  
  // 其他网站的图片保持原样（无特殊处理）
  const headers: Record<string, string> = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    'accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9',
    'accept-encoding': 'gzip, deflate, br',
    'referer': referer,
    'sec-fetch-dest': 'image',
    'sec-fetch-mode': 'no-cors',
    'sec-fetch-site': 'cross-site',
    'sec-fetch-storage-access': 'active'
  };

  return {
    mode: 'cors',
    credentials: 'omit',
    cache: 'reload',
    headers
  };
}

/**
 * 带超时的 fetch
 */
async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = 15000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从 URL 中提取 Pixiv 作品 ID
 * 支持格式：
 * - https://www.pixiv.net/artworks/143994106
 * - https://www.pixiv.net/artworks/143994106#1
 */
function extractIllustId(pageUrl: string | undefined): string | null {
  if (!pageUrl) return null;
  const match = pageUrl.match(/\/artworks\/(\d+)/);
  return match ? match[1] : null;
}

/**
 * 构建自适应 Referer
 * 根据作品页面 URL 动态构建 Referer
 */
function buildAdaptiveReferer(pageUrl: string | undefined): string {
  const illustId = extractIllustId(pageUrl);
  if (illustId) {
    return `https://www.pixiv.net/artworks/${illustId}`;
  }
  return 'https://www.pixiv.net/';
}

/**
 * 获取图片并转为 Base64
 * 根据爬虫代码分析：图片请求需要作品页面作为 Referer
 */
async function fetchImageAsBase64(imageUrl: string, pageUrl?: string): Promise<string> {
  const referer = buildAdaptiveReferer(pageUrl);
  const fetchOptions = buildFetchOptions(imageUrl, referer);
  
  // 调试日志：显示实际发送的请求头
  console.log('[Background] 发送图片请求:');
  console.log('[Background]   URL:', imageUrl);
  console.log('[Background]   Referer:', referer);
  console.log('[Background]   Headers:', JSON.stringify(fetchOptions.headers, null, 2));
  
  const response = await fetchWithTimeout(imageUrl, fetchOptions);
  
  if (!response.ok) {
    console.error('[Background] 请求失败:', response.status, response.statusText);
    throw new Error(`图片获取失败: HTTP ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  const contentType = response.headers.get('content-type') || 'image/jpeg';
  return `data:${contentType};base64,${btoa(binary)}`;
}

// ============================================
// 腾讯云 TC3 签名（参考官方 SDK 实现）
// ============================================

/**
 * TC3-HMAC-SHA256 签名
 * 参考: tencentcloud-sdk-nodejs/es/common/sign.js
 * 
 * 注意：SDK 实现中签名的 headers 只有 content-type 和 host
 * 不包含 x-tc-action, x-tc-timestamp, x-tc-version
 */
function signTC3(params: {
  secretId: string;
  secretKey: string;
  method: string;
  url: string;
  payload: string;
  timestamp: number;
  service: string;
  headers: Record<string, string>;
}): string {
  const { secretId, secretKey, method, url, payload, timestamp, service, headers } = params;
  
  // 解析 URL
  const urlObj = new URL(url);
  const contentType = headers['Content-Type'] || 'application/json';
  
  // 构建 headers 字符串（SDK 只使用 content-type 和 host）
  let headersStr = `content-type:${contentType}\n`;
  let signedHeaders = 'content-type';
  
  headersStr += `host:${urlObj.hostname}\n`;
  signedHeaders += ';host';
  
  // 如果有额外的 headers（如 x-tc-action），它们不会被加入签名
  // 但我们仍然需要在 HTTP 请求中发送它们
  
  // 计算 payload hash
  const payloadHash = CryptoJS.SHA256(payload || '').toString();
  
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
  const hashedCanonicalRequest = CryptoJS.SHA256(canonicalRequest).toString();
  
  const stringToSign = [
    'TC3-HMAC-SHA256',
    timestamp.toString(),
    credentialScope,
    hashedCanonicalRequest
  ].join('\n');
  
  // 计算签名密钥
  const kDate = CryptoJS.HmacSHA256(dateStr, 'TC3' + secretKey).toString(CryptoJS.enc.Hex);
  const kService = CryptoJS.HmacSHA256(service, CryptoJS.enc.Hex.parse(kDate)).toString(CryptoJS.enc.Hex);
  const kSigning = CryptoJS.HmacSHA256('tc3_request', CryptoJS.enc.Hex.parse(kService)).toString(CryptoJS.enc.Hex);
  const signature = CryptoJS.HmacSHA256(stringToSign, CryptoJS.enc.Hex.parse(kSigning)).toString(CryptoJS.enc.Hex);
  
  // 构建 Authorization 头
  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  
  return authorization;
}

/**
 * 使用腾讯云 API 调用 OCR（Base64 模式）
 */
async function backgroundRecognizeWithTencentCloudAPI_Base64(
  imageBase64: string,
  config: TencentCloudOCRConfig
): Promise<TencentCloudOCRResult> {
  const { secretId, secretKey, region = 'ap-guangzhou', action = 'GeneralBasicOCR' } = config;
  
  // 移除 data:image 前缀
  const cleanBase64 = imageBase64.replace(/^data:image\/\w+;base64,/, '');

  console.log('[Background TencentCloud] 调用腾讯云 OCR API (Base64模式)...');
  console.log('[Background] SecretId:', secretId.substring(0, 8) + '...');
  console.log('[Background] Region:', region);
  console.log('[Background] Action:', action);

  const timestamp = Math.floor(Date.now() / 1000);
  const host = 'ocr.tencentcloudapi.com';
  const version = '2018-11-19';
  const url = `https://${host}/`;
  
  // 构建请求体
  // ConfigId=MulOCR 启用多语言识别模式，显著提升日语识别准确度
  // 注意：MulOCR 配置需要使用 GeneralBasicOCR API
  const payload = JSON.stringify({
    "ImageBase64": cleanBase64,
    "ConfigID": "MulOCR"
  });

  // 计算签名
  const headers = {
    'Content-Type': 'application/json'
  };
  
  const authorization = signTC3({
    secretId,
    secretKey,
    method: 'POST',
    url,
    payload,
    timestamp,
    service: 'ocr',
    headers
  });

  console.log('[Background] Authorization header built');

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
      console.error('[Background] HTTP Error:', response.status, errorText);
      throw new Error(`OCR API调用失败: ${response.status} - ${errorText}`);
    }

    const result = await response.json();

    if (result.Response && result.Response.Error) {
      const error = result.Response.Error;
      console.error('[Background] API Error:', error.Code, error.Message);
      throw new Error(`${error.Code}: ${error.Message}`);
    }

    const ocrData = result.Response;
    const textDetections = ocrData.TextDetections || [];

    console.log('[Background] OCR识别成功，返回', textDetections.length, '个文字区域');

    return {
      text: textDetections.map((item: any) => item.DetectedText).join('\n') || '',
      items: textDetections,
      requestId: ocrData.RequestId
    };

  } catch (error: any) {
    console.error('[Background] OCR 调用失败:', error);
    throw error;
  }
}

/**
 * 使用腾讯云 API 调用 OCR（ImageUrl 模式）
 * 直接传入图片 URL，腾讯云服务器端获取图片
 */
async function backgroundRecognizeWithTencentCloudAPI_ImageUrl(
  imageUrl: string,
  config: TencentCloudOCRConfig
): Promise<TencentCloudOCRResult> {
  const { secretId, secretKey, region = 'ap-guangzhou', action = 'GeneralBasicOCR' } = config;

  console.log('[Background TencentCloud] 调用腾讯云 OCR API (ImageUrl模式)...');
  console.log('[Background] SecretId:', secretId.substring(0, 8) + '...');
  console.log('[Background] ImageUrl:', imageUrl);
  console.log('[Background] Region:', region);
  console.log('[Background] Action:', action);

  const timestamp = Math.floor(Date.now() / 1000);
  const host = 'ocr.tencentcloudapi.com';
  const version = '2018-11-19';
  const url = `https://${host}/`;
  
  // 构建请求体（使用 ImageUrl 参数）
  // ConfigId=MulOCR 启用多语言识别模式，显著提升日语识别准确度
  // 注意：MulOCR 配置需要使用 GeneralBasicOCR API
  const payload = JSON.stringify({
    "ImageUrl": imageUrl,
    "ConfigID": "MulOCR"
  });

  // 计算签名
  const headers = {
    'Content-Type': 'application/json'
  };
  
  const authorization = signTC3({
    secretId,
    secretKey,
    method: 'POST',
    url,
    payload,
    timestamp,
    service: 'ocr',
    headers
  });

  console.log('[Background] Authorization header built');

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
      console.error('[Background] HTTP Error:', response.status, errorText);
      throw new Error(`OCR API调用失败: ${response.status} - ${errorText}`);
    }

    const result = await response.json();

    if (result.Response && result.Response.Error) {
      const error = result.Response.Error;
      console.error('[Background] API Error:', error.Code, error.Message);
      throw new Error(`${error.Code}: ${error.Message}`);
    }

    const ocrData = result.Response;
    const textDetections = ocrData.TextDetections || [];

    console.log('[Background] OCR识别成功，返回', textDetections.length, '个文字区域');

    return {
      text: textDetections.map((item: any) => item.DetectedText).join('\n') || '',
      items: textDetections,
      requestId: ocrData.RequestId
    };

  } catch (error: any) {
    console.error('[Background] OCR 调用失败:', error);
    throw error;
  }
}

// 监听安装事件
chrome.runtime.onInstalled.addListener((details) => {
  console.log('[MangaLens] 扩展已安装', details);
  chrome.storage.local.get(['isEnabled'], (result) => {
    if (result.isEnabled === undefined) {
      chrome.storage.local.set({ isEnabled: true });
    }
  });
});

// 监听标签页变化
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    console.log('[MangaLens] 标签页加载完成:', tab.url);
  }
});

// 处理来自 popup 和 content script 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target === 'background') {
    switch (message.type) {
      case 'GET_STORAGE':
        chrome.storage.local.get(message.keys, (result) => {
          sendResponse(result);
        });
        return true;

      case 'SET_STORAGE':
        chrome.storage.local.set(message.data, () => {
          sendResponse({ success: true });
        });
        return true;

      case 'TEST_DIRECT_OCR':
        (async () => {
          try {
            const testImageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';
            const config: TencentCloudOCRConfig = {
              secretId: message.secretId,
              secretKey: message.secretKey,
              region: message.region || 'ap-guangzhou',
              action: message.action || 'GeneralBasicOCR'
            };
            
            const result = await backgroundRecognizeWithTencentCloudAPI_Base64(testImageBase64, config);
            sendResponse({
              success: true,
              message: `腾讯云 OCR 连接成功！识别到 ${result.items.length} 个文字区域`,
              requestId: result.requestId
            });
          } catch (error) {
            sendResponse({
              success: false,
              message: error instanceof Error ? error.message : '连接测试失败'
            });
          }
        })();
        return true;

      case 'DIRECT_OCR_RECOGNIZE':
        (async () => {
          try {
            const config: TencentCloudOCRConfig = {
              secretId: message.secretId,
              secretKey: message.secretKey,
              region: message.region || 'ap-guangzhou',
              action: message.action || 'GeneralBasicOCR'
            };
            
            const result = await backgroundRecognizeWithTencentCloudAPI_Base64(message.imageBase64, config);
            sendResponse({
              success: true,
              text: result.text,
              items: result.items,
              requestId: result.requestId
            });
          } catch (error) {
            sendResponse({
              success: false,
              message: error instanceof Error ? error.message : 'OCR识别失败'
            });
          }
        })();
        return true;

      case 'DIRECT_OCR_RECOGNIZE_URL':
        (async () => {
          try {
            const config: TencentCloudOCRConfig = {
              secretId: message.secretId,
              secretKey: message.secretKey,
              region: message.region || 'ap-guangzhou',
              action: message.action || 'GeneralBasicOCR'
            };
            
            console.log('[Background] 使用 ImageUrl 进行 OCR:', message.imageUrl);
            const result = await backgroundRecognizeWithTencentCloudAPI_ImageUrl(message.imageUrl, config);
            sendResponse({
              success: true,
              text: result.text,
              items: result.items,
              requestId: result.requestId
            });
          } catch (error) {
            console.error('[Background] ImageUrl OCR 失败:', error);
            sendResponse({
              success: false,
              message: error instanceof Error ? error.message : 'OCR识别失败'
            });
          }
        })();
        return true;

      case 'FETCH_IMAGE_AS_BASE64':
        (async () => {
          try {
            const imageUrl = message.imageUrl;
            const pageUrl = message.pageUrl; // 传入当前页面 URL 用于构造 Referer
            console.log('[Background] Fetching image from:', imageUrl, 'page:', pageUrl);
            
            // 使用标准的 fetch referrer 选项（而非手动设置 Referer header）
            const base64 = await fetchImageAsBase64(imageUrl, pageUrl);
            
            console.log('[Background] Image fetched successfully, length:', base64.length);
            sendResponse({ success: true, base64 });
          } catch (error) {
            console.error('[Background] Image fetch failed:', error);
            sendResponse({
              success: false,
              message: error instanceof Error ? error.message : '图片获取失败'
            });
          }
        })();
        return true;

      case 'FETCH_IMAGE_AND_OCR':
        (async () => {
          try {
            const imageUrl = message.imageUrl;
            const pageUrl = message.pageUrl;
            const config: TencentCloudOCRConfig = {
              secretId: message.secretId,
              secretKey: message.secretKey,
              region: message.region || 'ap-guangzhou',
              action: message.action || 'GeneralBasicOCR'
            };
            
            console.log('[Background] Fetching image and performing OCR for:', imageUrl);
            
            // 使用标准的 fetch referrer 选项获取图片
            const imageBase64 = await fetchImageAsBase64(imageUrl, pageUrl);
            
            console.log('[Background] Image fetched, performing OCR...');
            
            const result = await backgroundRecognizeWithTencentCloudAPI_Base64(imageBase64, config);
            
            sendResponse({
              success: true,
              text: result.text,
              items: result.items,
              requestId: result.requestId
            });
          } catch (error) {
            console.error('[Background] Fetch image and OCR failed:', error);
            sendResponse({
              success: false,
              message: error instanceof Error ? error.message : '图片识别失败'
            });
          }
        })();
        return true;

      case 'FETCH_IMAGE_AND_OCR_URL':
        // 直接使用 ImageUrl 进行 OCR（腾讯云服务器端获取图片）
        (async () => {
          try {
            const imageUrl = message.imageUrl;
            const config: TencentCloudOCRConfig = {
              secretId: message.secretId,
              secretKey: message.secretKey,
              region: message.region || 'ap-guangzhou',
              action: message.action || 'GeneralBasicOCR'
            };
            
            console.log('[Background] 直接使用 ImageUrl 进行 OCR:', imageUrl);
            
            const result = await backgroundRecognizeWithTencentCloudAPI_ImageUrl(imageUrl, config);
            
            sendResponse({
              success: true,
              text: result.text,
              items: result.items,
              requestId: result.requestId
            });
          } catch (error) {
            console.error('[Background] ImageUrl OCR failed:', error);
            sendResponse({
              success: false,
              message: error instanceof Error ? error.message : '图片识别失败'
            });
          }
        })();
        return true;

      // ============================================
      // 调试功能：显示图片获取的请求头信息
      // ============================================
      case 'DEBUG_IMAGE_HEADERS':
        (async () => {
          try {
            const imageUrl = message.imageUrl;
            
            // 构建 fetch 选项（根据浏览器实际请求）
            const fetchOptions = buildFetchOptions(imageUrl, 'https://www.pixiv.net/');
            
            // 解析 URL 获取详细信息
            let imageInfo = {
              url: imageUrl,
              hostname: '',
              pathname: '',
              search: ''
            };
            let pageInfo = {
              url: 'https://www.pixiv.net/',
              hostname: 'www.pixiv.net',
              origin: 'https://www.pixiv.net'
            };
            
            try {
              const imgUrl = new URL(imageUrl);
              imageInfo = {
                url: imageUrl,
                hostname: imgUrl.hostname,
                pathname: imgUrl.pathname,
                search: imgUrl.search
              };
            } catch (e) {
              imageInfo = { url: imageUrl, hostname: '解析失败', pathname: '', search: '' };
            }
            
            try {
              if (pageUrl && pageUrl !== '未提供 pageUrl') {
                const pgUrl = new URL(pageUrl);
                pageInfo = {
                  url: pageUrl,
                  hostname: pgUrl.hostname,
                  origin: pgUrl.origin
                };
              }
            } catch (e) {
              pageInfo = { url: pageUrl, hostname: '解析失败', origin: '' };
            }
            
            // 检测是否需要防盗链处理
            const needsAntiHotlink = imageInfo.hostname.endsWith('pximg.net') && 
                                      pageInfo.hostname.endsWith('pixiv.net');
            
            // 尝试实际请求并获取响应头
            let responseHeaders: Record<string, string> = {};
            let status = 0;
            let statusText = '';
            
            try {
              console.log('[Debug] 正在尝试请求图片:', imageUrl);
              console.log('[Debug] 使用 Fetch Options:', JSON.stringify(fetchOptions, null, 2));
              
              const response = await fetchWithTimeout(imageUrl, fetchOptions, 10000);
              status = response.status;
              statusText = response.statusText;
              
              // 获取响应头
              response.headers.forEach((value, key) => {
                responseHeaders[key] = value;
              });
            } catch (fetchError: any) {
              statusText = fetchError.message;
            }
            
            // 返回详细调试信息
            const debugInfo = {
              imageUrl: imageInfo.url,
              imageHostname: imageInfo.hostname,
              imagePath: imageInfo.pathname,
              pageUrl: pageInfo.url,
              pageHostname: pageInfo.hostname,
              pageOrigin: pageInfo.origin,
              needsAntiHotlink,
              referrerSet: fetchOptions.referrer || '未设置',
              referrerPolicy: fetchOptions.referrerPolicy || '未设置',
              fetchOptions: {
                mode: fetchOptions.mode,
                credentials: fetchOptions.credentials,
                cache: fetchOptions.cache,
                referrer: fetchOptions.referrer,
                referrerPolicy: fetchOptions.referrerPolicy
              },
              httpStatus: status,
              httpStatusText: statusText,
              responseHeaders,
              timestamp: new Date().toISOString()
            };
            
            console.log('[Debug] 图片请求调试信息:', debugInfo);
            
            sendResponse({
              success: true,
              debugInfo
            });
          } catch (error) {
            console.error('[Debug] 调试请求失败:', error);
            sendResponse({
              success: false,
              message: error instanceof Error ? error.message : '调试请求失败'
            });
          }
        })();
        return true;
    }
  }
  return true;
});

console.log('[MangaLens] Background script 已加载');
