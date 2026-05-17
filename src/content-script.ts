/**
 * Content Script - 漫画实时翻译 v2.1
 * 运行在漫画页面中
 * 支持自动检测和手动选择两种模式
 * 
 * 新功能：
 * - 对话合并（Y轴聚类 + X轴排序）
 * - 批量翻译（MiniMax API 编号映射）
 * - 翻译覆盖层（横排译文 → 竖排原文位置）
 */

// Import only what we need
import { imageDetector, type DetectedImage } from './modules/image-detector';
import { mangaOCR } from './modules/ocr-engine';
import { translator } from './modules/translator';
import { overlayManager } from './modules/translation-overlay';
import { DialogMerger, type OCRTextItem } from './modules/dialog-merger';
import { BatchTranslator } from './modules/batch-translator';

// State management
interface MangaLensState {
  isEnabled: boolean;
  isProcessing: boolean;
  processedImages: Set<string>;
  apiKey: string;
  apiSecret: string;
  minimaxApiKey: string;
}

const state: MangaLensState = {
  isEnabled: true,
  isProcessing: false,
  processedImages: new Set(),
  apiKey: '',
  apiSecret: '',
  minimaxApiKey: ''
};

// ============================================
// OCR Queue + Translation Queue System
// ============================================

interface OCRTask {
  image: DetectedImage;
  resolve: (result: { boxes: any[]; imageSrc: string; rotationAngle?: number; hasRotation?: boolean }) => void;
  reject: (error: Error) => void;
}

interface TranslationTask {
  image: DetectedImage;
  ocrResult: { 
    boxes: any[]; 
    imageSrc: string;
    rotationAngle?: number;
    hasRotation?: boolean;
  };
  resolve: () => void;
  reject: (error: Error) => void;
}

// Queue configuration
const OCR_CONCURRENCY = 3; // Max 3 concurrent OCR
const TRANSLATION_CONCURRENCY = 5; // Max 5 concurrent translations
const TRANSLATION_QUEUE_LIMIT = TRANSLATION_CONCURRENCY * 2; // 10: pause OCR when translation queue reaches this limit

const translationQueue: TranslationTask[] = [];
let ocrQueue: OCRTask[] = [];
let activeOCRs = 0;
let activeTranslations = 0;
let isOCRPaused = false; // Flag to track if OCR is paused due to translation queue full

/**
 * Process next OCR task
 */
async function processNextOCR(): Promise<void> {
  // Check if OCR is paused due to translation queue being full
  if (isOCRPaused) {
    console.log(`[MangaLens] OCR paused: translation queue (${translationQueue.length}) at limit (${TRANSLATION_QUEUE_LIMIT})`);
    return;
  }

  if (ocrQueue.length === 0 || activeOCRs >= OCR_CONCURRENCY) {
    return;
  }

  const task = ocrQueue.shift();
  if (!task) return;

  activeOCRs++;
  console.log(`[MangaLens] OCR Queue: Starting task, active: ${activeOCRs}, remaining: ${ocrQueue.length}`);

  try {
    console.log(`[MangaLens] 🔄 Processing image: ${task.image.src.substring(0, 100)}...`);

    // Perform OCR
    const ocrResult = await mangaOCR.recognize(task.image.element);

    // Add to translation queue after OCR completes (with rotation info)
    console.log(`[MangaLens] OCR 完成，准备添加到翻译队列: imageSrc=${task.image.src.substring(0, 80)}, boxes=${ocrResult.boxes.length}`);
    translationQueue.push({
      image: task.image,
      ocrResult: { 
        boxes: ocrResult.boxes, 
        imageSrc: task.image.src,
        rotationAngle: ocrResult.rotationAngle,
        hasRotation: ocrResult.hasRotation
      },
      resolve: task.resolve,
      reject: task.reject
    });

    // Check if translation queue reached limit after adding this task
    if (translationQueue.length >= TRANSLATION_QUEUE_LIMIT) {
      isOCRPaused = true;
      console.log(`[MangaLens] ⚠️ OCR paused: translation queue reached limit (${translationQueue.length}/${TRANSLATION_QUEUE_LIMIT})`);
    }

    task.resolve({ boxes: ocrResult.boxes, imageSrc: task.image.src, rotationAngle: ocrResult.rotationAngle, hasRotation: ocrResult.hasRotation });
    console.log(`[MangaLens] OCR complete, added to translation queue. Queue length: ${translationQueue.length}`);

    // Trigger translation queue processing
    processNextTranslation();

  } catch (error) {
    task.reject(error instanceof Error ? error : new Error(String(error)));
  } finally {
    activeOCRs--;
    // Continue processing next OCR (if not paused)
    processNextOCR();
  }
}

