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
import {
  computeAdaptiveFontSize,
  refineFontSizeByMeasurement,
  FONT_SIZE_ALGO_VERSION,
  DEFAULT_FONT_FIT_CONFIG
} from './font-fitter';

export interface TranslationOverlay {
  id: string;
  originalBox: BoundingBox;
  translatedText: string;
  element: HTMLElement;
}

/** 采集覆盖层几何时的最小尺寸（自然坐标），避免退化矩形导致 PSD 图层异常 */
const MIN_GEOMETRY_SIZE = 8;

export interface RenderConfig {
  /** 译文是否横排（原文通常是竖排） */
  horizontalText: boolean;
  /**
   * @deprecated 算法 v1 起字号由 font-fitter 自适应计算，不再通过渲染配置传入。
   * 该字段仅为向后兼容保留，传入无效。
   */
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

/**
 * 历史默认基础字号（px）
 *
 * 仅供「旧设置迁移」使用：早期版本存储用户字号为绝对值（mangaLensFontSize，
 * 默认 22px），算法 v1 起改为倍率（mangaLensFontScale），迁移时以该值作为
 * 1.0 倍的换算基准（22px → 100%）。
 */
const DEFAULT_BASE_FONT_SIZE = 22;

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

  /**
   * 全局字号缩放倍率（用户可在 popup 配置，持久化到 storage）
   *
   * 字号计算共三层，职责独立：
   *   1. 自适应基准字号：由 font-fitter 按每个气泡尺寸算出，决定相对大小（视觉分级）
   *   2. 全局缩放倍率（本字段）：对所有气泡等比缩放，1.0 = 100% 不改变自适应结果
   *   3. 图片级缩放：角标 ± 按钮，对单张图片内所有气泡缩放（仅当次会话）
   */
  private globalFontScale = 1.0;

  /** 全局缩放的可配置范围（0.5 ~ 1.6，即 50% ~ 160%） */
  private readonly minGlobalFontScale = 0.5;
  private readonly maxGlobalFontScale = 1.6;

  /** 可读下限（px）：自适应计算不得低于此值，宁可溢出也不牺牲可读性 */
  private minFontSize = 10;

  // 上次计算得到的基准字号（overlayId → px），用于字体缩放与全局字号变更时重算
  private baseFontSizeMap: Map<string, number> = new Map();

  /**
   * 已被用户手动调整过几何尺寸的对话 ID 集合
   *
   * 这些对话不再由系统添加溢出提示——用户已知意图，系统不与其对抗。
   */
  private manuallyAdjustedDialogs: Set<number> = new Set();

  // 每张图片的控制按钮
  private controlButtonMap: Map<HTMLImageElement, HTMLElement> = new Map();

  // 每张图片的"重新翻译"按钮（翻译失败时显示）
  private retranslateButtonMap: Map<HTMLImageElement, HTMLElement> = new Map();

  // 控制按钮的 position-updater（用于 scroll/resize 时重新计算 fixed 定位）
  private positionUpdaters: Array<() => void> = [];
  private scrollListenerBound = false;

  /**
   * "重新翻译"按钮点击回调（由 content-script 注入）
   * 参数为被点击的图片元素
   */
  onRetranslate: ((imageElement: HTMLImageElement) => void) | null = null;

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

