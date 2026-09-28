/**
 * PSD 导出模块 - MangaLens
 *
 * 目标：把「当前页面中已翻译图片」的译文导出为 Photoshop 可编辑的 PSD。
 *
 * 设计要点：
 * 1. 数据源是「当前页面已翻译的图片」(`getTranslatedImages()`)，而非本地缓存全量条目 ——
 *    缓存里可能残留大量历史条目，导出它们既慢又无意义。
 * 2. 每个译文气泡导出为一个独立的**文字图层**（段落框 + 可编辑文字），
 *    用户可在 PS 中自由改文字、改字号、拖动/缩放文本框。
 * 3. 背景色块（译文底衬）导出为独立的**纯色矩形图层**，通过图层不透明度表达
 *    用户设定的透明度。
 * 4. 竖排/横排由 `MergedDialog.isVertical` 决定，映射到 ag-psd 的
 *    `orientation: 'vertical' | 'horizontal'`。
 * 5. 原图作为最底层「原图」图层一并导出，用户打开 PSD 即可看到完整效果，
 *    无需再手动拖入图片；若原图跨域受限（canvas 被污染）则自动省略该层。
 *
 * 关于 ag-psd 的竖排支持（已用 Adobe Photoshop 实测验证）：
 *   它写出的 TySh 描述符 `Ornt=Vrtc` 与 EngineData 的
 *   `WritingDirection=2` / `Procession=1` 与 Adobe 原生输出一致，
 *   在 Photoshop 中可正常竖排、可编辑、可拖动缩放文本框。
 */

import { writePsd } from 'ag-psd';
import type { MergedDialog } from './dialog-merger';

// ============================================
// 常量
// ============================================

/** PSD 中记录的字体（PostScript 名）。中文/日文/英文混排均可显示 */
const PSD_FONT_NAME = 'MicrosoftYaHei';

/** 默认背景色块透明度（与覆盖层全局默认一致） */
const DEFAULT_BG_OPACITY = 0.88;

/** 文本框相对气泡的内边距（与原图坐标系同单位） */
const BUBBLE_PADDING = 4;

/** 最小文本框尺寸，避免退化文本框导致 PS 报错 */
const MIN_BOX_SIZE = 8;

/**
 * 记录「图片显示尺寸 → 自然尺寸」的换算比例
 *
 * 网页端覆盖层工作在「图片显示坐标」下（图片常被 CSS 缩小显示），
 * 而 PSD 画布使用「图片自然尺寸」。因此凡是从网页端继承来的
 * 像素值（如 customFontSize），都必须乘以本比例才能落到正确大小。
 *
 * 由 content-script 在导出前逐张图片调用 setDisplayToNaturalScale() 填入。
 */
let displayToNaturalScale = 1;

/** 设置当前导出图片的「显示→自然」换算比例（供字号换算使用） */
export function setDisplayToNaturalScale(scale: number): void {
  displayToNaturalScale = scale > 0 && Number.isFinite(scale) ? scale : 1;
}

/** 读取当前换算比例 */
function getDisplayToNaturalScale(): number {
  return displayToNaturalScale;
}

/**
 * 覆盖层在图片自然坐标下的几何数据
 *
 * 这是**权威来源** —— 直接量自 DOM，绕开 customStyle 里
 * 百分比基准不一致的问题（详见 resolveOverlayGeometryAtPage 注释）。
 */
export interface OverlayDomGeometry {
  /** 相对图片左上角的自然坐标 */
  left: number;
  top: number;
  width: number;
  height: number;
  /** 字号（自然坐标） */
  fontSize: number;
}

/**
 * 按 dialogId 索引的 DOM 几何映射
 *
 * key 为 MergedDialog.id，由 content-script 在导出前采集。
 */
let overlayGeometryMap: Map<number, OverlayDomGeometry> = new Map();

/** 设置本次导出的覆盖层 DOM 几何数据 */
export function setOverlayGeometry(map: Map<number, OverlayDomGeometry>): void {
  overlayGeometryMap = map instanceof Map ? map : new Map();
}