/**
 * Process next translation task (supports concurrency)
 */
async function processNextTranslation(): Promise<void> {
  // Check concurrency limit
  if (translationQueue.length === 0 || activeTranslations >= TRANSLATION_CONCURRENCY) {
    return;
  }

  const task = translationQueue.shift();
  if (!task) return;

  activeTranslations++;
  console.log(`[MangaLens] Translation Queue: Starting task, active: ${activeTranslations}, remaining: ${translationQueue.length}`);

  try {
    console.log(`[MangaLens] Starting translation: ${task.image.src.substring(0, 50)}... (image element src: ${task.image.element?.src?.substring(0, 50)})`);
    await translateAndRender(task.image, task.ocrResult);
    task.resolve();
  } catch (error) {
    task.reject(error instanceof Error ? error : new Error(String(error)));
  } finally {
    activeTranslations--;
    
    // Check if we should resume OCR processing
    // Resume OCR when translation queue drops below the limit
    if (isOCRPaused && translationQueue.length < TRANSLATION_QUEUE_LIMIT) {
      isOCRPaused = false;
      console.log(`[MangaLens] ✅ OCR resumed: translation queue (${translationQueue.length}) below limit (${TRANSLATION_QUEUE_LIMIT})`);
      // Trigger OCR processing
      processNextOCR();
    }
    
    // Continue processing next translation
    processNextTranslation();
  }
}

/**
 * Add image to OCR queue
 */
function enqueueImage(image: DetectedImage): Promise<{ boxes: any[]; imageSrc: string }> {
  return new Promise((resolve, reject) => {
    ocrQueue.push({ image, resolve, reject });
    processNextOCR();
  });
}

/**
 * Execute translation and render (single image)
 */
async function translateAndRender(
  image: DetectedImage,
  ocrResult: { boxes: any[]; imageSrc: string; rotationAngle?: number; hasRotation?: boolean }
): Promise<void> {
  const imageSrc = image.src;

  // Skip already processed images
  if (state.processedImages.has(imageSrc)) {
    console.log(`[MangaLens] Skipping already processed image: ${imageSrc}`);
    return;
  }

  // Check if API is configured
  if (!state.apiKey && !state.minimaxApiKey) {
    console.error('[MangaLens] Translation API not configured! Please configure API key in settings.');
    return;
  }

  try {
    if (ocrResult.boxes.length === 0) {
      console.log('[MangaLens] ⚠️ No text detected');
      return;
    }

    console.log(`[MangaLens] ✓ OCR complete, detected ${ocrResult.boxes.length} text regions`);

    // Convert OCR result to DialogMerger format
    const ocrItems: OCRTextItem[] = ocrResult.boxes.map((box) => ({
      text: box.text,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      confidence: box.confidence || 1,
      isVertical: box.isVertical !== undefined ? box.isVertical : true
    }));

    // 2. Dialog merging
    const rotationAngle = ocrResult.rotationAngle || 0;
    const hasRotation = ocrResult.hasRotation || false;
    
    if (hasRotation) {
      console.log(`[MangaLens] Detected image rotation: ${rotationAngle}° (coordinates transformed to unified system)`);
    }
    
    const verticalMode = rotationAngle === 0 || rotationAngle === 180;
    console.log(`[MangaLens] Dialog merge strategy: ${verticalMode ? 'vertical' : 'horizontal'} mode`);
    
    const merger = new DialogMerger({ 
      yThreshold: 40, 
      xThreshold: 40, 
      rtlMode: true,
      verticalMode: verticalMode
    });
    let mergedDialogs = merger.merge(ocrItems);

    // Calculate bubble bounds for each merged dialog
    mergedDialogs = merger.calculateAllBubbleBounds(
      mergedDialogs,
      image.element.naturalWidth,
      image.element.naturalHeight
    );

    console.log(`[MangaLens] ✓ Dialog merge complete, merged into ${mergedDialogs.length} bubbles`);

    // 3. Batch translation (using MiniMax API)
    if (!state.minimaxApiKey) {
      console.error('[MangaLens] MiniMax API Key not configured! Please configure in settings.');
      return;
    }

    console.log('[MangaLens] Batch translating...');

    const batchTranslator = new BatchTranslator({
      apiKey: state.minimaxApiKey
    });

    // Prepare translation data (with IDs)
    const translationItems = mergedDialogs.map((dialog, idx) => ({
      id: idx,
      text: dialog.text
    }));

    // Execute batch translation
    const translationResult = await batchTranslator.translateInBatches(
      translationItems,
      () => {
        // Can update progress, but won't block queue
      }
    );

    // Map translation results back to merged dialogs
    for (const item of translationResult.items) {
      const dialog = mergedDialogs[item.id];
      if (dialog) {
        dialog.translatedText = item.translatedText || item.originalText;
        dialog.translationSuccess = item.success;
      }
    }

    console.log(`[MangaLens] ✓ Translation complete: ${translationResult.successCount} success, ${translationResult.failureCount} failed`);

    // 4. Render translation overlay
    console.log('[MangaLens] Rendering overlay...');

    overlayManager.renderMergedDialogs(image.element, mergedDialogs, {
      horizontalText: false,
      fontSize: 14,
      background: '#FFFFFF',
      backgroundOpacity: 0.88,
      padding: 4
    });

    // Mark as processed
    state.processedImages.add(imageSrc);

    console.log(`[MangaLens] ✅ Complete! Translated ${translationResult.successCount} dialog segments`);

    // Update popup status
    updatePopupStatus();

  } catch (error) {
    console.error('[MangaLens] ❌ Failed to process image:', error);
  }
}

