/**
 * 翻译覆盖层模块
 * 将翻译后的文字渲染到漫画图片上
 * 
 * 支持：
 * 1. 原文竖排 → 译文横排渲染
 * 2. 基于 BubbleBounds 的精确定位
 * 3. 智能换行适配气泡尺寸
 */

import type { BoundingBox } from './ocr-engine';
import type { TranslationResult } from './translator';
import type { MergedDialog, BubbleBounds } from './dialog-merger';

export interface TranslationOverlay {
  id: string;
  originalBox: BoundingBox;
  translatedText: string;
  element: HTMLElement;
}

export interface RenderConfig {
  /** 译文是否横排（原文通常是竖排） */
  horizontalText: boolean;
  /** 字体大小 */
  fontSize?: number;
  /** 文字颜色 */
  color?: string;
  /** 背景色 */
  background?: string;
  /** 背景透明度 */
  backgroundOpacity?: number;
  /** 内边距 */
  padding?: number;
  /** 最大行数（超过则截断） */
  maxLines?: number;
}

const DEFAULT_RENDER_CONFIG: Required<RenderConfig> = {
  horizontalText: false,  // 改为竖排（与日语原文一致）
  fontSize: 22,  // 默认22px
  color: '#000000',
  background: '#FFFFFF',
  backgroundOpacity: 0.88,
  padding: 4,
  maxLines: 10
};

export class TranslationOverlayManager {
  private containers: Map<HTMLImageElement, HTMLElement> = new Map();  // ✅ 按图片元素追踪容器
  private overlays: Map<string, TranslationOverlay> = new Map();
  private containerId = 'manga-lens-overlay-container';
  private overlayClass = 'manga-lens-text-overlay';
  
  // 图片边界追踪（以图片元素为单位）
  private imageBoundsMap: Map<HTMLImageElement, { width: number; height: number }> = new Map();

  // 字体缩放比例（每张图片独立，临时调整）
  private fontScaleMap: Map<HTMLImageElement, number> = new Map();
  private defaultFontScale = 1;
  private fontScaleStep = 0.1;  // 每次调整 10%
  private minFontScale = 0.4;
  private maxFontScale = 3.0;

  // 用户可配置的基础字号（单位 px，持久化到 storage）
  private baseFontSize = 22;

  // 每张图片的控制按钮
  private controlButtonMap: Map<HTMLImageElement, HTMLElement> = new Map();

  // 控制按钮的 position-updater（用于 scroll/resize 时重新计算 fixed 定位）
  private positionUpdaters: Array<() => void> = [];
  private scrollListenerBound = false;

  /**
   * 创建或获取覆盖层容器（每张图片独立的容器）
   */
  createContainer(imageElement: HTMLImageElement): HTMLElement {
    // 检查是否已有该图片的 container
    const existing = this.containers.get(imageElement);
    if (existing && existing.parentElement) {
      return existing;
    }

    const parent = imageElement.parentElement!;
    
    // 创建新容器
    const container = document.createElement('div');
    container.id = `${this.containerId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    container.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 999999;
      overflow: hidden;
    `;

    // 确保父元素有相对定位
    const computedStyle = window.getComputedStyle(parent);
    if (computedStyle.position === 'static') {
      parent.style.position = 'relative';
    }

    parent.appendChild(container);
    this.containers.set(imageElement, container);
    
    // 创建字体控制按钮
    this.createFontControlButton(imageElement, container);
    
    console.log(`[Overlay] ✅ 创建新容器: ${imageElement.src.substring(0, 50)}...`);
    return container;
  }