/** 读取指定 dialog 的 DOM 几何（无则不返回） */
function getOverlayGeometry(dialogId: number): OverlayDomGeometry | undefined {
  return overlayGeometryMap.get(dialogId);
}

// ============================================
// 类型
// ============================================

export interface PsdExportTarget {
  /** 图片 URL */
  imageSrc: string;
  /** 已加载的图片元素（用于读取自然尺寸） */
  imageElement: HTMLImageElement;
  /** 该图片的译文数据 */
  dialogs: MergedDialog[];
}

export interface PsdExportCallbacks {
  /** 获取当前页面中已翻译的图片元素 */
  getTranslatedImages: () => HTMLImageElement[];
  /** 读取指定图片的缓存译文 */
  getCachedDialogsForImage: (imageSrc: string) => Promise<MergedDialog[] | null>;
  /**
   * 采集指定图片上覆盖层的实测几何（可选）
   *
   * 由 content-script 实现：读取覆盖层在页面上的真实矩形，
   * 换算为图片自然坐标后通过 setOverlayGeometry() 注入本模块。
   */
  prepareGeometry?: (imageElement: HTMLImageElement) => void;
  /** 下载生成的 PSD */
  downloadPsd: (blob: Blob, filename: string) => void;
  /** 进度回调（current 从 1 开始） */
  onProgress?: (current: number, total: number, label: string) => void;
}

// ============================================
// 工具函数
// ============================================

/**
 * 解析百分比字符串为像素值
 *
 * `customStyle` 中存的是形如 '12.5%' 的字符串（相对图片尺寸），
 * PSD 需要绝对像素坐标，因此乘以图片对应边的尺寸。
 */
function percentToPx(value: string | undefined, base: number, fallback: number): number {
  if (value === undefined) return fallback;
  const n = parseFloat(value);
  if (isNaN(n)) return fallback;
  // 带 % 的按百分比换算，不带 % 的视为已是像素
  return value.includes('%') ? (n / 100) * base : n;
}

/** 十六进制颜色 → PSD 的 RGB 分量（0-255） */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 255, g: 255, b: 255 };
  const v = parseInt(m[1], 16);
  return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
}

/**
 * 把百分比字符串规范化，供 ag-psd 的 text 图层使用
 * ag-psd 接受 `{ top, left, bottom, right }` 的绝对坐标（相对图层）
 */
function normalizeBox(v: number): number {
  return Math.max(0, Math.round(v));
}

/**
 * 格式化时间戳为文件名/文件夹名（本地时间）
 *
 * 输出 `YYYY-MM-DD-HH-mm-ss`，例如 `2026-09-28-10-45-12`。
 * 不使用 toISOString()：那是 UTC 时间，与用户本地时间对不上；
 * 同时冒号、空格等字符在 Windows 文件名中非法，统一替换为短横线。
 */
function formatTimestamp(d: Date): string {
  const p = (n: number, len = 2) => String(n).padStart(len, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
  );
}

/**
 * 构造 ag-psd 的 bounds / boundingBox 结构
 *
 * ag-psd 要求每个分量是 { units, value } 形式的带单位值
 * （见 descriptor.js 的 unitsValue），直接传数字会抛错。
 */
function pxBounds(
  left: number,
  top: number,
  right: number,
  bottom: number
): { left: { units: 'Pixels'; value: number }; top: { units: 'Pixels'; value: number }; right: { units: 'Pixels'; value: number }; bottom: { units: 'Pixels'; value: number } } {
  const px = (value: number) => ({ units: 'Pixels' as const, value: Math.round(value) });
  return { left: px(left), top: px(top), right: px(right), bottom: px(bottom) };
}

// ============================================
// 核心：MergedDialog[] → ag-psd 图层
// ============================================

interface BuildOptions {
  /** 图片自然宽度 */
  imageWidth: number;
  /** 图片自然高度 */
  imageHeight: number;
}

/**
 * 把一个 MergedDialog 转换为「背景色块图层 + 文字图层」
 *
 * 坐标说明：
 * - `boundingBox` 是原图坐标系下的气泡范围
 * - `customStyle` 若存在，则是用户手动调整后的百分比（相对图片），优先级最高
 * - 文字图层使用段落框（shapeType: 'box'），框内边距由 BUBBLE_PADDING 控制
 */