// Show loading indicator
function showLoading(message: string) {
  const existing = document.getElementById('manga-lens-loading');
  if (existing) existing.remove();

  const loader = document.createElement('div');
  loader.id = 'manga-lens-loading';
  loader.className = 'manga-lens-loading';
  loader.textContent = `📚 ${message}`;
  document.body.appendChild(loader);
}

function hideLoading() {
  const loader = document.getElementById('manga-lens-loading');
  if (loader) loader.remove();
}

// Process single image (new version: integrated dialog merge + batch translation)
async function processImage(image: DetectedImage): Promise<void> {
  const imageSrc = image.src;

  // Skip already processed images
  if (state.processedImages.has(imageSrc)) {
    console.log(`[MangaLens] Skipping already processed image: ${imageSrc}`);
    return;
  }

  // Check if API is configured
  if (!state.apiKey && !state.minimaxApiKey) {
    console.error('[MangaLens] Translation API not configured! Please configure API key in settings.');
    return;
  }

  try {
    console.log(`[MangaLens] 🔄 Starting to process image: ${imageSrc.substring(0, 100)}...`);

    // 1. OCR recognition
    showLoading('Recognizing text...');
    console.log('[MangaLens] Step 1/4: OCR in progress...');
    const ocrResult = await mangaOCR.recognize(image.element);

    if (ocrResult.boxes.length === 0) {
      console.log('[MangaLens] ⚠️ No text detected (either no text in image, or OCR model not loaded)');
      hideLoading();
      return;
    }

    console.log(`[MangaLens] ✓ OCR complete, detected ${ocrResult.boxes.length} text regions`);

    // 2. Dialog merging (Y-axis clustering + X-axis sorting)
    showLoading('Merging dialogs...');
    console.log('[MangaLens] Step 2/4: Merging dialogs...');
    
    const ocrItems: OCRTextItem[] = ocrResult.boxes.map((box) => ({
      text: box.text,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      confidence: box.confidence || 1,
      isVertical: box.isVertical !== undefined ? box.isVertical : true
    }));

    const merger = new DialogMerger({ yThreshold: 40, xThreshold: 40, rtlMode: true });
    let mergedDialogs = merger.merge(ocrItems);
    
    // Calculate bubble bounds for each merged dialog
    mergedDialogs = merger.calculateAllBubbleBounds(
      mergedDialogs,
      image.element.naturalWidth,
      image.element.naturalHeight
    );

    console.log(`[MangaLens] ✓ Dialog merge complete, merged into ${mergedDialogs.length} bubbles`);

    // 3. Batch translation (using MiniMax API)
    if (!state.minimaxApiKey) {
      console.error('[MangaLens] MiniMax API Key not configured! Please configure in settings.');
      hideLoading();
      return;
    }

    showLoading(`Translating ${mergedDialogs.length} dialog segments...`);
    console.log('[MangaLens] Step 3/4: Batch translating...');

    const batchTranslator = new BatchTranslator({
      apiKey: state.minimaxApiKey
    });

    // Prepare translation data (with IDs)
    const translationItems = mergedDialogs.map((dialog, idx) => ({
      id: idx,
      text: dialog.text
    }));

    // Execute batch translation
    const translationResult = await batchTranslator.translateInBatches(
      translationItems,
      (completed, total) => {
        showLoading(`Translation progress: ${completed}/${total}`);
      }
    );

    // Map translation results back to merged dialogs
    for (const item of translationResult.items) {
      const dialog = mergedDialogs[item.id];
      if (dialog) {
        dialog.translatedText = item.translatedText || item.originalText;
        dialog.translationSuccess = item.success;
        console.log(`[MangaLens] Map translation: [${item.id}] "${dialog.text.slice(0, 20)}" → "${(item.translatedText || '').slice(0, 20)}", success: ${item.success}`);
      } else {
        console.warn(`[MangaLens] Translation mapping failed: id=${item.id} out of range (total ${mergedDialogs.length} dialogs)`);
      }
    }

    console.log(`[MangaLens] ✓ Translation complete: ${translationResult.successCount} success, ${translationResult.failureCount} failed`);

    // 4. Render translation overlay
    showLoading('Rendering translation overlay...');
    console.log('[MangaLens] Step 4/4: Rendering overlay...');
    
    overlayManager.renderMergedDialogs(image.element, mergedDialogs, {
      horizontalText: false,  // Vertical text (consistent with Japanese original)
      fontSize: 14,
      background: '#FFFFFF',
      backgroundOpacity: 0.88,
      padding: 4
    });

    // Mark as processed
    state.processedImages.add(imageSrc);

    hideLoading();
    console.log(`[MangaLens] ✅ Complete! Translated ${translationResult.successCount} dialog segments`);

    // Update popup status
    updatePopupStatus();
  } catch (error) {
    hideLoading();
    console.error('[MangaLens] ❌ Failed to process image:', error);
  }
}

