/**
 * Content Script - 漫画实时翻译 v2.1
 * 运行在漫画页面中
 * 支持自动检测和手动选择两种模式
 * 
 * 新功能：
 * - 对话合并（Y轴聚类 + X轴排序）
 * - 批量翻译（DeepSeek V4 Pro API 编号映射）
 * - 翻译覆盖层（横排译文 → 竖排原文位置）
 */

// Import only what we need
import { imageDetector, type DetectedImage } from './modules/image-detector';
import { mangaOCR } from './modules/ocr-engine';
import { translator } from './modules/translator';
import { overlayManager } from './modules/translation-overlay';
import { DialogMerger, type OCRTextItem, type MergedDialog } from './modules/dialog-merger';
import { BatchTranslator } from './modules/batch-translator';
import { translationCache } from './modules/translation-cache';
import { pdfExporter } from './modules/export-pdf';

// State management
interface MangaLensState {
  isEnabled: boolean;
  isProcessing: boolean;
  processedImages: Set<string>;
  apiKey: string;
  apiSecret: string;
  deepseekApiKey: string;
}

const state: MangaLensState = {
  isEnabled: true,
  isProcessing: false,
  processedImages: new Set(),
  apiKey: '',
  apiSecret: '',
  deepseekApiKey: ''
};

// PDF导出模式状态
let pdfModeSavePath = '';
let pdfModeEditDirty = false; // 用户是否有手动修改

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
const OCR_CONCURRENCY = 9; // 腾讯OCR QPS上限10，程序并发9留有余量
const TRANSLATION_CONCURRENCY = 999; // DeepSeek并发上限500，实际使用远低于此，不设限制

const translationQueue: TranslationTask[] = [];
let ocrQueue: OCRTask[] = [];
let activeOCRs = 0;
let activeTranslations = 0;

// 单次翻译图片上限控制
let maxImagesPerBatch = 30; // 默认单次翻译上限
let translationCompletedCount = 0; // 本次已翻译图片计数
let isTranslationPaused = false; // 是否因达到上限而暂停

/**
 * Process next OCR task
 */
async function processNextOCR(): Promise<void> {
  // 检查是否因达到单次上限而暂停全部处理
  if (isTranslationPaused) {
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

    task.resolve({ boxes: ocrResult.boxes, imageSrc: task.image.src, rotationAngle: ocrResult.rotationAngle, hasRotation: ocrResult.hasRotation });
    console.log(`[MangaLens] OCR complete, added to translation queue. Queue length: ${translationQueue.length}`);

    // Trigger translation queue processing (无并发限制，立即启动翻译)
    processNextTranslation();

  } catch (error) {
    task.reject(error instanceof Error ? error : new Error(String(error)));
  } finally {
    activeOCRs--;
    // Continue processing next OCR
    processNextOCR();
  }
}

/**
 * Process next translation task (supports concurrency)
 */
async function processNextTranslation(): Promise<void> {
  // 检查是否因达到单次上限而暂停
  if (isTranslationPaused) {
    return;
  }

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

    // 翻译完成计数 +1，检查是否达到单次上限
    translationCompletedCount++;
    console.log(`[MangaLens] 翻译完成计数: ${translationCompletedCount}/${maxImagesPerBatch}`);

    if (translationCompletedCount >= maxImagesPerBatch) {
      isTranslationPaused = true;
      console.log(`[MangaLens] ⚠️ 已达到单次翻译上限 (${maxImagesPerBatch}张)，暂停处理`);
      showBatchLimitPopup();
    }
  } catch (error) {
    task.reject(error instanceof Error ? error : new Error(String(error)));
  } finally {
    activeTranslations--;
    // Continue processing next translation
    processNextTranslation();
  }
}

/**
 * Add image to OCR queue (cache check BEFORE OCR to save API calls)
 */