function buildLayersForDialog(
  dialog: MergedDialog,
  opts: BuildOptions
): any[] {
  const { imageWidth, imageHeight } = opts;

  const translated = (dialog.translatedText || '').trim();
  // 翻译失败或空译文的条目不导出（与原页面覆盖层行为保持一致）
  if (!translated || dialog.translationSuccess === false) return [];

  const bb = dialog.boundingBox;

  // ── 1. 计算气泡在图片自然坐标系下的范围 ──
  //
  // 优先级（从高到低）：
  //   ① DOM 实测几何 —— 覆盖层元素在页面上的真实位置，直接量取，
  //      最可靠，且能同时反映「用户拖动」与「自动排版」的结果。
  //   ② boundingBox —— OCR 原始坐标，本来就是图片自然坐标，直接可用。
  //
  // ⚠️ 为什么不再用 customStyle：
  //   customStyle 存的是 overlay.element.style.left/top/width/height，
  //   而这些百分比的**基准是覆盖层容器，不是图片**，且 left/top 还包含
  //   「图片在容器内的偏移量」（translation-overlay.ts 中：
  //   left = (offsetX + pixelLeft) / containerWidth * 100）。
  //   直接把它当成「相对图片的百分比」再乘 naturalWidth，
  //   会把容器偏移一并算进去，导致文本框整体偏移到错误位置。
  const domGeo = getOverlayGeometry(dialog.id);
  let bubbleLeft: number;
  let bubbleTop: number;
  let bubbleWidth: number;
  let bubbleHeight: number;

  if (domGeo) {
    bubbleLeft = domGeo.left;
    bubbleTop = domGeo.top;
    bubbleWidth = domGeo.width;
    bubbleHeight = domGeo.height;
  } else {
    bubbleLeft = bb.x;
    bubbleTop = bb.y;
    bubbleWidth = bb.width;
    bubbleHeight = bb.height;
  }

  // 文字框 = 气泡范围向内收内边距
  const textLeft = normalizeBox(bubbleLeft + BUBBLE_PADDING);
  const textTop = normalizeBox(bubbleTop + BUBBLE_PADDING);
  const textRight = normalizeBox(bubbleLeft + bubbleWidth - BUBBLE_PADDING);
  const textBottom = normalizeBox(bubbleTop + bubbleHeight - BUBBLE_PADDING);

  const boxWidth = Math.max(MIN_BOX_SIZE, textRight - textLeft);
  const boxHeight = Math.max(MIN_BOX_SIZE, textBottom - textTop);

  // ── 2. 方向（须在字号估算之前确定，字号公式会用到）──
  const isVertical = dialog.isVertical === true;

  // ── 3. 字号 ──
  // 优先使用用户手动设定的字号；否则按「文本能否放进框内」估算。
  //
  // 估算思路：把框内的可用字符槽位（列数 × 每列字数）与译文长度比较，
  // 两者应大致相等。列/行数由框的宽高比与文字方向决定。
  //
  //   横排：每行字数 ≈ 框宽 / 字号，行数 ≈ 框高 / 行高(1.3×字号)
  //   竖排：每列字数 ≈ 框高 / 字号，列数 ≈ 框宽 / 行宽(1.3×字号)
  //
  // 设 字号 = s，容量 ≈ (可用主轴长度 / s) × (可用交叉轴长度 / (1.3s))
  //            = 主轴 × 交叉轴 / (1.3 s²)
  // 令容量 = 字数 n，解得 s = sqrt(主轴 × 交叉轴 / (1.3 n))
  //
  // 注：本式中主轴/交叉轴长度对调不影响乘积，故横竖排共用同一公式；
  //     保留分支只为将来按方向做差异化系数。
  //
  // ⚠️ 坐标系：boxWidth/boxHeight 是「图片自然坐标」下的像素，
  //    因此算出的字号也是自然坐标下的字号 —— 与 PSD 画布尺寸一致，正确。
  let autoFontSize: number;
  if (isVertical) {
    autoFontSize = Math.sqrt((boxHeight * boxWidth) / (1.3 * Math.max(1, translated.length)));
  } else {
    autoFontSize = Math.sqrt((boxWidth * boxHeight) / (1.3 * Math.max(1, translated.length)));
  }
  // 夹在合理区间：不小于 6px（再小没有可读性），不大于框的短边（避免单字溢出）
  const shortSide = Math.min(boxWidth, boxHeight);
  autoFontSize = Math.max(6, Math.min(autoFontSize, Math.max(8, shortSide * 0.8)));

  /**
   * 用户手动字号的坐标换算
   *
   * customFontSize 由网页端覆盖层写入，其单位是「CSS 像素」，
   * 而覆盖层所处坐标系是「图片显示坐标」（图片被缩放后）。
   * 换算到自然坐标需乘以 (naturalSize / displayedSize)。
   *
   * 例：图片 1357px 宽被显示为 813px（scale≈0.6），
   *     用户在页面上设 20px → PSD 画布（1357px）中应为 20/0.6 ≈ 33px。
   */
  const customFontSizeScaled = dialog.customFontSize
    ? dialog.customFontSize * getDisplayToNaturalScale()
    : 0;
  const fontSize = customFontSizeScaled || autoFontSize;

  // ── 4. 背景色块图层（纯色矩形）──
  const bgOpacity = dialog.customOpacity !== undefined && dialog.customOpacity !== null
    ? dialog.customOpacity
    : DEFAULT_BG_OPACITY;

  const bgCanvas = document.createElement('canvas');
  bgCanvas.width = Math.max(1, Math.round(bubbleWidth));
  bgCanvas.height = Math.max(1, Math.round(bubbleHeight));
  const bgCtx = bgCanvas.getContext('2d');
  if (bgCtx) {
    bgCtx.fillStyle = '#ffffff';
    bgCtx.fillRect(0, 0, bgCanvas.width, bgCanvas.height);

    /**
     * ⚠️⚠️ 必须保留至少一个透明像素！
     *
     * ag-psd 依据 hasAlpha(imageData) 决定是否写入透明通道：
     *
     *   helpers.js: hasAlpha(data) {
     *     for (每个像素) if (alpha !== 255) return true;
     *     return false;         // 全不透明 → 不写透明通道
     *   }
     *
     * 底衬是纯白完全不透明的 canvas，若整层无任何透明像素，
     * ag-psd 就**不会写透明通道**。缺少透明通道的图层在 Photoshop 中
     * 无法表达「哪里是空的」，PS 只能按不透明实色处理，
     * 表现为该图层被撑满整个画布（曾导致导出结果整片白色）。
     *
     * 清空右下角 1×1 像素即可确保 hasAlpha() 返回 true，
     * 对视觉效果无任何影响（该像素本就位于色块边缘）。
     */
    if (bgCanvas.width > 1 && bgCanvas.height > 1) {
      bgCtx.clearRect(bgCanvas.width - 1, bgCanvas.height - 1, 1, 1);
    }
  }

  const layers: any[] = [];

  // ⚠️ PSD 图层顺序（实测校正）：
  //    ag-psd 中 children 数组的**靠后元素在上层**。
  //    因此先 push 底衬（在下），再 push 文字（在上），
  //    否则底衬会盖住文字，PS 里只能看到白色色块、看不到字。
  //
  // ── 背景色块图层（下层）──
  layers.push({
    name: `底衬_${dialog.id}`,
    canvas: bgCanvas,
    left: Math.round(bubbleLeft),
    top: Math.round(bubbleTop),
    opacity: Math.round(bgOpacity * 255) / 255,
  });

  // ── 文字图层（上层）──
  //
  // ⚠️⚠️ 关键：文字层必须带一个**全透明的占位 canvas**！
  //
  //   原因（读 ag-psd 源码得出）：
  //     psdWriter.js 的 getLayerDimentions() 只从 canvas/imageData 读取宽高，
  //     完全不看 left/top/right/bottom。若文字层没有 canvas，
  //     图层尺寸会被强制压成 0×0（见 getLayerChannels 中的分支），
  //     结果是 PS 里能看到底衬色块、却完全看不到文字。
  //
  //   措施：创建一个与文本框等大的透明 canvas 作为图层像素，
  //         文字内容仍由 text 字段承载，保持完全可编辑。
  //
  // ⚠️ 文字层的「图层矩形」必须**足够大，能容纳文字**：
  //     文字层若带 canvas，图层 rect 的宽高 = canvas 的宽高；
  //     若文字超出这个矩形，PS 会把溢出的文字裁掉或重新排布。
  //     故让图层矩形始终等于文字框（boxWidth×boxHeight）。
  const textCanvas = document.createElement('canvas');
  textCanvas.width = Math.max(1, Math.round(boxWidth));
  textCanvas.height = Math.max(1, Math.round(boxHeight));
  // 不绘制任何内容 → 全透明，仅用于定义图层矩形

  layers.push({
    name: `文本_${dialog.id}`,
    canvas: textCanvas,
    // 图层级边界（画布绝对坐标）—— 与底衬同源，保证两层严格对齐
    top: Math.round(textTop),
    left: Math.round(textLeft),
    bottom: Math.round(textTop + boxHeight),
    right: Math.round(textLeft + boxWidth),
    text: {
      text: translated,
      orientation: isVertical ? 'vertical' : 'horizontal',
      shapeType: 'box',
      /**
       * ⚠️ 文字内部框必须与「图层矩形」同尺寸，且以 0 为起点。
       *
       * PS 的排版基准是：
       *     文字实际落点 = transform 的 (tx,ty) + 图层矩形左上角
       * 而文字在框内如何摆放，由 text 内部框（top/left/right/bottom）
       * 相对图层原点决定。
       *
       * 若内部框与图层矩形不一致（例如内部框偏小或带偏移），
       * PS 会把文字按内部框重新摆放，视觉上就与底衬错位。
       * 因此这里统一取 [0,0,boxWidth,boxHeight]。
       */
      top: 0,
      left: 0,
      bottom: boxHeight,
      right: boxWidth,
      boxBounds: [0, 0, boxWidth, boxHeight],
      /**
       * ⚠️ 变换矩阵必须携带位移，否则文字会堆在图层左上角！
       *
       * Photoshop 计算文字最终位置用的是：
       *     最终位置 = transform 的 (tx, ty) + 图层矩形偏移
       * 若 tx/ty 恒为 0，文字就会画在 (0,0) 附近，
       * 与图层矩形无关，表现为「所有文本挤在左上角」。
       *
       * 参考 Adobe 原生样本：transform = [1,0,0,1, 649.5, 245.538]，
       * 后两位正是文字对象在画布中的锚点坐标。
       */
      transform: [1, 0, 0, 1, Math.round(textLeft), Math.round(textTop)],
      /**
       * bounds / boundingBox：PS 用它们记录文字块的几何范围。
       *
       * ⚠️ 实测 Adobe 样本：bounds 的坐标是**相对 transform 锚点的偏移**，
       *    不以画布原点为基准（例如竖排样本 bounds = 0,0,267.79,577.30，
       *    而 transform=(421.5,672.89)）。此处保持与 boxBounds 同源，
       *    让框范围与文字内部框一致即可。
       *
       * ⚠️ ag-psd 要求每个分量是 { units, value } 形式的带单位值，
       *    直接传数字会抛 "should have value and units"。
       */
      bounds: pxBounds(0, 0, boxWidth, boxHeight),
      boundingBox: pxBounds(0, 0, boxWidth, boxHeight),
      style: {
        font: { name: PSD_FONT_NAME },
        fontSize,
        fillColor: { r: 0, g: 0, b: 0 },
      },
      paragraphStyle: { justification: 'center' },
    },
  });

  return layers;
}