  /**
   * 创建字体大小控制按钮
   * 挂载到 document.body 并采用 position: fixed，彻底脱离网站 DOM 层叠上下文
   */
  private createFontControlButton(imageElement: HTMLImageElement, container: HTMLElement): void {
    // 创建整体按钮容器（包含字体控制和显示/隐藏按钮）
    const wrapper = document.createElement('div');
    wrapper.className = 'manga-lens-controls-wrapper';

    // 字体控制按钮组
    const btnContainer = document.createElement('div');
    btnContainer.className = 'manga-lens-font-controls';
    btnContainer.innerHTML = `
      <button class="ml-font-btn ml-font-decrease" title="缩小字体">−</button>
      <span class="ml-font-scale">100%</span>
      <button class="ml-font-btn ml-font-increase" title="放大字体">+</button>
    `;
    btnContainer.style.cssText = `
      display: flex;
      align-items: center;
      gap: 4px;
      background: rgba(0, 0, 0, 0.7);
      border-radius: 16px;
      padding: 4px 8px;
    `;

    // 显示/隐藏按钮
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'ml-toggle-btn';
    toggleBtn.title = '显示/隐藏翻译';
    toggleBtn.innerHTML = '👁️'; // 眼睛图标
    toggleBtn.style.cssText = `
      background: rgba(0, 0, 0, 0.7);
      border: none;
      color: white;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      display: flex;
      align-items: center;
      justify-content: center;
    `;
    // 初始化隐藏状态为显示
    this.hiddenOverlaysMap = this.hiddenOverlaysMap || new Map();
    this.hiddenOverlaysMap.set(imageElement, false);
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.toggleOverlayVisibility(imageElement, toggleBtn, container);
    });

    const decreaseBtn = btnContainer.querySelector('.ml-font-decrease')!;
    const increaseBtn = btnContainer.querySelector('.ml-font-increase')!;
    const scaleLabel = btnContainer.querySelector('.ml-font-scale')!;

    // 简化按钮样式（提取为公共方法）
    const fontBtnStyle = `
      background: rgba(255, 255, 255, 0.2);
      border: none;
      color: white;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      cursor: pointer;
      font-size: 16px;
      line-height: 1;
      display: flex;
      align-items: center;
      justify-content: center;
    `;
    decreaseBtn.style.cssText = fontBtnStyle;
    decreaseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.adjustFontScale(imageElement, -1, scaleLabel);
    });

    increaseBtn.style.cssText = fontBtnStyle;
    increaseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.adjustFontScale(imageElement, 1, scaleLabel);
    });

    scaleLabel.style.cssText = `
      color: white;
      font-size: 11px;
      min-width: 36px;
      text-align: center;
    `;

    // 初始化缩放比例
    if (!this.fontScaleMap.has(imageElement)) {
      this.fontScaleMap.set(imageElement, this.defaultFontScale);
    }

    // 组装 wrapper
    wrapper.appendChild(toggleBtn);
    wrapper.appendChild(btnContainer);

    // ============ 核心改动：挂载到 document.body + position: fixed ============
    // position: fixed 让按钮固定在视口坐标上，脱离网站的层叠上下文
    // z-index: 2147483647 是 CSS 规范最大安全值，确保按钮在所有网站元素之上
    // pointer-events: auto 确保按钮始终可点击，不会被父级 pointer-events:none 影响

    /**
     * 更新 wrapper 的 fixed 定位（根据图片当前视口位置计算）
     */
    const updatePosition = () => {
      if (!document.body.contains(wrapper)) return;

      const imgRect = imageElement.getBoundingClientRect();
      const isVisible = imgRect.width > 0 && imgRect.height > 0;

      if (!isVisible) {
        wrapper.style.display = 'none';
        return;
      }

      wrapper.style.display = 'flex';
      wrapper.style.cssText = `
        position: fixed;
        top: ${imgRect.top + 8}px;
        left: ${imgRect.right - 8}px;
        transform: translateX(-100%);
        display: flex;
        align-items: center;
        gap: 4px;
        z-index: 2147483647;
        pointer-events: auto;
      `;
    };

    // 注册位置更新器
    this.positionUpdaters.push(updatePosition);

    // 首次挂载 + 定位
    document.body.appendChild(wrapper);
    updatePosition();

    // 确保 scroll/resize 监听只注册一次
    if (!this.scrollListenerBound) {
      this.scrollListenerBound = true;
      window.addEventListener('scroll', this._onScrollResize, { passive: true });
      window.addEventListener('resize', this._onScrollResize, { passive: true });
    }

    this.controlButtonMap.set(imageElement, wrapper);
    (wrapper as any).__mlPositionUpdater = updatePosition;
    this.updateFontScaleLabel(imageElement, scaleLabel);
  }

  /** scroll/resize 时统一更新所有按钮位置 */
  private _onScrollResize = () => {
    this.positionUpdaters.forEach(fn => fn());
  };

  /**
   * 切换覆盖层显示/隐藏
   */
  private hiddenOverlaysMap: Map<HTMLImageElement, boolean> = new Map();

  private toggleOverlayVisibility(imageElement: HTMLImageElement, toggleBtn: HTMLElement, container: HTMLElement): void {
    const isHidden = this.hiddenOverlaysMap.get(imageElement) || false;
    const newState = !isHidden;
    this.hiddenOverlaysMap.set(imageElement, newState);

    if (newState) {
      // 隐藏覆盖层
      container.style.opacity = '0';
      container.style.pointerEvents = 'none';
      toggleBtn.innerHTML = '🚫'; // 隐藏图标
      toggleBtn.title = '显示翻译';
    } else {
      // 显示覆盖层
      container.style.opacity = '1';
      container.style.pointerEvents = 'none';
      toggleBtn.innerHTML = '👁️'; // 眼睛图标
      toggleBtn.title = '隐藏翻译';
      console.log('[MangaLens] 重新显示翻译覆盖层');
    }
  }

  /**
   * 调整字体缩放比例（仅本次会话生效，不持久化）
   */
  private adjustFontScale(imageElement: HTMLImageElement, direction: number, label: HTMLElement): void {
    let scale = this.fontScaleMap.get(imageElement) || this.defaultFontScale;
    scale += direction * this.fontScaleStep;
    scale = Math.max(this.minFontScale, Math.min(this.maxFontScale, scale));
    this.fontScaleMap.set(imageElement, scale);
    
    this.updateFontScaleLabel(imageElement, label);
    this.applyFontScaleToOverlays(imageElement);
  }

  /**
   * 设置基础字体大小（由 popup 设置界面触发）
   * 同时更新所有已渲染覆盖层的字体大小
   */
  setBaseFontSize(size: number): void {
    this.baseFontSize = Math.max(10, Math.min(36, size));
    console.log(`[Overlay] 基础字体大小已更新: ${this.baseFontSize}px`);
    // 立即应用到所有已渲染的覆盖层
    this.applyBaseFontSizeToAllOverlays();
  }

  /**
   * 将当前 baseFontSize × 各图片 scale 应用到所有已渲染覆盖层
   */
  private applyBaseFontSizeToAllOverlays(): void {
    this.containers.forEach((container, imageElement) => {
      const scale = this.fontScaleMap.get(imageElement) || this.defaultFontScale;
      const newFontSize = this.baseFontSize * scale;

      this.overlays.forEach((overlay) => {
        if (container.contains(overlay.element)) {
          overlay.element.style.fontSize = `${newFontSize}px`;
        }
      });
    });
    console.log(`[Overlay] 已更新所有覆盖层字体: baseFontSize=${this.baseFontSize}px`);
  }

  /**
   * 获取当前基础字体大小
   */
  getBaseFontSize(): number {
    return this.baseFontSize;
  }

  /**
   * 从 chrome.storage.local 加载用户设置的基础字号
   */
  async loadSavedFontSize(): Promise<void> {
    try {
      const result = await chrome.storage.local.get(['mangaLensFontSize']);
      if (result.mangaLensFontSize !== undefined) {
        this.baseFontSize = Math.max(10, Math.min(36, result.mangaLensFontSize));
        console.log(`[Overlay] 加载已保存字体大小: ${this.baseFontSize}px`);
      }
    } catch (e) {
      // 使用默认值 22px
    }
  }

  /**
   * 更新缩放标签显示
   */
  private updateFontScaleLabel(imageElement: HTMLImageElement, label: HTMLElement): void {
    const scale = this.fontScaleMap.get(imageElement) || this.defaultFontScale;
    label.textContent = `${Math.round(scale * 100)}%`;
  }

  /**
   * 应用字体缩放到该图片的所有覆盖层
   */
  private applyFontScaleToOverlays(imageElement: HTMLImageElement): void {
    const scale = this.fontScaleMap.get(imageElement) || this.defaultFontScale;
    const newFontSize = this.baseFontSize * scale;

    this.overlays.forEach((overlay, id) => {
      // 只更新属于该图片的覆盖层
      if (this.isOverlayBelongsToImage(overlay, imageElement)) {
        overlay.element.style.fontSize = `${newFontSize}px`;
      }
    });
    console.log(`[Overlay] 字体缩放: ${Math.round(scale * 100)}% (${newFontSize}px)`);
  }

  /**
   * 检查覆盖层是否属于指定图片
   */
  private isOverlayBelongsToImage(overlay: TranslationOverlay, imageElement: HTMLImageElement): boolean {
    const container = this.containers.get(imageElement);
    return container?.contains(overlay.element) || false;
  }

  /**
   * 获取当前图片的字体缩放比例
   */
  getFontScale(imageElement: HTMLImageElement): number {
    return this.fontScaleMap.get(imageElement) || this.defaultFontScale;
  }

  /**
   * 设置默认字体缩放比例（用于新图片）
   */
  setDefaultFontScale(scale: number): void {
    this.defaultFontScale = Math.max(this.minFontScale, Math.min(this.maxFontScale, scale));
  }

  /**
   * 渲染翻译文字
   */
  renderTranslation(
    imageElement: HTMLImageElement,
    box: BoundingBox,
    translatedText: string
  ): string {
    const container = this.createContainer(imageElement);

    const id = `ml-overlay-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // 计算相对于图片的百分比位置
    const imageRect = imageElement.getBoundingClientRect();
    const boxRect = {
      x: (box.x / imageElement.naturalWidth) * 100,
      y: (box.y / imageElement.naturalHeight) * 100,
      width: (box.width / imageElement.naturalWidth) * 100,
      height: (box.height / imageElement.naturalHeight) * 100
    };

    // 创建覆盖元素
    const overlay = document.createElement('div');
    overlay.id = id;
    overlay.className = this.overlayClass;
    overlay.textContent = translatedText;

    // 设置样式（字体调大3号）
    const fontSize = Math.max(10, Math.min(box.height * 0.7, 21));
    
    overlay.style.cssText = `
      position: absolute;
      left: ${boxRect.x}%;
      top: ${boxRect.y}%;
      width: ${boxRect.width}%;
      min-height: ${boxRect.height}%;
      ${box.isVertical ? 'writing-mode: vertical-rl;' : 'writing-mode: horizontal-tb;'}
      font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;
      font-size: ${fontSize}px;
      line-height: 1.3;
      color: #000000;
      background: rgba(255, 255, 255, 0.88);
      padding: 2px 4px;
      margin: 0;
      text-shadow: 0 0 2px rgba(255, 255, 255, 0.9);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
      border-radius: 2px;
      word-break: break-all;
      overflow-wrap: break-word;
      white-space: pre-wrap;
      text-align: center;
      display: flex;
      align-items: center;
      justify-content: center;
      transform: translateZ(0);
      will-change: contents;
    `;

    container.appendChild(overlay);

    // 记录覆盖层
    this.overlays.set(id, {
      id,
      originalBox: box,
      translatedText,
      element: overlay
    });

    return id;
  }

  /**
   * 批量渲染翻译
   */
  renderBatch(
    imageElement: HTMLImageElement,
    boxes: BoundingBox[],
    translations: TranslationResult[]
  ): string[] {
    const ids: string[] = [];

    translations.forEach((translation, index) => {
      const box = boxes[index];
      if (box && translation) {
        const id = this.renderTranslation(
          imageElement,
          box,
          translation.translatedText
        );
        ids.push(id);
      }
    });

    return ids;
  }

  /**
   * 移除指定覆盖层
   */
  removeOverlay(id: string): void {
    const overlay = this.overlays.get(id);
    if (overlay) {
      overlay.element.remove();
      this.overlays.delete(id);
    }
  }

  /**
   * 移除所有覆盖层
   */
  removeAllOverlays(): void {
    this.overlays.forEach((overlay) => {
      overlay.element.remove();
    });
    this.overlays.clear();
    
    // 移除所有图片的容器
    this.containers.forEach((container) => {
      if (container.parentElement) {
        container.remove();
      }
    });
    this.containers.clear();

    // 清理所有控制按钮 wrapper（从 document.body 中移除）
    this.controlButtonMap.forEach((wrapper) => {
      if (wrapper.parentElement) {
        wrapper.remove();
      }
    });
    this.controlButtonMap.clear();
    this.positionUpdaters = [];

    // 移除全局 scroll/resize 监听
    if (this.scrollListenerBound) {
      window.removeEventListener('scroll', this._onScrollResize);
      window.removeEventListener('resize', this._onScrollResize);
      this.scrollListenerBound = false;
    }
  }

  /**
   * 移除指定图片的覆盖层
   */
  removeOverlaysForImage(imageElement: HTMLImageElement): void {
    const container = this.containers.get(imageElement);
    if (container && container.parentElement) {
      container.remove();
    }
    this.containers.delete(imageElement);
    
    // 清理该图片的控制按钮 wrapper（从 document.body 移除）
    const wrapper = this.controlButtonMap.get(imageElement);
    if (wrapper) {
      const updater = (wrapper as any).__mlPositionUpdater;
      if (updater) {
        this.positionUpdaters = this.positionUpdaters.filter(fn => fn !== updater);
      }
      if (wrapper.parentElement) {
        wrapper.remove();
      }
      this.controlButtonMap.delete(imageElement);
    }

    // 清理该图片相关的覆盖层
    this.overlays.forEach((overlay, id) => {
      if (!document.getElementById(id)) {
        this.overlays.delete(id);
      }
    });

    // 如果没有控制按钮了，移除全局监听
    if (this.controlButtonMap.size === 0 && this.scrollListenerBound) {
      window.removeEventListener('scroll', this._onScrollResize);
      window.removeEventListener('resize', this._onScrollResize);
      this.scrollListenerBound = false;
    }
  }

  /**
   * 获取当前覆盖层数量
   */
  getOverlayCount(): number {
    return this.overlays.size;
  }

  /**
   * 检查是否有覆盖层
   */
  hasOverlays(): boolean {
    return this.overlays.size > 0;
  }

  /**
   * 渲染翻译后的对话（新版）
   * 
   * 使用 MergedDialog 的 bubbleBounds 进行精确定位，
   * 将横排译文渲染到原文位置。
   */
  renderMergedDialog(
    imageElement: HTMLImageElement,
    dialog: MergedDialog,
    config?: Partial<RenderConfig>
  ): string {
    // 如果 dialog 指定了 isVertical，覆盖 config 中的 horizontalText
    // isVertical 为 true 表示竖排，horizontalText 应为 false
    // isVertical 为 false 表示横排，horizontalText 应为 true
    const isVertical = dialog.isVertical !== undefined ? dialog.isVertical : true;
    const cfg: Required<RenderConfig> = {
      ...DEFAULT_RENDER_CONFIG,
      ...config,
      horizontalText: !isVertical  // isVertical=true → horizontalText=false
    };
    
    // 确保容器存在（每张图片独立的容器）
    const container = this.createContainer(imageElement);

    const id = `ml-overlay-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    // 获取气泡边界
    // 优先使用 transformedBounds（旋转变换后的边界），否则使用 raw（原始边界）
    const rawBounds = dialog.boundingBox;
    // @ts-ignore - transformedBounds 是我们动态添加的属性
    const transformedBounds = dialog.transformedBounds;
    const bounds = transformedBounds || (dialog.bubbleBounds?.raw || dialog.boundingBox);
    
    // 获取图片的自然尺寸（OCR 识别时的尺寸）
    const imageWidth = imageElement.naturalWidth;
    const imageHeight = imageElement.naturalHeight;
    
    // 【修复】限制边界不超过图片范围，防止 OCR 坐标超出图片边界
    // 关键：当右边界超出图片时，宽度应该是 (图片右边界 - x)
    const boundsRight = bounds.x + bounds.width;
    const boundsBottom = bounds.y + bounds.height;
    
    let safeX = bounds.x;
    let safeY = bounds.y;
    let safeWidth = bounds.width;
    let safeHeight = bounds.height;
    
    // 如果右边界超出图片，调整宽度（保持左边界不变）
    if (boundsRight > imageWidth) {
      safeWidth = Math.max(20, imageWidth - safeX);
    }
    // 如果下边界超出图片，调整高度
    if (boundsBottom > imageHeight) {
      safeHeight = Math.max(20, imageHeight - safeY);
    }
    // 确保不小于最小尺寸
    safeWidth = Math.max(20, safeWidth);
    safeHeight = Math.max(20, safeHeight);
    
    const safeBounds = {
      x: safeX,
      y: safeY,
      width: safeWidth,
      height: safeHeight
    };
    
    // 获取图片在页面中显示的尺寸（用于计算偏移）
    const displayedWidth = imageElement.clientWidth || imageElement.offsetWidth;
    const displayedHeight = imageElement.clientHeight || imageElement.offsetHeight;
    
    // 检查图片尺寸是否有效
    if (displayedWidth === 0 || displayedHeight === 0) {
      console.error(`[Overlay#${id.slice(-6)}] ❌ 图片显示尺寸为0，naturalWidth=${imageWidth}, naturalHeight=${imageHeight}, clientWidth=${displayedWidth}, offsetWidth=${imageElement.offsetWidth}`);
    }
    
    // 计算图片相对于容器的偏移量
    const imgRect = imageElement.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const offsetX = imgRect.left - containerRect.left;
    const offsetY = imgRect.top - containerRect.top;
    
    // 计算缩放比例
    const scaleX = displayedWidth / imageWidth;
    const scaleY = displayedHeight / imageHeight;
    
    // 获取译文（翻译失败时使用原文）
    const translatedText = dialog.translatedText || dialog.text;
    
    // 根据文字内容和方向动态计算覆盖层尺寸
    // 竖排：宽度基于字符数和平均字符宽度，高度基于原始气泡
    // 横排：高度基于行数和行高，宽度基于原始气泡
    const charCount = translatedText.length;
    const charWidth = dialog.charWidth || 14;
    let overlayWidth: number;
    let overlayHeight: number;
    
    if (isVertical) {
      // 竖排：宽度跟随原始气泡（与横排保持一致）
      // 使用 safeBounds.width 确保覆盖所有合并的列
      overlayWidth = safeBounds.width;
      overlayHeight = safeBounds.height; // 高度跟随原始气泡
      console.log(`[Overlay#${id.slice(-6)}] 竖排尺寸计算: ${charCount}字, 使用原始宽度=${overlayWidth.toFixed(1)}px`);
    } else {
      // 横排：覆盖层高度根据行数计算
      const lineHeight = charWidth * 1.4;
      const estimatedLines = Math.ceil(charCount / 8); // 每行约8个字
      overlayHeight = estimatedLines * lineHeight;
      overlayWidth = safeBounds.width; // 宽度跟随原始气泡
      console.log(`[Overlay#${id.slice(-6)}] 横排尺寸计算: ${charCount}字, charWidth=${charWidth.toFixed(1)}, lines=${estimatedLines}, 高度=${overlayHeight.toFixed(1)}px`);
    }
    
    // 限制最小尺寸（自然坐标）
    overlayWidth = Math.max(20, overlayWidth);
    overlayHeight = Math.max(20, overlayHeight);
    
    // 计算像素坐标（基于安全边界和显示尺寸的比例）
    const pixelLeft = safeBounds.x * scaleX;
    const pixelTop = safeBounds.y * scaleY;
    let pixelWidth = overlayWidth * scaleX;   // 【修复】转换为显示坐标
    let pixelHeight = overlayHeight * scaleY; // 【修复】转换为显示坐标
    
    // 限制最大尺寸（显示坐标）
    pixelWidth = Math.min(pixelWidth, displayedWidth * 0.8);
    pixelHeight = Math.min(pixelHeight, displayedHeight * 0.5);
    
    // 计算相对于容器的百分比位置
    const containerWidth = containerRect.width;
    const containerHeight = containerRect.height;
    
    // 检查容器尺寸是否有效
    if (containerWidth === 0 || containerHeight === 0) {
      console.error(`[Overlay#${id.slice(-6)}] ❌ 容器尺寸为0，containerWidth=${containerWidth}, containerHeight=${containerHeight}`);
    }
    
    // 防止除以0
    const safeContainerWidth = containerWidth || 1;
    const safeContainerHeight = containerHeight || 1;
    
    let left = ((offsetX + pixelLeft) / safeContainerWidth) * 100;
    let top = ((offsetY + pixelTop) / safeContainerHeight) * 100;
    let width = (pixelWidth / safeContainerWidth) * 100;
    let height = (pixelHeight / safeContainerHeight) * 100;
    
    // 限制百分比在 0-100 范围内（防止溢出到可见区域外）
    // 但允许少量溢出（-5% 到 105%），因为某些情况下需要稍微超出边界
    left = Math.max(-10, Math.min(110, left));
    top = Math.max(-10, Math.min(110, top));
    width = Math.max(1, Math.min(100, width));
    height = Math.max(1, Math.min(100, height));
    
    // 确保位置不会完全超出图片范围
    if (left > 90 || top > 90 || left < -5 || top < -5) {
      console.warn(`[Overlay#${id.slice(-6)}] ⚠️ 覆盖层位置异常偏出: left=${left.toFixed(2)}%, top=${top.toFixed(2)}%`);
    }
    
    // 调试日志 - 使用分开的 console.log 输出完整信息，避免被截断
    console.log(`[Overlay#${id.slice(-6)}] 📍 渲染信息 [dialogId=${dialog.id}]:`);
    console.log(`  原文: "${dialog.text}", 译文: "${translatedText}"`);
    console.log(`  方向: ${isVertical ? '竖排' : '横排'}, horizontalText=${cfg.horizontalText}`);
    console.log(`  图片尺寸: natural=${imageWidth}x${imageHeight}, displayed=${displayedWidth}x${displayedHeight}`);
    console.log(`  缩放: scaleX=${scaleX.toFixed(4)}, scaleY=${scaleY.toFixed(4)}`);
    console.log(`  渲染边界: (${safeBounds.x}, ${safeBounds.y}) ${safeBounds.width}x${safeBounds.height}`);
    console.log(`  动态尺寸: ${overlayWidth.toFixed(1)}x${overlayHeight.toFixed(1)}px`);
    console.log(`  百分比位置: left=${left.toFixed(2)}%, top=${top.toFixed(2)}%, w=${width.toFixed(2)}%, h=${height.toFixed(2)}%`);
    console.log(`  图片偏移: (${offsetX.toFixed(1)}, ${offsetY.toFixed(1)})`);
    console.log(`  容器尺寸: ${containerRect.width.toFixed(1)}x${containerRect.height.toFixed(1)}`);
    console.log(`  字符: ${dialog.charCount}字, charWidth=${dialog.charWidth?.toFixed(1)}`);
    
    // 警告：横排的小片段可能渲染位置不明显
    if (!isVertical && overlayWidth < 50) {
      console.warn(`[Overlay#${id.slice(-6)}] ⚠️ 横排覆盖层宽度仅 ${overlayWidth.toFixed(1)}px，可能难以看到！`);
    }
    if (!isVertical && bounds.width < 30) {
      console.warn(`[Overlay#${id.slice(-6)}] ⚠️ 原始气泡宽度仅 ${bounds.width}px，横排覆盖层可能很窄！`);
    }

    // 创建覆盖元素
    const overlay = document.createElement('div');
    overlay.id = id;
    overlay.className = this.overlayClass;
    overlay.textContent = translatedText;

    // 计算字体大小（基于原文平均字符宽度和翻译后字符数）
    const baseFontSize = this.calculateFontSizeForDialog(dialog, translatedText, safeBounds.width, cfg);
    const fontScale = this.getFontScale(imageElement);
    const fontSize = baseFontSize * fontScale;
    
    // 构建样式
    const bgWithOpacity = this.hexToRgba(cfg.background, cfg.backgroundOpacity);
    
    overlay.style.cssText = `
      position: absolute;
      left: ${left}%;
      top: ${top}%;
      width: ${width}%;
      height: ${height}%;
      font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;
      font-size: ${fontSize}px;
      line-height: 1.4;
      color: ${cfg.color};
      background: ${bgWithOpacity};
      padding: ${cfg.padding}px;
      margin: 0;
      text-shadow: 0 0 2px rgba(255, 255, 255, 0.8);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
      border-radius: 3px;
      word-break: break-all;
      overflow-wrap: break-word;
      white-space: pre-wrap;
      text-align: center;
      display: flex;
      align-items: center;
      justify-content: center;
      transform: translateZ(0);
      will-change: contents;
      z-index: 1;
      writing-mode: ${cfg.horizontalText ? 'horizontal-tb' : 'vertical-rl'};
      max-height: ${height}%;
      overflow: hidden;
    `;

    // 标记翻译失败
    if (dialog.translationSuccess === false) {
      overlay.style.border = '1px dashed #ff6666';
      overlay.title = '翻译失败，使用原文';
    }

    container.appendChild(overlay);

    // 记录覆盖层
    this.overlays.set(id, {
      id,
      originalBox: dialog.boundingBox,
      translatedText,
      element: overlay
    });

    return id;
  }

  /**
   * 批量渲染翻译后的对话
   */
  renderMergedDialogs(
    imageElement: HTMLImageElement,
    dialogs: MergedDialog[],
    config?: Partial<RenderConfig>
  ): string[] {
    // 调试日志：记录渲染时的图片信息
    console.log(`[Overlay] 🎯 renderMergedDialogs 开始: imageSrc=${imageElement?.src?.substring(0, 60)}, dialogs=${dialogs.length}`);
    
    // 记录图片尺寸
    this.imageBoundsMap.set(imageElement, {
      width: imageElement.naturalWidth,
      height: imageElement.naturalHeight
    });

    const ids: string[] = [];
    let skippedCount = 0;

    for (let i = 0; i < dialogs.length; i++) {
      const dialog = dialogs[i];
      if (dialog.translatedText || dialog.text) {
        const id = this.renderMergedDialog(imageElement, dialog, config);
        ids.push(id);
      } else {
        skippedCount++;
        console.warn(`[Overlay] 跳过渲染: [${dialog.id}] 无翻译文本, 原文: "${dialog.text.slice(0, 20)}"`);
      }
    }

    console.log(`[Overlay] ✅ 渲染完成: ${ids.length} 个覆盖层, 跳过 ${skippedCount} 个 (无翻译文本)`);
    
    // 输出所有覆盖层信息，方便定位
    if (ids.length > 0) {
      console.log(`[Overlay] 📍 所有覆盖层元素 ID:`, ids.map(id => `#${id}`));
    }

    return ids;
  }

  /**
   * 重新渲染所有覆盖层（已弃用旋转功能）
   */
  rerenderOverlays(imageElement: HTMLImageElement): void {
    console.log('[Overlay] rerenderOverlays 已弃用，旋转功能已移除');
  }

  /**
   * 计算字体大小
   */
  private calculateFontSize(
    boxWidth: number,
    config: Required<RenderConfig>
  ): number {
    // 基于宽度计算字体大小
    const estimatedCharWidth = config.fontSize;
    const charsPerLine = Math.floor(boxWidth / estimatedCharWidth);
    
    if (charsPerLine <= 0) {
      return config.fontSize;
    }
    
    // 确保字体不会太大
    return Math.min(config.fontSize, Math.max(10, boxWidth / charsPerLine * 0.8));
  }

  /**
   * 基于对话信息计算字体大小
   * 
   * 算法（v2）：
   * 1. 以用户保存的 baseFontSize 为基准（而非 OCR 原始字符宽度）
   * 2. 如果译文字符数多于原文，按比例缩小以适应气泡
   * 3. 确保字体大小在合理范围内（不低于10px，不高于 config.fontSize）
   */
  private calculateFontSizeForDialog(
    dialog: MergedDialog,
    translatedText: string,
    boxWidth: number,
    config: Required<RenderConfig>
  ): number {
    const translatedCharCount = translatedText.length;
    const ocrCharCount = dialog.charCount;
    const referenceSize = this.baseFontSize;

    // 如果翻译后字符增多，按比例缩小以保证文字能装进气泡
    if (translatedCharCount > ocrCharCount && ocrCharCount > 0) {
      const scaleFactor = Math.sqrt(ocrCharCount / translatedCharCount);
      const adjusted = referenceSize * scaleFactor;
      const finalFontSize = Math.max(10, adjusted);
      
      console.log(`[Overlay] 字体计算: baseFontSize=${referenceSize}px, 原文${ocrCharCount}字→译文${translatedCharCount}字, scale=${scaleFactor.toFixed(2)}, 最终=${finalFontSize.toFixed(1)}px`);
      return finalFontSize;
    }

    // 译文不长于原文，直接使用用户设置的基准字体大小
    console.log(`[Overlay] 字体计算: baseFontSize=${referenceSize}px, 原文${ocrCharCount}字→译文${translatedCharCount}字, 最终=${referenceSize}px`);
    return referenceSize;
  }

  /**
   * 将 hex 颜色转换为 rgba
   */
  private hexToRgba(hex: string, alpha: number): string {
    if (hex.startsWith('rgba') || hex.startsWith('rgb')) {
      return hex;
    }
    
    // 移除 # 号
    hex = hex.replace('#', '');
    
    // 解析 RGB
    let r: number, g: number, b: number;
    if (hex.length === 3) {
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
    } else if (hex.length === 6) {
      r = parseInt(hex.substr(0, 2), 16);
      g = parseInt(hex.substr(2, 2), 16);
      b = parseInt(hex.substr(4, 2), 16);
    } else {
      return `rgba(255, 255, 255, ${alpha})`;
    }
    
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  /**
   * 更新覆盖层样式
   */
  updateStyle(style: Partial<OverlayStyle>): void {
    const styleElement = document.getElementById('manga-lens-styles') || this.createStyleElement();
    
    const css = `
      .manga-lens-text-overlay {
        ${style.background ? `background: ${style.background};` : ''}
        ${style.color ? `color: ${style.color};` : ''}
        ${style.fontSize ? `font-size: ${style.fontSize}px;` : ''}
        ${style.opacity !== undefined ? `opacity: ${style.opacity};` : ''}
      }
    `;
    
    styleElement.textContent = css;
  }

  /**
   * 创建样式元素
   */
  private createStyleElement(): HTMLElement {
    const style = document.createElement('style');
    style.id = 'manga-lens-styles';
    style.textContent = '';
    document.head.appendChild(style);
    return style;
  }
}

export interface OverlayStyle {
  background?: string;
  color?: string;
  fontSize?: number;
  opacity?: number;
}

// 导出单例
export const overlayManager = new TranslationOverlayManager();