// Update popup status
async function updatePopupStatus() {
  try {
    chrome.runtime.sendMessage({
      type: 'UPDATE_STATUS',
      processedCount: state.processedImages.size,
      cacheSize: translator.getCacheSize()
    });
  } catch (e) {
    // Ignore when popup is not open
  }
}

// Process all images on page (using queue system)
async function processAllImages(): Promise<void> {
  if (state.isProcessing) {
    console.log('[MangaLens] Already processing, please wait...');
    return;
  }

  state.isProcessing = true;
  showLoading('Scanning page for images...');

  try {
    const images = imageDetector.detectMangaImages();
    console.log(`[MangaLens] 🔍 Detected ${images.length} candidate images`);

    if (images.length === 0) {
      console.log('[MangaLens] ⚠️ No manga images detected, please try:');
      console.log('[MangaLens] 1. Confirm page is fully loaded');
      console.log('[MangaLens] 2. Click "Manual Select" button to select images');
      console.log('[MangaLens] 3. Check if this is an image website');
      hideLoading();
      return;
    }

    // Add all images to OCR queue (parallel processing, max 3 concurrent)
    const promises: Promise<{ boxes: any[]; imageSrc: string }>[] = [];
    for (const image of images) {
      if (!state.processedImages.has(image.src)) {
        promises.push(enqueueImage(image));
      }
    }

    console.log(`[MangaLens] Added ${promises.length} images to OCR queue (max ${OCR_CONCURRENCY} concurrent)`);

    // Wait for all OCR to complete
    await Promise.all(promises);

    console.log(`[MangaLens] ✅ Page processing complete! All images added to translation queue`);
  } finally {
    state.isProcessing = false;
    hideLoading();
  }
}