/**
 * 单张图片 → PSD 图层集合
 */
function buildLayersForImage(
  dialogs: MergedDialog[],
  opts: BuildOptions
): any[] {
  const layers: any[] = [];
  for (const d of dialogs) {
    layers.push(...buildLayersForDialog(d, opts));
  }
  return layers;
}

/**
 * 把原图绘制到 canvas，作为 PSD 的背景图层
 *
 * ⚠️ 跨域限制：漫画站点的图片常来自其他域。若站点未返回
 *    Access-Control-Allow-Origin，canvas 会被「污染」(tainted)，
 *    读取像素时会抛 SecurityError。
 *    此时回退为「不导出原图」，仅导出文字层 + 底衬
 *    （与原行为一致），并给出提示，而不是让整个导出失败。
 *
 * @returns 绘制好的 canvas；不可用时返回 null
 */
function createImageBackgroundCanvas(
  imageElement: HTMLImageElement,
  width: number,
  height: number
): HTMLCanvasElement | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.drawImage(imageElement, 0, 0, canvas.width, canvas.height);

    // 主动探测是否被污染：尝试读 1 个像素。
    // 若跨域受限，这里会抛 SecurityError，从而走回退分支。
    ctx.getImageData(0, 0, 1, 1);

    /**
     * ⚠️ 与底衬同理：清空右下角 1px，确保 ag-psd 写出透明通道。
     *
     * 原图通常完全不透明，hasAlpha() 会返回 false 而不写透明通道。
     * 尽管原图本就铺满画布、位于最底层，但缺少透明通道的图层在
     * Photoshop 中行为不稳定（曾导致图层被撑满画布，即此前的整片白色问题）。
     * 统一保留 1px 透明像素可彻底规避该风险，视觉上无影响。
     */
    if (canvas.width > 1 && canvas.height > 1) {
      ctx.clearRect(canvas.width - 1, canvas.height - 1, 1, 1);
    }

    return canvas;
  } catch (e) {
    console.warn(
      '[PSDExport] 原图无法写入 PSD（可能是跨域图片，canvas 被污染），将只导出文字层：',
      e instanceof Error ? e.message : e
    );
    return null;
  }
}