    // 重新翻译按钮（翻译失败时显示，位于显示/隐藏按钮左侧）
    const retryBtn = document.createElement('button');
    retryBtn.className = 'ml-retranslate-btn';
    retryBtn.title = '重新翻译（跳过OCR，直接重发翻译请求）';
    retryBtn.innerHTML = '🔄'; // 重新翻译图标
    retryBtn.style.cssText = `
      background: rgba(255, 102, 102, 0.9);
      border: none;
      color: white;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      display: none;
      align-items: center;
      justify-content: center;
      box-shadow: 0 0 6px rgba(255, 0, 0, 0.6);
    `;
    retryBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (this.onRetranslate) {
        this.onRetranslate(imageElement);
      }
    });
    this.retranslateButtonMap.set(imageElement, retryBtn);

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

    // 组装 wrapper（重试按钮在最左，紧邻显示/隐藏按钮）
    wrapper.appendChild(retryBtn);
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
   * 设置全局字号缩放倍率（由 popup 设置界面触发）
   *
   * @param scale 倍率，1.0 = 100%（不改变自适应结果），范围 0.5 ~ 1.6
   */
  setGlobalFontScale(scale: number): void {
    this.globalFontScale = Math.max(
      this.minGlobalFontScale,
      Math.min(this.maxGlobalFontScale, scale)
    );
    console.log(
      `[Overlay] 全局字号缩放已更新: ${Math.round(this.globalFontScale * 100)}%`
    );
    // 立即应用到所有已渲染的覆盖层
    this.applyGlobalFontScaleToAllOverlays();
  }

  /** 获取当前全局字号缩放倍率（1.0 = 100%） */
  getGlobalFontScale(): number {
    return this.globalFontScale;
  }

  /**
   * 将「各覆盖层自身的自适应基准字号 × 全局缩放倍率 × 图片级缩放」应用到所有覆盖层
   *
   * 三层职责独立：自适应基准决定气泡间的相对大小（视觉分级），
   * 全局倍率做整体等比缩放，图片级缩放只影响单张图片。
   */
  private applyGlobalFontScaleToAllOverlays(): void {
    this.containers.forEach((container, imageElement) => {
      const imageScale = this.fontScaleMap.get(imageElement) || this.defaultFontScale;

      this.overlays.forEach((overlay) => {
        if (container.contains(overlay.element)) {
          const newFontSize = this.resolveFontSize(overlay);
          if (newFontSize > 0) {
            overlay.element.style.fontSize = `${newFontSize}px`;
          }
        }
      });
    });
    console.log(
      `[Overlay] 已更新所有覆盖层字体: 全局缩放=${Math.round(this.globalFontScale * 100)}%`
    );
  }

  /**
   * 计算某覆盖层当前应使用的字号
   *
   * = 自适应基准字号 × 全局缩放倍率 × 该图片的缩放系数，并受可读下限约束。
   * 若该覆盖层无自适应基准记录（例如来自旧缓存的异常数据），返回 0 表示不处理。
   */
  private resolveFontSize(overlay: TranslationOverlay): number {
    const base = this.baseFontSizeMap.get(overlay.id);
    if (base === undefined) return 0;

    // 图片级缩放系数：从覆盖层所属图片反查
    let imageScale = this.defaultFontScale;
    for (const [imgEl, container] of this.containers) {
      if (container.contains(overlay.element)) {
        imageScale = this.fontScaleMap.get(imgEl) || this.defaultFontScale;
        break;
      }
    }

    return Math.max(this.minFontSize, base * this.globalFontScale * imageScale);
  }

  /**
   * 从 chrome.storage.local 加载用户设置的全局字号缩放
   *
   * 兼容迁移：早期版本存储的是「基础字号 px」（mangaLensFontSize，22 为基准），
   * 若读取到该旧字段则按 px / 22 换算为倍率，避免用户设置丢失。
   */
  async loadSavedFontSize(): Promise<void> {
    try {
      const result = await chrome.storage.local.get([
        'mangaLensFontScale',
        'mangaLensFontSize'
      ]);

      if (result.mangaLensFontScale !== undefined) {
        this.globalFontScale = Math.max(
          this.minGlobalFontScale,
          Math.min(this.maxGlobalFontScale, result.mangaLensFontScale)
        );
        console.log(
          `[Overlay] 加载已保存字号缩放: ${Math.round(this.globalFontScale * 100)}%`
        );
        return;
      }

      // 旧字段迁移（px → 倍率）
      if (result.mangaLensFontSize !== undefined) {
        const legacyPx = Number(result.mangaLensFontSize);
        if (Number.isFinite(legacyPx) && legacyPx > 0) {
          this.globalFontScale = Math.max(
            this.minGlobalFontScale,
            Math.min(this.maxGlobalFontScale, legacyPx / DEFAULT_BASE_FONT_SIZE)
          );
          console.log(
            `[Overlay] 迁移旧字号设置 ${legacyPx}px → ${Math.round(this.globalFontScale * 100)}%`
          );
        }
      }
    } catch (e) {
      // 使用默认值 100%
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

    this.overlays.forEach((overlay) => {
      // 只更新属于该图片的覆盖层
      if (this.isOverlayBelongsToImage(overlay, imageElement)) {
        // 保留该覆盖层自适应算出的基准字号与全局缩放，仅叠加图片级缩放
        const newFontSize = this.resolveFontSize(overlay);
        if (newFontSize > 0) {
          overlay.element.style.fontSize = `${newFontSize}px`;
        }
      }
    });
    console.log(
      `[Overlay] 图片级缩放: ${Math.round(scale * 100)}% (自适应基准与全局缩放均保留)`
    );
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
    this.baseFontSizeMap.clear();

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
        // 同步清理该覆盖层缓存的基准字号，避免 Map 无限增长
        this.baseFontSizeMap.delete(id);
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
    
    // 🔧 如果用户已自定义位置/尺寸，使用用户保存的值
    if (dialog.customStyle) {
      if (dialog.customStyle.left !== undefined) left = parseFloat(dialog.customStyle.left);
      if (dialog.customStyle.top !== undefined) top = parseFloat(dialog.customStyle.top);
      if (dialog.customStyle.width !== undefined) width = parseFloat(dialog.customStyle.width);
      if (dialog.customStyle.height !== undefined) height = parseFloat(dialog.customStyle.height);
    }

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
    overlay.dataset.dialogId = String(dialog.id); // 关联 MergedDialog，用于持久化单覆盖层字体大小
    // 记录纯译文，供溢出复检时判断内容（避免角标等子元素文字干扰）
    overlay.dataset.mlPlainText = translatedText;

    // 计算字体大小（算法 v1：几何适配 + 视觉分级）
    // 🔧 如果用户保存了自定义字体大小，优先使用（用户手动值覆盖所有自动计算）
    let fontSize: number;
    let baseFontSize: number;
    let fitOverflow = false;
    let fitOverflowRatio = 0;

    if (dialog.customFontSize) {
      fontSize = dialog.customFontSize;
      baseFontSize = dialog.customFontSize;
    } else {
      // 可用区域 = 覆盖层实际像素尺寸（已扣除内边距）
      const padding = cfg.padding * 2;
      const fit = this.calculateFontSizeForDialog(
        dialog,
        translatedText,
        Math.max(1, pixelWidth - padding),
        Math.max(1, pixelHeight - padding),
        isVertical,
        cfg
      );
      baseFontSize = fit.fontSize;
      fitOverflow = fit.overflow;
      fitOverflowRatio = fit.overflowRatio;
      // 叠加全局缩放倍率与图片级缩放系数（受可读下限约束）
      const fontScale = this.getFontScale(imageElement);
      fontSize = Math.max(
        this.minFontSize,
        baseFontSize * this.globalFontScale * fontScale
      );
    }
    // 缓存基准字号，供字体缩放/全局字号变更时重算
    this.baseFontSizeMap.set(id, baseFontSize);
    
    // 构建样式
    // 🔧 支持单覆盖层自定义透明度：dialog.customOpacity > cfg.backgroundOpacity（全局默认）
    const effectiveOpacity = dialog.customOpacity ?? cfg.backgroundOpacity;
    const bgWithOpacity = this.hexToRgba(cfg.background, effectiveOpacity);
    
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

    // 🔧 迭代收敛：元素入 DOM 后，以浏览器真实排版为准精修字号
    //
    //    触发条件：仅当「自适应基准」未被用户缩放干预时（全局 100% 且图片级 100%）。
    //    原因：用户调大缩放的目的就是"字大一点，哪怕略微溢出"，此时若仍做迭代收敛，
    //         算法会把字号压回"刚好装下"，反而抹掉用户意图。因此用户一旦调整过
    //         缩放，就直接采用公式解 × 缩放，不做二次修正。
    const imageFontScale = this.getFontScale(imageElement) || 1;
    const scaleUntouched =
      Math.abs(this.globalFontScale - 1) < 0.001 && Math.abs(imageFontScale - 1) < 0.001;

    if (!dialog.customFontSize && scaleUntouched) {
      const padding = cfg.padding * 2;
      const refined = refineFontSizeByMeasurement(
        translatedText,
        overlay,
        Math.max(1, pixelWidth - padding),
        Math.max(1, pixelHeight - padding),
        fontSize,
        this.minFontSize,
        DEFAULT_FONT_FIT_CONFIG.maxFontSize
      );

      if (Math.abs(refined.fontSize - fontSize) > 0.5) {
        fontSize = refined.fontSize;
        // 此时缩放均为 1.0，收敛结果即自适应基准字号
        baseFontSize = fontSize;
        this.baseFontSizeMap.set(id, baseFontSize);
        overlay.style.fontSize = `${fontSize}px`;
      }
      fitOverflow = refined.overflow;
      fitOverflowRatio = refined.overflowRatio;
    } else if (!dialog.customFontSize) {
      // 用户已调整缩放：不做迭代修正，仅按公式解判定溢出状态（用于提示）
      const padding = cfg.padding * 2;
      const probe = refineFontSizeByMeasurement(
        translatedText,
        overlay,
        Math.max(1, pixelWidth - padding),
        Math.max(1, pixelHeight - padding),
        fontSize,
        this.minFontSize,
        DEFAULT_FONT_FIT_CONFIG.maxFontSize
      );
      fitOverflow = probe.overflow;
      fitOverflowRatio = probe.overflowRatio;
    }

    // 标记溢出：即使压到可读下限仍装不下，提示用户手动调整（不自动改框）
    // 🔧 例外：用户已手动调整过该对话的尺寸/位置，或已手动设定字号时，
    //    不再添加提示——尊重用户已知意图，避免标记无法消除。
    const userHandled = this.manuallyAdjustedDialogs.has(dialog.id) || !!dialog.customFontSize;
    if (fitOverflow && !userHandled) {
      this.markOverflow(overlay, fitOverflowRatio);
    }

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
   * 标记覆盖层溢出
   *
   * 设计约定：不自动扩大文本框（避免用户失去原始位置参考），
   * 而是用视觉提示（角标 + tooltip + 描边）告知用户需要手动调整。
   */
  private markOverflow(overlay: HTMLElement, overflowRatio: number): void {
    if (overlay.dataset.mlOverflow === '1') return;
    overlay.dataset.mlOverflow = '1';

    const severity = overflowRatio > 0.5 ? '明显' : '轻微';
    // 🔧 用 box-shadow 而非 outline 表达溢出描边：
    //    PDF 编辑模式会给覆盖层加蓝色 outline（不会触及 box-shadow），
    //    退出编辑时又会把 outline 清空。若溢出提示也用 outline 会被覆盖或清除。
    overlay.style.boxShadow =
      '0 0 0 1px #ffb84d, 0 1px 3px rgba(0, 0, 0, 0.15)';
    overlay.title = `译文${severity}超出气泡范围，可进入 PDF 导出模式拖拽放大文本框`;

    // 右上角角标：圆形底 + 放大图标（与现有按钮风格统一）
    const badge = document.createElement('span');
    badge.className = 'ml-overflow-badge';
    badge.textContent = '⤢';
    badge.style.cssText = `
      position: absolute;
      top: -9px;
      right: -9px;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: rgba(255, 152, 0, 0.92);
      color: #fff;
      font-size: 10px;
      line-height: 16px;
      text-align: center;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
      pointer-events: none;
      z-index: 2;
    `;
    // 覆盖层自身为 flex 布局，角标需绝对定位，挂到 overlay 上
    overlay.appendChild(badge);
  }

  /**
   * 清除覆盖层的溢出标记（角标 + 描边 + tooltip）
   *
   * 用于用户在 PDF 模式下手动放大文本框后，溢出已解决时即时撤下提示。
   */
  private clearOverflowMark(overlay: HTMLElement): void {
    // 不依赖 dataset 标记：即使标记缺失也要清理残留的角标，确保撤下干净
    delete overlay.dataset.mlOverflow;

    overlay.querySelectorAll('.ml-overflow-badge').forEach((b) => b.remove());
    // 恢复基础投影（与渲染时的初始 box-shadow 一致）
    overlay.style.boxShadow = '0 1px 3px rgba(0, 0, 0, 0.15)';
    // 若 tooltip 是本模块写入的溢出提示才清除，避免误删翻译失败提示
    if (overlay.title && overlay.title.includes('超出气泡范围')) {
      overlay.title = '';
    }
  }

  /**
   * 用户手动调整覆盖层几何尺寸后的处理（供 PDF 编辑模式调用）
   *
   * 设计决策：**不做溢出复检，直接撤下溢出提示。**
   *
   * 理由：用户手动调整即代表其已知意图，系统无需再评判结果。
   * 若调整为「故意很小的文本框」，复检会导致标记永远无法消除，
   * 与用户意图对抗。因此一律清除提示，并把该覆盖层标记为「已人工处理」，
   * 后续渲染也不再为其添加溢出标记。
   */
  handleManualGeometryChange(overlay: HTMLElement): void {
    this.clearOverflowMark(overlay);
    // 记录人工处理过，避免后续（如重新渲染）再次打上提示
    if (overlay.dataset.dialogId !== undefined) {
      this.manuallyAdjustedDialogs.add(Number(overlay.dataset.dialogId));
    }
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

    // 根据是否存在翻译失败的对话，显示/隐藏"重新翻译"按钮
    if (this.hasFailedDialog(dialogs)) {
      this.showRetranslateButton(imageElement);
    } else {
      this.hideRetranslateButton(imageElement);
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
   * 推算原文的实际字符高度（像素，OCR 坐标系）
   *
   * 竖排文字：字符逐个沿 Y 轴堆叠，因此「字符高度」≈ 单个片段的宽度
   * 横排文字：字符沿 X 轴排列，因此「字符高度」≈ 单个片段的高度
   *
   * 取各片段的中位数，避免个别异常片段（如被合并的长行）拉偏结果。
   */
  private estimateOriginalCharHeight(dialog: MergedDialog, isVertical: boolean): number | undefined {
    const items = dialog.items;
    if (!items || items.length === 0) return undefined;

    const sizes: number[] = [];
    for (const item of items) {
      const v = isVertical ? item.width : item.height;
      if (v && v > 0) sizes.push(v);
    }
    if (sizes.length === 0) return undefined;

    sizes.sort((a, b) => a - b);
    const mid = Math.floor(sizes.length / 2);
    const median = sizes.length % 2 === 0 ? (sizes[mid - 1] + sizes[mid]) / 2 : sizes[mid];
    return median > 0 ? median : undefined;
  }

  /**
   * 计算单条对话的自适应字号（算法 v1）
   *
   * 设计（详见 modules/font-fitter.ts）：
   * 1. 几何适配：按框宽高与译文字符数推导「刚好填满」的字号
   * 2. 视觉分级：参考原文实际字符高度，保留原文的大小对比（拟声词大、小字说明小）
   * 3. 可读下限：字号不得低于 minFontSize，宁可溢出也不牺牲可读性
   * 4. 迭代收敛：由调用方（renderMergedDialog）在元素入 DOM 后基于真实测量精修
   *
   * 注意：本方法返回的是「基准字号」，不含用户对该图片的缩放系数（fontScale）。
   */
  private calculateFontSizeForDialog(
    dialog: MergedDialog,
    translatedText: string,
    boxWidth: number,
    boxHeight: number,
    isVertical: boolean,
    _config: Required<RenderConfig>
  ): { fontSize: number; overflow: boolean; overflowRatio: number } {
    const originalCharHeight = this.estimateOriginalCharHeight(dialog, isVertical);

    const result = computeAdaptiveFontSize(translatedText, {
      boxWidth,
      boxHeight,
      isVertical,
      lineHeight: DEFAULT_FONT_FIT_CONFIG.lineHeight,
      fillRatio: DEFAULT_FONT_FIT_CONFIG.fillRatio,
      minFontSize: this.minFontSize,
      maxFontSize: DEFAULT_FONT_FIT_CONFIG.maxFontSize,
      originalCharHeight,
      originalWeight: DEFAULT_FONT_FIT_CONFIG.originalWeight
    });

    console.log(
      `[Overlay] 字体自适应: 框=${boxWidth.toFixed(0)}x${boxHeight.toFixed(0)}, ` +
      `译文${translatedText.length}字, 原文高=${originalCharHeight?.toFixed(1) ?? 'N/A'}, ` +
      `策略=${result.strategy}, 字号=${result.fontSize.toFixed(1)}px` +
      (result.overflow ? ` ⚠️溢出(${(result.overflowRatio * 100).toFixed(0)}%)` : '')
    );

    return {
      fontSize: result.fontSize,
      overflow: result.overflow,
      overflowRatio: result.overflowRatio
    };
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

  // ============================================
  // PDF导出模块集成方法
  // ============================================

  /** 获取指定图片的所有覆盖层DOM元素 */
  getOverlaysForImage(imageElement: HTMLImageElement): HTMLElement[] {
    const container = this.containers.get(imageElement);
    if (!container) return [];

    const result: HTMLElement[] = [];
    this.overlays.forEach((overlay) => {
      if (container.contains(overlay.element)) {
        result.push(overlay.element);
      }
    });
    return result;
  }

  /** 获取所有已翻译图片元素 */
  getAllTranslatedImages(): HTMLImageElement[] {
    return Array.from(this.containers.keys());
  }

  /** 获取指定图片的覆盖层容器元素 */
  getContainerForImage(imageElement: HTMLImageElement): HTMLElement | undefined {
    return this.containers.get(imageElement);
  }

  /**
   * 采集指定图片上所有覆盖层的「图片自然坐标」几何数据
   *
   * 为什么需要它：
   *   customStyle 里存的是 overlay 的 CSS 百分比，其基准是**覆盖层容器**
   *   而非图片，且容器尺寸通常远大于图片（实测可达 3.3 倍）。
   *   直接用这些百分比乘图片自然尺寸，会把缩放系数一并算进去，
   *   导致导出的底衬/文本框整体放大（严重时铺满画布）。
   *
   *   因此本方法按「container 尺寸 → 图片布局尺寸 → 图片自然尺寸」
   *   三级换算，显式扣除容器缩放与图片偏移，得到与页面所见一致的几何。
   *
   * @returns Map<dialogId, 自然坐标几何>
   */
  collectOverlayGeometry(
    imageElement: HTMLImageElement
  ): Map<number, { left: number; top: number; width: number; height: number; fontSize: number }> {
    const result = new Map<
      number,
      { left: number; top: number; width: number; height: number; fontSize: number }
    >();

    const container = this.containers.get(imageElement);
    if (!container) return result;

    const naturalWidth = imageElement.naturalWidth || imageElement.width;
    const naturalHeight = imageElement.naturalHeight || imageElement.height;
    if (!naturalWidth || !naturalHeight) return result;

    /**
     * ⚠️ 换算基准
     *
     * 覆盖层的 left/top/width/height 是**百分比**，按 CSS 规范相对
     * container 的**尺寸**解析。而 container 通过 width:100%;height:100%
     * 铺满 parent，其尺寸通常 ≠ 图片尺寸（实测 container 可比图片宽 3.3 倍，
     * 这正是此前底衬被撑大的直接原因）。
     *
     * 因此换算必须分两步：
     *   ① 百分比 × container 尺寸 → 得到「container 坐标系」的布局像素
     *   ② 再按 (图片自然尺寸 / 图片在 container 中的布局尺寸) 换算到自然坐标
     *
     * 步骤 ② 的关键是「图片在 container 中的布局尺寸」，用图片自身的
     * clientWidth（布局宽，不受 transform 影响）即可。
     */
    const containerWidth = container.clientWidth || container.offsetWidth;
    const containerHeight = container.clientHeight || container.offsetHeight;
    if (!containerWidth || !containerHeight) return result;

    // 图片的布局尺寸（布局坐标，非视觉变换后的尺寸）
    const imgLayoutWidth = imageElement.clientWidth || imageElement.offsetWidth;
    const imgLayoutHeight = imageElement.clientHeight || imageElement.offsetHeight;
    if (!imgLayoutWidth || !imgLayoutHeight) return result;

    // 布局像素 → 自然像素 的比例
    const naturalPerLayoutX = naturalWidth / imgLayoutWidth;
    const naturalPerLayoutY = naturalHeight / imgLayoutHeight;

    // 图片左上角在 container 布局坐标系中的位置
    // （container 与 img 同为 parent 的子元素，用 rect 差值最直观；
    //   若图片处于 transform 空间，两者 rect 同步缩放，差值仍然有效）
    const imgRect = imageElement.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    // rect 差值处于「视觉坐标」，除以视觉/布局比得到布局坐标
    const visualToLayoutX = containerWidth / (containerRect.width || containerWidth);
    const visualToLayoutY = containerHeight / (containerRect.height || containerHeight);
    const imgOffsetXLayout = (imgRect.left - containerRect.left) * visualToLayoutX;
    const imgOffsetYLayout = (imgRect.top - containerRect.top) * visualToLayoutY;

    this.overlays.forEach((overlay) => {
      if (!container.contains(overlay.element)) return;

      const el = overlay.element;
      const dialogId = Number(el.dataset.dialogId);
      if (!Number.isFinite(dialogId)) return;

      // 解析覆盖层的百分比定位（CSS 规范：相对 container 尺寸）
      const st = el.style;
      const pct = (v: string | undefined): number => {
        if (!v) return NaN;
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : NaN;
      };

      const pctLeft = pct(st.left);
      const pctTop = pct(st.top);
      const pctWidth = pct(st.width);
      const pctHeight = pct(st.height);

      // 位置用 left/top，尺寸用 width/height；任一缺失则跳过
      if (![pctLeft, pctTop, pctWidth, pctHeight].every(Number.isFinite)) return;

      // ① container 坐标系下的布局像素
      const layoutLeft = (pctLeft / 100) * containerWidth;
      const layoutTop = (pctTop / 100) * containerHeight;
      const layoutWidth = (pctWidth / 100) * containerWidth;
      const layoutHeight = (pctHeight / 100) * containerHeight;

      // ② 相对图片左上角，并换算到自然坐标
      const left = (layoutLeft - imgOffsetXLayout) * naturalPerLayoutX;
      const top = (layoutTop - imgOffsetYLayout) * naturalPerLayoutY;
      const width = layoutWidth * naturalPerLayoutX;
      const height = layoutHeight * naturalPerLayoutY;

      // 字号：CSS 字号是布局坐标下的值，按同一比例换算
      const cssFontSize = parseFloat(getComputedStyle(el).fontSize);
      const fontSize =
        Number.isFinite(cssFontSize) && cssFontSize > 0
          ? cssFontSize * naturalPerLayoutX
          : 0;

      // 后写入者覆盖前者（同一 dialogId 理论上只有一个覆盖层）
      result.set(dialogId, {
        left: Math.max(0, left),
        top: Math.max(0, top),
        width: Math.max(MIN_GEOMETRY_SIZE, width),
        height: Math.max(MIN_GEOMETRY_SIZE, height),
        fontSize,
      });
    });

    return result;
  }

  /** 显示指定图片的"重新翻译"按钮 */
  showRetranslateButton(imageElement: HTMLImageElement): void {
    const btn = this.retranslateButtonMap.get(imageElement);
    if (btn) {
      btn.style.display = 'flex';
    }
  }

  /** 隐藏指定图片的"重新翻译"按钮 */
  hideRetranslateButton(imageElement: HTMLImageElement): void {
    const btn = this.retranslateButtonMap.get(imageElement);
    if (btn) {
      btn.style.display = 'none';
    }
  }

  /** 判断指定图片是否翻译失败（存在 translationSuccess === false 的对话） */
  private hasFailedDialog(dialogs: MergedDialog[]): boolean {
    return dialogs.some((d) => d.translationSuccess === false);
  }

  /** 重新渲染指定图片的翻译（从缓存的MergedDialog数据恢复原版） */
  rerenderFromCache(imageElement: HTMLImageElement, dialogs: any[]): void {
    this.removeOverlaysForImage(imageElement);
    this.renderMergedDialogs(imageElement, dialogs, {
      horizontalText: false,
      background: '#FFFFFF',
      backgroundOpacity: 0.88,
      padding: 4
    });
  }

  /** 收集当前所有覆盖层的快照数据（位置+文字+样式） */
  collectOverlaySnapshots(imageElement: HTMLImageElement): OverlaySnapshot[] {
    const container = this.containers.get(imageElement);
    if (!container) return [];

    const snapshots: OverlaySnapshot[] = [];
    this.overlays.forEach((overlay) => {
      if (container.contains(overlay.element)) {
        const style = overlay.element.style;
        snapshots.push({
          id: overlay.id,
          text: overlay.element.textContent || '',
          left: style.left,
          top: style.top,
          width: style.width,
          height: style.height,
          fontSize: style.fontSize,
          writingMode: style.writingMode,
        });
      }
    });
    return snapshots;
  }
}

/** 覆盖层快照（用于持久化用户编辑） */
export interface OverlaySnapshot {
  id: string;
  text: string;
  left: string;
  top: string;
  width: string;
  height: string;
  fontSize: string;
  writingMode: string;
}

export interface OverlayStyle {
  background?: string;
  color?: string;
  fontSize?: number;
  opacity?: number;
}

// 导出单例
export const overlayManager = new TranslationOverlayManager();