// Manual image selection
async function selectImageManually(): Promise<void> {
  console.log('[MangaLens] Entering manual selection mode...');

  try {
    const image = await imageDetector.selectImage();

    if (image) {
      console.log('[MangaLens] User selected image, adding to OCR queue...');
      
      // 【修改】手动选择时：先清除该图片的 processed 状态，允许重新翻译
      const imageSrc = image.src;
      const wasProcessed = state.processedImages.has(imageSrc);
      if (wasProcessed) {
        console.log('[MangaLens] Manual re-selection: clearing previous translation state');
        state.processedImages.delete(imageSrc);
        // 清除该图片的覆盖层
        overlayManager.removeOverlaysForImage(image.element);
      }
      
      enqueueImage(image);
    } else {
      console.log('[MangaLens] User cancelled selection');
    }
  } catch (error) {
    console.error('[MangaLens] Manual selection failed:', error);
  }
}

// Initialization
async function initialize(): Promise<void> {
  console.log('========================================');
  console.log('[MangaLens] 🚀 Initializing manga real-time translator...');
  console.log('========================================');

  try {
    // 1. Initialize OCR
    console.log('[MangaLens] Step 1/3: Loading OCR model...');
    showLoading('Loading OCR model...');
    await mangaOCR.initialize();
    console.log('[MangaLens] ✓ OCR model loaded');

    // 2. Load configuration from storage
    console.log('[MangaLens] Step 2/3: Loading configuration...');
    const stored = await chrome.storage.local.get(['apiKey', 'apiSecret', 'minimaxApiKey', 'isEnabled']);
    if (stored.apiKey || stored.minimaxApiKey) {
      state.apiKey = stored.apiKey || '';
      state.apiSecret = stored.apiSecret || '';
      state.minimaxApiKey = stored.minimaxApiKey || '';
      translator.configure({
        minimaxApiKey: state.minimaxApiKey,
        tencentSecretId: state.apiKey,
        tencentSecretKey: state.apiSecret
      });
      console.log('[MangaLens] ✓ API configuration loaded');
    } else {
      console.log('[MangaLens] ⚠️ API key not configured, please configure in settings');
    }
    state.isEnabled = stored.isEnabled !== false;

    // 3. Process images on current page (delayed execution to ensure page fully loaded)
    console.log('[MangaLens] Step 3/3: Scanning page for images...');
    
    // Delay 1 second execution to wait for images to fully load
    setTimeout(async () => {
      if (state.isEnabled) {
        await processAllImages();
      }
    }, 1000);

    // 4. Listen for page changes, process newly loaded images (using queue system)
    const cleanup = imageDetector.observeNewImages(async (images) => {
      console.log(`[MangaLens] Detected ${images.length} new images, adding to OCR queue`);
      if (state.isEnabled) {
        for (const image of images) {
          if (!state.processedImages.has(image.src)) {
            enqueueImage(image);
          }
        }
      }
    });

    // Cleanup function
    window.addEventListener('beforeunload', cleanup);

    console.log('========================================');
    console.log('[MangaLens] ✅ Initialization complete!');
    console.log('[MangaLens] 💡 Tips:');
    console.log('[MangaLens]    - Click extension icon and use "Manual Select" to select specific images');
    console.log('[MangaLens]    - Or wait for auto scan');
    console.log('========================================');
  } catch (error) {
    console.error('[MangaLens] ❌ Initialization failed:', error);
    hideLoading();
  }
}

// Listen for custom re-render events from translation-overlay
window.addEventListener('manga-lens-rerender', async (event: Event) => {
  const customEvent = event as CustomEvent;
  const imageSrc = customEvent.detail?.imageSrc;
  
  if (!imageSrc) return;
  
  console.log('[MangaLens] Received re-render event:', imageSrc);
  
  try {
    const images = document.querySelectorAll('img');
    for (const img of images) {
      if (img.src === imageSrc) {
        console.log('[MangaLens] Re-rendering image:', imageSrc);
        // Re-process image (will apply new rotation angle)
        await processImage({ element: img, src: img.src });
        break;
      }
    }
  } catch (error) {
    console.error('[MangaLens] Re-render failed:', error);
  }
});