// ============================================
// PSDExporter 主体
// ============================================

export class PSDExporter {
  private callbacks: PsdExportCallbacks;

  constructor(callbacks: PsdExportCallbacks) {
    this.callbacks = callbacks;
  }

  configure(callbacks: PsdExportCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * 构建待导出的目标列表
   *
   * ⚠️ 数据源仅限「当前页面中已翻译的图片」，不含缓存里的历史条目。
   */
  async buildTargets(
    selectedSrcs?: Set<string>
  ): Promise<PsdExportTarget[]> {
    const images = this.callbacks.getTranslatedImages();
    const targets: PsdExportTarget[] = [];

    for (const img of images) {
      if (selectedSrcs && !selectedSrcs.has(img.src)) continue;

      const dialogs = await this.callbacks.getCachedDialogsForImage(img.src);
      if (!dialogs || dialogs.length === 0) continue;

      // 过滤掉没有译文的条目
      const usable = dialogs.filter(
        (d) => (d.translatedText || '').trim() && d.translationSuccess !== false
      );
      if (usable.length === 0) continue;

      targets.push({ imageSrc: img.src, imageElement: img, dialogs: usable });
    }

    // 按图片在页面中的垂直位置排序，与 PDF 导出的顺序保持一致
    targets.sort((a, b) => {
      const aTop = a.imageElement.getBoundingClientRect().top;
      const bTop = b.imageElement.getBoundingClientRect().top;
      return aTop - bTop;
    });

    return targets;
  }

  /**
   * 生成单张图片的 PSD（不下载，返回 ArrayBuffer）
   *
   * 拆出来便于单测与调试。
   */
  generatePsdForImage(target: PsdExportTarget): ArrayBuffer {
    const img = target.imageElement;
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;

    if (!width || !height) {
      throw new Error('图片尺寸不可用（可能尚未加载完成）');
    }

    // 采集覆盖层实测几何：必须在调用本方法前完成（由回调注入）
    this.callbacks.prepareGeometry?.(img);

    // 同步「显示 → 自然」换算比例：网页端覆盖层的字号等像素值
    // 都基于图片的显示尺寸，需放大回自然尺寸才能与 PSD 画布对齐。
    const displayedWidth = img.clientWidth || img.offsetWidth || width;
    setDisplayToNaturalScale(width / displayedWidth);

    const layers = buildLayersForImage(target.dialogs, {
      imageWidth: width,
      imageHeight: height,
    });

    if (layers.length === 0) {
      throw new Error('该图片没有可导出的译文');
    }

    /**
     * 原图作为最底层的背景图层
     *
     * ⚠️ 图层顺序：ag-psd 的 children 数组「靠后元素在上层」。
     *    背景需要在所有图层之下，因此 unshift 到数组开头。
     *    （translation-overlay.ts 采集几何时已假定图片位于 (0,0)，
     *      背景层同样铺满 (0,0)-(width,height)，两者天然对齐。）
     */
    const bgCanvas = createImageBackgroundCanvas(img, width, height);
    const children = bgCanvas
      ? [{ name: '原图', canvas: bgCanvas, left: 0, top: 0 }, ...layers]
      : layers;

    return writePsd({
      width,
      height,
      children,
    });
  }

  /**
   * 导出并逐张下载 PSD
   *
   * 命名规范：
   *   同一批次的多张图片统一放入一个以「批次时间戳」命名的文件夹，
   *   文件夹内每张图片一个独立 PSD，文件名为 `<时间戳>_<序号>.psd`。
   *
   *   例：2026-09-28-10-45-12/2026-09-28-10-45-12_001.psd
   *                                  2026-09-28-10-45-12_002.psd
   *
   *   实现方式：把文件夹名拼进下载文件的相对路径（Chrome 的
   *   downloads.download 会自动创建缺失的目录）。
   */
  async exportAll(selectedSrcs?: Set<string>): Promise<void> {
    const targets = await this.buildTargets(selectedSrcs);

    if (targets.length === 0) {
      alert('当前页面没有可导出的译文（请先完成翻译）');
      return;
    }

    /**
     * 批次时间戳：整批共用同一个，既作为文件夹名也作为文件名前缀
     *
     * 格式 `YYYY-MM-DD-HH-mm-ss`（本地时间），冒号替换为短横线
     * 以满足 Windows/macOS 的文件名约束。
     */
    const stamp = formatTimestamp(new Date());
    const folder = stamp;

    let okCount = 0;
    const failures: Array<{ index: number; reason: string }> = [];

    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      this.callbacks.onProgress?.(i + 1, targets.length, `第 ${i + 1}/${targets.length} 张`);

      try {
        const buffer = this.generatePsdForImage(t);
        const blob = new Blob([buffer], { type: 'application/octet-stream' });
        // 序号从 001 开始、固定三位，保证目录内排序稳定
        const seq = String(i + 1).padStart(3, '0');
        const filename = `${folder}/${stamp}_${seq}.psd`;
        this.callbacks.downloadPsd(blob, filename);
        okCount++;

        // 多文件下载时留出间隔，避免浏览器拦截连续下载
        if (i < targets.length - 1) {
          await new Promise((r) => setTimeout(r, 400));
        }
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        failures.push({ index: i + 1, reason });
        console.warn(`[PSDExport] 第 ${i + 1} 张导出失败:`, e);
      }
    }

    console.log(
      `[PSDExport] ✅ 完成：成功 ${okCount} 张，失败 ${failures.length} 张 → 目录 ${folder}/`
    );

    if (failures.length > 0) {
      const lines = failures
        .slice(0, 6)
        .map((f) => `· 第 ${f.index} 张：${f.reason}`)
        .join('\n');
      const more =
        failures.length > 6 ? `\n… 另有 ${failures.length - 6} 张同样失败` : '';
      alert(
        `⚠️ 已导出 ${okCount} 张 PSD，${failures.length} 张失败：\n\n${lines}${more}`
      );
    }
  }
}

/** 单例导出（由 content-script 在初始化时 configure） */
export const psdExporter = new PSDExporter({
  getTranslatedImages: () => [],
  getCachedDialogsForImage: async () => null,
  downloadPsd: () => {},
});