function enqueueImage(image: DetectedImage): Promise<{ boxes: any[]; imageSrc: string }> {
  const imageSrc = image.src;

  // 入口层缓存拦截：在入队之前就检查缓存，命中则直接渲染，跳过 OCR 和翻译
  const checkCacheThenEnqueue = async (): Promise<{ boxes: any[]; imageSrc: string }> => {
    // 1. 已处理过的图片直接跳过
    if (state.processedImages.has(imageSrc)) {
      return { boxes: [], imageSrc };
    }

    // 2. 缓存开关开启时，检查本地翻译缓存
    if (translationCache.isEnabled()) {
      const cachedDialogs = await translationCache.get(imageSrc);
      if (cachedDialogs) {
        console.log(`[MangaLens] 📦 从缓存加载翻译（跳过OCR）: ${imageSrc.substring(0, 50)}... (${cachedDialogs.length} 个对话)`);
        overlayManager.renderMergedDialogs(image.element, cachedDialogs, {
          horizontalText: false,
          fontSize: overlayManager.getBaseFontSize(),
          background: '#FFFFFF',
          backgroundOpacity: 0.88,
          padding: 4
        });
        state.processedImages.add(imageSrc);
        updatePopupStatus();
        // PDF模式同步
        if (pdfExporter.pdfMode) pdfExporter.refreshCheckboxes();
        return { boxes: [], imageSrc };
      }
    }

    // 3. 缓存未命中 → 进入 OCR 队列
    return new Promise((resolve, reject) => {
      ocrQueue.push({ image, resolve, reject });
      processNextOCR();
    });
  };

  return checkCacheThenEnqueue();
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

  // 检查本地缓存
  const cachedDialogs = await translationCache.get(imageSrc);
  if (cachedDialogs) {
    console.log(`[MangaLens] 📦 从缓存加载翻译: ${imageSrc.substring(0, 50)}... (${cachedDialogs.length} 个对话)`);
    overlayManager.renderMergedDialogs(image.element, cachedDialogs, {
      horizontalText: false,
      fontSize: overlayManager.getBaseFontSize(),
      background: '#FFFFFF',
      backgroundOpacity: 0.88,
      padding: 4
    });
    state.processedImages.add(imageSrc);
    updatePopupStatus();
    return;
  }

  // Check if API is configured (first occurrence - auto process queue)
  if (!state.apiKey && !state.deepseekApiKey) {
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

    // 3. Batch translation (using DeepSeek V4 Pro API)
    if (!state.deepseekApiKey) {
      console.error('[MangaLens] DeepSeek API Key not configured! Please configure in settings.');
      return;
    }

    console.log('[MangaLens] Batch translating...');

    const batchTranslator = new BatchTranslator({
      apiKey: state.deepseekApiKey
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
      fontSize: overlayManager.getBaseFontSize(),
      background: '#FFFFFF',
      backgroundOpacity: 0.88,
      padding: 4
    });

    // Mark as processed
    state.processedImages.add(imageSrc);

    // 保存翻译结果到本地缓存
    await translationCache.set(imageSrc, mergedDialogs);

    // 如果在PDF模式下，新翻译的图片自动同步
    if (pdfExporter.pdfMode) {
      pdfExporter.refreshCheckboxes();
      console.log(`[MangaLens] 📄 PDF模式：新翻译图片已同步`);
    }

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

/** 显示右下角提示toast */
function showAlertToast(message: string, duration = 3000): void {
  const existing = document.getElementById('manga-lens-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'manga-lens-toast';
  toast.style.cssText = `
    position: fixed; bottom: 24px; right: 24px;
    z-index: 2147483647;
    background: linear-gradient(135deg, #1a1a2e, #16213e);
    border: 1px solid rgba(102,126,234,0.4);
    border-radius: 12px; padding: 14px 20px;
    color: #e0e0e0; font-size: 14px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    box-shadow: 0 4px 16px rgba(0,0,0,0.3);
    animation: ml-toast-in 0.3s ease;
  `;
  toast.textContent = `⚠️ ${message}`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

// Process single image (new version: integrated dialog merge + batch translation)
async function processImage(image: DetectedImage): Promise<void> {
  const imageSrc = image.src;

  // Skip already processed images
  if (state.processedImages.has(imageSrc)) {
    console.log(`[MangaLens] Skipping already processed image: ${imageSrc}`);
    return;
  }

  // 检查本地缓存
  const cachedDialogs = await translationCache.get(imageSrc);
  if (cachedDialogs) {
    console.log(`[MangaLens] 📦 从缓存加载翻译: ${imageSrc.substring(0, 50)}... (${cachedDialogs.length} 个对话)`);
    overlayManager.renderMergedDialogs(image.element, cachedDialogs, {
      horizontalText: false,
      fontSize: overlayManager.getBaseFontSize(),
      background: '#FFFFFF',
      backgroundOpacity: 0.88,
      padding: 4
    });
    state.processedImages.add(imageSrc);
    updatePopupStatus();
    // PDF模式同步
    if (pdfExporter.pdfMode) pdfExporter.refreshCheckboxes();
    return;
  }

  // Check if API is configured (manual processing)
  if (!state.apiKey && !state.deepseekApiKey) {
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

    // 3. Batch translation (using DeepSeek V4 Pro API)
    if (!state.deepseekApiKey) {
      console.error('[MangaLens] DeepSeek API Key not configured! Please configure in settings.');
      hideLoading();
      return;
    }

    showLoading(`Translating ${mergedDialogs.length} dialog segments...`);
    console.log('[MangaLens] Step 3/4: Batch translating...');

    const batchTranslator = new BatchTranslator({
      apiKey: state.deepseekApiKey
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
      fontSize: overlayManager.getBaseFontSize(),
      background: '#FFFFFF',
      backgroundOpacity: 0.88,
      padding: 4
    });

    // Mark as processed
    state.processedImages.add(imageSrc);

    // 保存翻译结果到本地缓存
    await translationCache.set(imageSrc, mergedDialogs);

    // PDF模式同步
    if (pdfExporter.pdfMode) pdfExporter.refreshCheckboxes();

    hideLoading();
    console.log(`[MangaLens] ✅ Complete! Translated ${translationResult.successCount} dialog segments`);

    // Update popup status
    updatePopupStatus();
  } catch (error) {
    hideLoading();
    console.error('[MangaLens] ❌ Failed to process image:', error);
  }
}
async function updatePopupStatus() {
  try {
    chrome.runtime.sendMessage({
      type: 'UPDATE_STATUS',
      processedCount: state.processedImages.size,
      cacheSize: translator.getCacheSize(),
      batchCount: translationCompletedCount,
      batchLimit: maxImagesPerBatch,
      isPaused: isTranslationPaused
    });
  } catch (e) {
    // Ignore when popup is not open
  }
}

/**
 * 显示右下角"达到单次限制"弹窗
 */
function showBatchLimitPopup(): void {
  // 移除旧弹窗
  const existing = document.getElementById('manga-lens-batch-limit-popup');
  if (existing) existing.remove();

  const popup = document.createElement('div');
  popup.id = 'manga-lens-batch-limit-popup';
  popup.innerHTML = `
    <style>
      #manga-lens-batch-limit-popup {
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 2147483647;
        background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
        border: 1px solid rgba(102, 126, 234, 0.4);
        border-radius: 16px;
        padding: 20px 24px;
        color: #e0e0e0;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(102, 126, 234, 0.2);
        animation: mml-slide-up 0.35s cubic-bezier(0.16, 1, 0.3, 1);
        max-width: 360px;
      }
      @keyframes mml-slide-up {
        from { opacity: 0; transform: translateY(20px); }
        to { opacity: 1; transform: translateY(0); }
      }
      #manga-lens-batch-limit-popup .mml-title {
        font-size: 15px;
        font-weight: 600;
        margin-bottom: 8px;
        color: #fff;
      }
      #manga-lens-batch-limit-popup .mml-desc {
        font-size: 13px;
        color: #a0a0b8;
        margin-bottom: 16px;
        line-height: 1.5;
      }
      #manga-lens-batch-limit-popup .mml-buttons {
        display: flex;
        gap: 10px;
      }
      #manga-lens-batch-limit-popup .mml-btn {
        flex: 1;
        padding: 10px 0;
        border: none;
        border-radius: 10px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s;
      }
      .mml-btn-continue {
        background: linear-gradient(135deg, #667eea, #764ba2);
        color: #fff;
      }
      .mml-btn-continue:hover { opacity: 0.9; transform: translateY(-1px); }
      .mml-btn-pause {
        background: rgba(255,255,255,0.08);
        color: #a0a0b8;
        border: 1px solid rgba(255,255,255,0.12) !important;
      }
      .mml-btn-pause:hover { background: rgba(255,255,255,0.14); }
    </style>
    <div class="mml-title">📊 已达到单次翻译上限</div>
    <div class="mml-desc">已翻译 <strong style="color:#667eea">${translationCompletedCount}</strong> 张图片（上限 ${maxImagesPerBatch} 张）。是否继续识别？</div>
    <div class="mml-buttons">
      <button class="mml-btn mml-btn-continue" id="mml-btn-continue">✅ 是，继续翻译</button>
      <button class="mml-btn mml-btn-pause" id="mml-btn-pause">⏸️ 否，暂停翻译</button>
    </div>
  `;
  document.body.appendChild(popup);

  // 绑定按钮事件
  document.getElementById('mml-btn-continue')?.addEventListener('click', () => {
    resumeTranslation();
    popup.remove();
  });
  document.getElementById('mml-btn-pause')?.addEventListener('click', () => {
    popup.remove();
    updatePopupStatus();
  });
}

/**
 * 继续翻译：重置计数，取消暂停，恢复队列处理
 */
function resumeTranslation(): void {
  translationCompletedCount = 0;
  isTranslationPaused = false;
  console.log('[MangaLens] ✅ 翻译已恢复，计数已清零');
  // 恢复 OCR 和翻译队列处理
  processNextOCR();
  processNextTranslation();
  updatePopupStatus();
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
      
      // 【修改】手动选择时：先清除该图片的 processed 状态和缓存，允许重新翻译
      const imageSrc = image.src;
      const wasProcessed = state.processedImages.has(imageSrc);
      if (wasProcessed) {
        console.log('[MangaLens] Manual re-selection: clearing previous translation state and cache');
        state.processedImages.delete(imageSrc);
        overlayManager.removeOverlaysForImage(image.element);
        await translationCache.delete(imageSrc);
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
    const stored = await chrome.storage.local.get(['apiKey', 'apiSecret', 'deepseekApiKey', 'isEnabled']);
    if (stored.apiKey || stored.deepseekApiKey || process.env.DEEPSEEK_API_KEY) {
      state.apiKey = stored.apiKey || '';
      state.apiSecret = stored.apiSecret || '';
      state.deepseekApiKey = stored.deepseekApiKey || process.env.DEEPSEEK_API_KEY || '';
      translator.configure({
        deepseekApiKey: state.deepseekApiKey,
        tencentSecretId: state.apiKey,
        tencentSecretKey: state.apiSecret
      });
      console.log('[MangaLens] ✓ API configuration loaded');
    } else {
      console.log('[MangaLens] ⚠️ API key not configured, please configure in settings');
    }
    state.isEnabled = stored.isEnabled !== false;

    // 3. 加载已保存的字体大小设置
    await overlayManager.loadSavedFontSize();

    // 4. 加载缓存开关状态
    await translationCache.loadEnabledState();

    // 4.5 配置 pdfExporter 回调
    pdfExporter.configure({
      getOverlaysForImage: (img: HTMLImageElement) => overlayManager.getOverlaysForImage(img),
      getTranslatedImages: () => overlayManager.getAllTranslatedImages(),
      getContainerForImage: (img: HTMLImageElement) => overlayManager.getContainerForImage(img),
      getCachedDialogsForImage: async (imageSrc: string) => await translationCache.get(imageSrc),
      onExitRequest: () => handlePdfModeExit(),
      onSaveEdits: (_imageSrc: string, _overlays: HTMLElement[]) => {
        pdfModeEditDirty = true;
      },
      onAutoSave: async () => {
        // 🔧 导出PDF前的静默自动保存（无需用户确认，同"保留修改"逻辑）
        await handlePdfModeAutoSave();
      }
    });

    // 5. Process images on current page (delayed execution to ensure page fully loaded)
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

// ============================================
// PDF导出模式 - 退出确认
// ============================================

async function handlePdfModeExit(): Promise<void> {
  // 🔧 退出前始终静默持久化当前编辑状态（防止 resize/文字编辑等未触发脏标记的修改丢失）
  if (pdfModeEditDirty) {
    console.log('[MangaLens] 🔄 退出PDF模式前自动保存编辑...');
    await handlePdfModeAutoSave();
  }

  // 🔧 增加保护：即使 dirty 标记未设置，也可能存在未保存的覆盖层状态
  //    （如 resize、纯文字编辑等未调用 onSaveEdits 的场景）
  //    通过检查覆盖层快照与缓存的差异来决定是否弹确认窗
  const confirmMessage = '即将退出PDF导出模式。\n\n' +
    '点击"保留修改"：保存您的手动调整，覆盖原始翻译结果\n' +
    '点击"恢复原状"：丢弃手动修改，恢复到翻译时的原始状态';

  const shouldRestore = confirm(confirmMessage);

  if (shouldRestore) {
    // 用户选择"确定"=恢复原状：从缓存重新渲染所有图片
    console.log('[MangaLens] 用户选择恢复原状，从缓存重新渲染');
    const images = overlayManager.getAllTranslatedImages();
    for (const img of images) {
      const cachedDialogs = await translationCache.get(img.src);
      if (cachedDialogs) {
        overlayManager.rerenderFromCache(img, cachedDialogs);
      }
    }
  } else {
    // 用户选择"取消"=保留修改：覆盖本地缓存
    console.log('[MangaLens] 用户选择保留修改，持久化到本地缓存');
    const customFontSizes = pdfExporter.getCustomFontSizes(); // overlayId → px

    const images = overlayManager.getAllTranslatedImages();
    let savedCount = 0;
    for (const img of images) {
      // 从当前缓存数据读取（因为数据结构不变，只是位置/文字被用户改了）
      const cachedDialogs = await translationCache.get(img.src);
      if (!cachedDialogs) continue;

      // 收集用户修改后的覆盖层
      const snapshots = overlayManager.collectOverlaySnapshots(img);

      // 将文字修改反映回 MergedDialog
      for (const snap of snapshots) {
        // 匹配：遍历 overlays Map 找到对应的 TranslationOverlay
        for (const [id, overlay] of (overlayManager as any).overlays) {
          if (id === snap.id) {
            // 找到对应的 MergedDialog（通过 originalBox 匹配）
            for (const dialog of cachedDialogs) {
              const box = dialog.boundingBox;
              const origBox = overlay.originalBox;
              if (box.x === origBox.x && box.y === origBox.y && box.width === origBox.width) {
                dialog.translatedText = snap.text;
                // 🔧 持久化用户自定义的位置和尺寸
                dialog.customStyle = {
                  left: snap.left,
                  top: snap.top,
                  width: snap.width,
                  height: snap.height,
                };
                break;
              }
            }
          }
        }
      }

      // 持久化自定义字体大小（使用 dataset.dialogId 匹配）
      const overlays = overlayManager.getOverlaysForImage(img);
      for (const overlay of overlays) {
        const overlayId = overlay.id;
        if (customFontSizes.has(overlayId)) {
          const fontSize = customFontSizes.get(overlayId)!;
          const dialogId = parseInt(overlay.dataset.dialogId || '', 10);
          // 🔧 修复：dialogId 为 0 时 parseInt("0")===0 是 falsy，改用 !isNaN()
          if (!isNaN(dialogId)) {
            const dialog = cachedDialogs.find((d: any) => d.id === dialogId);
            if (dialog) {
              dialog.customFontSize = fontSize;
            }
          }
        }
      }

      // 🔧 持久化用户删除的对话框：从缓存中移除已删除的 MergedDialog
      const deletedIds = pdfExporter.getDeletedDialogIds();
      if (deletedIds.size > 0) {
        const beforeCount = cachedDialogs.length;
        const filtered = cachedDialogs.filter((d: any) => !deletedIds.has(d.id));
        cachedDialogs.length = 0;
        cachedDialogs.push(...filtered);
        console.log(`[MangaLens] 🗑️ 从缓存移除了 ${beforeCount - cachedDialogs.length} 个已被用户删除的覆盖层`);
      }

      // 🔧 持久化自定义透明度（使用 dataset.dialogId 匹配）
      const customOpacities = pdfExporter.getCustomOpacities();
      for (const overlay of overlays) {
        const overlayId = overlay.id;
        if (customOpacities.has(overlayId)) {
          const opacity = customOpacities.get(overlayId)!;
          const dialogId = parseInt(overlay.dataset.dialogId || '', 10);
          if (!isNaN(dialogId)) {
            const dialog = cachedDialogs.find((d: any) => d.id === dialogId);
            if (dialog) {
              dialog.customOpacity = opacity;
            }
          }
        }
      }
      await translationCache.set(img.src, cachedDialogs);
      savedCount++;
    }
    console.log(`[MangaLens] ✅ 用户修改已持久化到本地缓存 (${savedCount} 张图片)`);
  }

  pdfModeEditDirty = false;
  // 执行退出
  pdfExporter.exitPdfMode();
  pdfModeSavePath = '';
}

/** 导出PDF前的静默自动保存（无需用户确认，同"保留修改"逻辑） */
async function handlePdfModeAutoSave(): Promise<void> {
  if (!pdfModeEditDirty) return; // 无修改，无需保存

  console.log('[MangaLens] 🔄 导出前自动保存编辑...');
  const customFontSizes = pdfExporter.getCustomFontSizes();
  const customOpacities = pdfExporter.getCustomOpacities();
  const deletedIds = pdfExporter.getDeletedDialogIds();

  const images = overlayManager.getAllTranslatedImages();
  for (const img of images) {
    const cachedDialogs = await translationCache.get(img.src);
    if (!cachedDialogs) continue;

    // 收集当前覆盖层快照
    const snapshots = overlayManager.collectOverlaySnapshots(img);

    // 将文字修改和位置反映回 MergedDialog
    for (const snap of snapshots) {
      for (const [id, overlay] of (overlayManager as any).overlays) {
        if (id === snap.id) {
          for (const dialog of cachedDialogs) {
            const box = dialog.boundingBox;
            const origBox = overlay.originalBox;
            if (box.x === origBox.x && box.y === origBox.y && box.width === origBox.width) {
              dialog.translatedText = snap.text;
              dialog.customStyle = {
                left: snap.left,
                top: snap.top,
                width: snap.width,
                height: snap.height,
              };
              break;
            }
          }
        }
      }
    }

    // 持久化自定义字体大小
    const overlays = overlayManager.getOverlaysForImage(img);
    for (const overlay of overlays) {
      const overlayId = overlay.id;
      if (customFontSizes.has(overlayId)) {
        const fontSize = customFontSizes.get(overlayId)!;
        const dialogId = parseInt(overlay.dataset.dialogId || '', 10);
        if (!isNaN(dialogId)) {
          const dialog = cachedDialogs.find((d: any) => d.id === dialogId);
          if (dialog) { dialog.customFontSize = fontSize; }
        }
      }
      if (customOpacities.has(overlayId)) {
        const opacity = customOpacities.get(overlayId)!;
        const dialogId = parseInt(overlay.dataset.dialogId || '', 10);
        if (!isNaN(dialogId)) {
          const dialog = cachedDialogs.find((d: any) => d.id === dialogId);
          if (dialog) { dialog.customOpacity = opacity; }
        }
      }
    }

    // 移除已删除对话框
    if (deletedIds.size > 0) {
      const filtered = cachedDialogs.filter((d: any) => !deletedIds.has(d.id));
      cachedDialogs.length = 0;
      cachedDialogs.push(...filtered);
    }

    await translationCache.set(img.src, cachedDialogs);
  }
  pdfModeEditDirty = false;
  console.log('[MangaLens] ✅ 编辑已自动保存到本地缓存');
}

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
      state.deepseekApiKey = message.deepseekApiKey || '';
      state.apiKey = message.apiKey || '';
      state.apiSecret = message.apiSecret || '';
      translator.configure({
        deepseekApiKey: state.deepseekApiKey,
        tencentSecretId: state.apiKey,
        tencentSecretKey: state.apiSecret
      });
      chrome.storage.local.set({ 
        deepseekApiKey: message.deepseekApiKey,
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
      isTranslationPaused = false; // Reset pause flag
      translationCompletedCount = 0; // Reset batch counter
      overlayManager.removeAllOverlays();
      processAllImages();
      sendResponse({ success: true });
      break;

    case 'SELECT_IMAGE':
      selectImageManually();
      sendResponse({ success: true });
      break;

    case 'UPDATE_FONT_SIZE':
      overlayManager.setBaseFontSize(message.fontSize);
      console.log(`[MangaLens] 字体大小已更新: ${message.fontSize}px`);
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
              // Clear processed mark & cache, re-process
              state.processedImages.delete(message.imageSrc);
              await translationCache.delete(message.imageSrc);
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

    case 'TOGGLE_CACHE':
      await translationCache.setEnabled(message.enabled);
      sendResponse({ success: true });
      break;

    case 'CONTINUE_TRANSLATION':
      resumeTranslation();
      sendResponse({ success: true });
      break;

    case 'UPDATE_BATCH_LIMIT':
      maxImagesPerBatch = Math.max(1, Math.min(100, message.limit || 30));
      console.log(`[MangaLens] 单次翻译上限已更新: ${maxImagesPerBatch}`);
      sendResponse({ success: true });
      break;

    case 'ENTER_PDF_MODE':
      // 1. 检查是否有已翻译图片
      if (state.processedImages.size === 0) {
        showAlertToast('暂无可导出的翻译结果，请先完成翻译');
        sendResponse({ success: false, message: 'no translated images' });
        break;
      }
      // 2. 进入PDF模式
      pdfModeSavePath = message.savePath || '';
      pdfModeEditDirty = false;
      pdfExporter.enterPdfMode(pdfModeSavePath);
      // 3. 启用覆盖层编辑
      pdfExporter.enableOverlayEditing();
      // 4. 异步加载已保存的自定义字体大小
      pdfExporter.loadPersistedFontSizes().catch(() => {});
      console.log('[MangaLens] 📄 已进入PDF导出模式');
      sendResponse({ success: true });
      break;

    case 'EXIT_PDF_MODE':
      handlePdfModeExit();
      sendResponse({ success: true });
      break;

    case 'EXPORT_ALL_PDF':
      pdfExporter.exportAll();
      sendResponse({ success: true });
      break;

    case 'EXPORT_SELECTED_PDF':
      pdfExporter.exportSelected();
      sendResponse({ success: true });
      break;

    case 'GET_STATUS':
      (async () => {
        const localCacheSize = await translationCache.getSize();
        sendResponse({
          isEnabled: state.isEnabled,
          processedCount: state.processedImages.size,
          cacheSize: translator.getCacheSize(),
          localCacheSize,
          cacheEnabled: translationCache.isEnabled(),
          batchCount: translationCompletedCount,
          batchLimit: maxImagesPerBatch,
          isPaused: isTranslationPaused
        });
      })();
      return true; // keep channel open for async
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