// Listen for messages from popup or background
chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  console.log('[MangaLens] Received message:', message.type);
  
  switch (message.type) {
    case 'TOGGLE_ENABLED':
      state.isEnabled = message.enabled;
      if (!state.isEnabled) {
        overlayManager.removeAllOverlays();
        state.processedImages.clear();
        console.log('[MangaLens] Translation disabled');
      } else {
        processAllImages();
      }
      sendResponse({ success: true });
      break;

    case 'CONFIGURE_API':
      state.minimaxApiKey = message.minimaxApiKey || '';
      state.apiKey = message.apiKey || '';
      state.apiSecret = message.apiSecret || '';
      translator.configure({
        minimaxApiKey: state.minimaxApiKey,
        tencentSecretId: state.apiKey,
        tencentSecretKey: state.apiSecret
      });
      chrome.storage.local.set({ 
        minimaxApiKey: message.minimaxApiKey,
        apiKey: message.apiKey, 
        apiSecret: message.apiSecret 
      });
      console.log('[MangaLens] API configuration updated');
      sendResponse({ success: true });
      break;

    case 'CONFIGURE_OCR_DIRECT':
      // OCR configuration (direct API mode)
      const directConfig = {
        ocrMode: message.ocrMode || 'direct',
        tencentSecretId: message.tencentSecretId || '',
        tencentSecretKey: message.tencentSecretKey || '',
        directRegion: message.directRegion || 'ap-guangzhou',
        directAction: message.directAction || 'GeneralAccurateOCR'
      };
      
      if (directConfig.ocrMode === 'direct' && directConfig.tencentSecretId && directConfig.tencentSecretKey) {
        await mangaOCR.configureDirectAPI(
          directConfig.tencentSecretId,
          directConfig.tencentSecretKey,
          directConfig.directRegion,
          directConfig.directAction
        );
        console.log('[MangaLens] Direct API OCR configuration updated');
      } else {
        mangaOCR.useSimulationMode();
        console.log('[MangaLens] OCR switched to simulation mode');
      }
      
      chrome.storage.local.set(directConfig);
      sendResponse({ success: true });
      break;

    case 'TEST_DIRECT_OCR':
      // Test direct API connection (via background script to solve CORS issue)
      (async () => {
        try {
          const result = await new Promise((resolve) => {
            chrome.runtime.sendMessage(
              {
                target: 'background',
                type: 'TEST_DIRECT_OCR',
                secretId: message.secretId,
                secretKey: message.secretKey,
                region: message.region || 'ap-guangzhou',
                action: message.action || 'GeneralAccurateOCR'
              },
              (response) => {
                resolve(response);
              }
            );
          });
          console.log('[MangaLens] Direct API connection test result:', result);
          sendResponse(result);
        } catch (error) {
          console.error('[MangaLens] Direct API connection test exception:', error);
          sendResponse({
            success: false,
            message: error instanceof Error ? error.message : 'Connection test failed'
          });
        }
      })();
      return true;

    case 'CONFIGURE_OCR':
      // OCR configuration (cloud function mode)
      const ocrConfig = {
        ocrMode: message.ocrMode || 'simulation',
        cloudFunctionUrl: message.cloudFunctionUrl || '',
        ocrRegion: message.ocrRegion || 'ap-guangzhou',
        ocrAction: message.ocrAction || 'GeneralAccurateOCR'
      };
      
      if (ocrConfig.ocrMode === 'cloud' && ocrConfig.cloudFunctionUrl) {
        await mangaOCR.configureCloudFunction(
          ocrConfig.cloudFunctionUrl,
          ocrConfig.ocrRegion,
          ocrConfig.ocrAction
        );
        console.log('[MangaLens] Cloud function OCR configuration updated');
      } else {
        mangaOCR.useSimulationMode();
        console.log('[MangaLens] OCR switched to simulation mode');
      }
      
      chrome.storage.local.set(ocrConfig);
      sendResponse({ success: true });
      break;

    case 'REFRESH':
      state.processedImages.clear();
      ocrQueue = []; // Clear OCR queue
      translationQueue.length = 0; // Clear translation queue
      isOCRPaused = false; // Reset OCR pause flag
      overlayManager.removeAllOverlays();
      processAllImages();
      sendResponse({ success: true });
      break;

    case 'SELECT_IMAGE':
      selectImageManually();
      sendResponse({ success: true });
      break;

    case 'RERENDER_IMAGE':
      // Re-render translation for specified image
      (async () => {
        try {
          // Find corresponding image element
          const images = document.querySelectorAll('img');
          for (const img of images) {
            if (img.src === message.imageSrc) {
              console.log('[MangaLens] Re-rendering image:', message.imageSrc);
              // Clear processed mark, re-process
              state.processedImages.delete(message.imageSrc);
              await processImage({ element: img, src: img.src });
              break;
            }
          }
        } catch (error) {
          console.error('[MangaLens] Re-render failed:', error);
        }
      })();
      sendResponse({ success: true });
      break;

    case 'GET_STATUS':
      sendResponse({
        isEnabled: state.isEnabled,
        processedCount: state.processedImages.size,
        cacheSize: translator.getCacheSize()
      });
      break;
  }
  return true;
});

// Initialize after page loads
if (document.readyState === 'complete') {
  initialize();
} else {
  window.addEventListener('load', initialize);
}

console.log('[MangaLens] Content script loaded, waiting for initialization...');

// ============================================
// Global Debug Functions - Enter in console: window.debugPixivImage()
// ============================================

/**
 * Debug function: Analyze Pixiv image requests on current page
 * Call in console: window.debugPixivImage()
 */
(window as any).debugPixivImage = async function(imageUrl?: string): Promise<any> {
  // If no image URL provided, try to get first Pixiv image on page
  if (!imageUrl) {
    const images = document.querySelectorAllAll('img');
    for (const img of images) {
      if (img.src.includes('pximg.net')) {
        imageUrl = img.src;
        console.log('[Debug] Auto-found Pixiv image:', imageUrl);
        break;
      }
    }
    if (!imageUrl) {
      console.error('[Debug] Pixiv image not found (pximg.net)');
      return { error: 'Pixiv image not found' };
    }
  }

  console.log('═══════════════════════════════════════════════');
  console.log('🔍 Pixiv Image Request Debug');
  console.log('═══════════════════════════════════════════════');
  console.log('📌 Image URL:', imageUrl);
  console.log('📌 Page URL:', window.location.href);
  console.log('');

  try {
    const result = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          target: 'background',
          type: 'DEBUG_IMAGE_HEADERS',
          imageUrl: imageUrl,
          pageUrl: window.location.href
        },
        (response) => {
          if (response && response.success) {
            resolve(response.debugInfo);
          } else {
            reject(new Error(response?.message || 'Debug request failed'));
          }
        }
      );
    });

    console.log('📋 Request configuration:');
    console.log('   - Referer will be set to:', result.referrerSet);
    console.log('   - Referrer Policy:', result.referrerPolicy);
    console.log('   - Needs anti-hotlink:', result.needsAntiHotlink ? '✅ Yes' : '❌ No');
    console.log('');
    console.log('🌐 HTTP response status:', result.httpStatus, result.httpStatusText);
    console.log('');
    
    if (result.httpStatus === 403) {
      console.log('❌ 403 error! Anti-hotlink verification failed');
      console.log('   Possible reasons:');
      console.log('   1. Referer not set correctly');
      console.log('   2. Other headers needed (sec-ch-ua, sec-fetch-site, etc.)');
      console.log('   3. Cookies or token required');
      console.log('   4. Request blocked by other security mechanism');
    } else if (result.httpStatus === 200) {
      console.log('✅ Image request successful! Anti-hotlink settings correct');
    }
    
    console.log('');
    console.log('📜 Complete debug info:');
    console.log(JSON.stringify(result, null, 2));
    console.log('═══════════════════════════════════════════════');
    
    return result;
  } catch (error: any) {
    console.error('[Debug] Debug failed:', error);
    return { error: error.message };
  }
};

/**
 * Quick test function: Simulate click on image
 * Usage: window.testPixivReferer('https://i.pximg.net/img-original/img/2024/01/01/00/00/00/123456_p0.jpg')
 */
(window as any).testPixivReferer = async function(imageUrl: string): Promise<any> {
  console.log('[Test] Testing Pixiv image request...');
  console.log('[Test] Image:', imageUrl);
  console.log('[Test] Source:', window.location.href);
  return (window as any).debugPixivImage(imageUrl);
};

// Prompt user about available debug functions
setTimeout(() => {
  console.log('');
  console.log('💡 MangaLens Debug Tips:');
  console.log('   Enter window.debugPixivImage() to debug Pixiv image requests on current page');
  console.log('   Or window.debugPixivImage("imageURL") to debug specific image');
  console.log('');
}, 1000);
