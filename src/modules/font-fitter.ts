/**
 * 字体自适应计算模块
 *
 * 目标：根据「文本框尺寸」和「译文字符数」自动计算合适的字号，
 *      使译文既填满气泡、又不溢出，同时保留原文的视觉分级
 *      （拟声词大、小字说明小）。
 *
 * 设计要点：
 * 1. 几何适配：由框宽高与字符数推导「刚好填满」的初始字号（解析解）
 * 2. 视觉分级：参考 OCR 得到的原文实际字符高度，取「填满」与「忠于原文」的较小值
 * 3. 迭代收敛：以浏览器真实排版结果为权威，测量-修正-再测量，逼近最优字号
 * 4. 溢出兜底：字号不得低于可读下限；若仍溢出，返回 overflow 标记供 UI 提示
 *
 * 本模块不依赖 DOM 之外的任何全局状态，便于独立测试。
 */

/**
 * 字体大小算法版本号
 *
 * 每次修改字体适配算法（公式、约束、迭代策略等）都应递增此版本。
 * 缓存中的 MergedDialog.fontSizeVersion 低于此值时，会在读取缓存时
 * 触发重新计算并回写缓存。
 *
 * 版本历史：
 * - 0 / undefined：旧算法（仅按「译文字数/原文字数」比例缩放，不感知框大小）
 * - 1：几何适配 + 视觉分级 + 迭代收敛 + 溢出检测
 */
export const FONT_SIZE_ALGO_VERSION = 1;

/** 字体适配配置 */
export interface FontFitConfig {
  /** 框宽度（像素，显示坐标） */
  boxWidth: number;
  /** 框高度（像素，显示坐标） */
  boxHeight: number;
  /** 文字是否竖排（vertical-rl） */
  isVertical: boolean;
  /** 行高倍数（与 CSS line-height 保持一致） */
  lineHeight: number;
  /** 填充率：理想字号占可用空间的比例，留出呼吸空间 */
  fillRatio: number;
  /** 可读下限（像素）——字号不允许低于此值 */
  minFontSize: number;
  /** 上限（像素）——防止短文字被撑成巨无霸 */
  maxFontSize: number;
  /** 原文实际字符高度（像素，显示坐标）；未知时传 undefined */
  originalCharHeight?: number;
  /** 原文视觉分级权重：0=完全填满框，1=完全忠于原文 */
  originalWeight: number;
}

export const DEFAULT_FONT_FIT_CONFIG: Omit<
  FontFitConfig,
  'boxWidth' | 'boxHeight' | 'originalCharHeight'
> = {
  isVertical: false,
  lineHeight: 1.4,
  fillRatio: 0.88,
  minFontSize: 10,
  // 绝对上限，避免极端情况下字号失控
  maxFontSize: 96,
  // 视觉分级权重：偏向保留原文大小对比，但不过分依赖
  originalWeight: 0.6
};

/** 字体适配结果 */
export interface FontFitResult {
  /** 最终字号（像素，未乘用户缩放系数） */
  fontSize: number;
  /** 是否发生溢出（即使已压到下限仍装不下） */
  overflow: boolean;
  /** 溢出严重程度 0-1，用于 UI 提示强度 */
  overflowRatio: number;
  /** 采用的策略，便于调试 */
  strategy: 'geometry' | 'original-capped' | 'min-clamped' | 'overflow';
}

/**
 * 估算单个字符的平均宽度相对于字号的倍数
 *
 * 中日文全角字符宽度≈1倍字号，英文/数字/半角标点≈0.5倍。
 * 这里按字符组成做一个粗略加权，作为解析解的输入。
 */
export function estimateCharWidthRatio(text: string): number {
  if (!text) return 1;
  let fullWidth = 0;
  let halfWidth = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // 半角 ASCII 可见字符与半角标点
    if (code < 0x2e80 || (code >= 0xff61 && code <= 0xffdc)) {
      halfWidth++;
    } else if (code >= 0x2000 && code <= 0x206f) {
      // 通用标点，按半角处理
      halfWidth++;
    } else {
      fullWidth++;
    }
  }
  const total = fullWidth + halfWidth;
  if (total === 0) return 1;
  return (fullWidth * 1 + halfWidth * 0.55) / total;
}

/**
 * 解析解：计算「刚好填满框」的字号
 *
 * 推导（横排）：
 *   设字号 s、每行可放字符数 c = W_avail / (s × r)，其中 r 为字符宽度比
 *   需要行数 L = ceil(N / c)
 *   总高度 H_need = L × s × lineHeight ≤ H_avail
 *
 *   由于 L 依赖 s，采用「假设行数 → 反解 s → 校验行数」的逼近方式：
 *   先假设单行能放下，若不成立则用迭代逼近。
 *
 * @param charCount 字符数
 * @param availableWidth 可用宽度（已扣除内边距）
 * @param availableHeight 可用高度（已扣除内边距）
 * @param charWidthRatio 平均字符宽度相对字号的倍数
 * @param lineHeight 行高倍数
 */
function solveIdealFontSize(
  charCount: number,
  availableWidth: number,
  availableHeight: number,
  charWidthRatio: number,
  lineHeight: number
): number {
  if (charCount <= 0 || availableWidth <= 0 || availableHeight <= 0) {
    return 0;
  }

  // 单行字号的解析解：假设所有字排一行
  const singleLineSize = availableWidth / (charCount * charWidthRatio);

  // 判断单行解是否满足高度约束
  if (singleLineSize * lineHeight <= availableHeight) {
    // 单行可行，但字号还受行高约束上限
    return Math.min(singleLineSize, availableHeight / lineHeight);
  }

  // 需要多行：迭代逼近
  // 设 s，计算行数，检查 s × lineHeight × 行数 ≤ availableHeight
  let low = 0.5;
  let high = singleLineSize;
  let best = low;

  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2;
    const charsPerLine = availableWidth / (mid * charWidthRatio);
    if (charsPerLine < 1) {
      // 一行放不下一个字，字号过大
      high = mid;
      continue;
    }
    const lines = Math.ceil(charCount / charsPerLine);
    const neededHeight = lines * mid * lineHeight;
    if (neededHeight <= availableHeight) {
      best = mid;
      low = mid;
    } else {
      high = mid;
    }
  }
  return best;
}

/**
 * 计算自适应字号（解析解 + 视觉分级约束）
 *
 * 注意：此函数不进行 DOM 测量，得到的是「理论最优字号」。
 * 若需要精确贴合真实排版，请配合 refineFontSizeByMeasurement 使用。
 */
export function computeAdaptiveFontSize(
  text: string,
  config: FontFitConfig
): FontFitResult {
  const cfg = { ...DEFAULT_FONT_FIT_CONFIG, ...config } as FontFitConfig;
  const charCount = text.length;

  // 竖排时宽高互换：竖排是「一列一列」排，宽度方向消耗的是行数
  const availableWidth = cfg.isVertical ? cfg.boxHeight : cfg.boxWidth;
  const availableHeight = cfg.isVertical ? cfg.boxWidth : cfg.boxHeight;

  const charWidthRatio = estimateCharWidthRatio(text);

  const ideal = solveIdealFontSize(
    charCount,
    availableWidth,
    availableHeight,
    charWidthRatio,
    cfg.lineHeight
  );

  // 填充率修正：不要贴边，留出呼吸空间
  let candidate = ideal * cfg.fillRatio;

  // 视觉分级：与原文实际字符高度做平衡
  let strategy: FontFitResult['strategy'] = 'geometry';
  if (cfg.originalCharHeight && cfg.originalCharHeight > 0) {
    const originalBased = cfg.originalCharHeight;
    // 加权：偏向「填满框」，同时向「原文大小」靠拢
    const weighted =
      candidate * (1 - cfg.originalWeight) + originalBased * cfg.originalWeight;
    // 同时不允许超过「忠于原文」的上限太多（保留视觉分级）
    const capped = Math.min(weighted, Math.max(originalBased * 1.5, originalBased));
    if (capped < candidate) {
      strategy = 'original-capped';
    }
    candidate = capped;
  }

  // 上限约束
  if (candidate > cfg.maxFontSize) {
    candidate = cfg.maxFontSize;
  }

  // 下限约束（可读性）
  let overflow = false;
  let overflowRatio = 0;
  if (candidate < cfg.minFontSize) {
    // 若「理想字号」本身就低于下限，说明这个框装不下这么多字
    // 此时压到下限，并标记溢出（宁可溢出也不牺牲可读性）
    if (ideal < cfg.minFontSize) {
      overflow = true;
      // 溢出比例：需要的高度 / 可用高度，粗略估算
      const charsPerLine = Math.max(
        1,
        availableWidth / (cfg.minFontSize * charWidthRatio)
      );
      const lines = Math.ceil(charCount / charsPerLine);
      const needed = lines * cfg.minFontSize * cfg.lineHeight;
      overflowRatio = Math.min(1, Math.max(0, needed / availableHeight - 1));
      strategy = 'overflow';
    } else {
      strategy = 'min-clamped';
    }
    candidate = cfg.minFontSize;
  }

  return {
    fontSize: Math.max(1, candidate),
    overflow,
    overflowRatio,
    strategy
  };
}

/**
 * 基于真实 DOM 测量，迭代收敛到最贴合的字号
 *
 * 思路：公式解是估算，真实排版（避头尾、中英混排、字体度量）会有偏差。
 * 用浏览器实际渲染结果作为权威，测量-修正-再测量逼近最优。
 *
 * @param text 译文
 * @param el 已插入 DOM 的元素（用于测量）
 * @param boxWidth 框宽（像素）
 * @param boxHeight 框高（像素）
 * @param initialSize 初始字号（通常来自 computeAdaptiveFontSize）
 * @param minFontSize 可读下限
 * @param maxFontSize 上限
 * @param maxIterations 最大迭代次数
 * @returns 收敛后的字号与溢出状态
 */
export function refineFontSizeByMeasurement(
  text: string,
  el: HTMLElement,
  boxWidth: number,
  boxHeight: number,
  initialSize: number,
  minFontSize: number,
  maxFontSize: number,
  maxIterations = 6
): { fontSize: number; overflow: boolean; overflowRatio: number } {
  if (!text || boxWidth <= 0 || boxHeight <= 0) {
    return { fontSize: initialSize, overflow: false, overflowRatio: 0 };
  }

  // 保存原样式以便恢复
  const prevFontSize = el.style.fontSize;
  const prevVisibility = el.style.visibility;
  const prevWhiteSpace = el.style.whiteSpace;

  // 测量期间隐藏，避免闪烁；固定 white-space 以匹配最终渲染
  el.style.visibility = 'hidden';
  if (prevWhiteSpace === '') {
    el.style.whiteSpace = 'pre-wrap';
  }

  const measure = (size: number): { height: number; overflow: boolean } => {
    el.style.fontSize = `${size}px`;
    // 强制同步布局，读取真实排版高度
    // 元素设有固定 height + overflow:hidden，因此 scrollHeight 即「内容所需高度」，
    // clientHeight 即「框可用高度」，两者相减可得真实溢出量。
    const clientH = el.clientHeight || boxHeight;
    const scrollH = el.scrollHeight;
    const contentHeight = Math.max(clientH, scrollH);
    // 溢出判定：内容高度超过可用框高（留 2px 容差）
    return {
      height: contentHeight,
      overflow: scrollH > clientH + 2
    };
  };

  let size = Math.max(minFontSize, Math.min(maxFontSize, initialSize));
  let best = size;
  let bestOverflow = measure(size).overflow;

  // 目标区间：落在 [boxHeight × 0.8, boxHeight] 视为理想
  for (let i = 0; i < maxIterations; i++) {
    const { height, overflow } = measure(size);
    best = size;
    bestOverflow = overflow;

    if (overflow) {
      // 溢出 → 缩小
      const next = size * 0.9;
      if (next < minFontSize) {
        // 已到下限仍溢出，停止迭代
        best = minFontSize;
        break;
      }
      size = next;
      continue;
    }

    // 未溢出：若留白较多则尝试放大，否则收敛
    if (height < boxHeight * 0.82) {
      const next = size * 1.06;
      if (next > maxFontSize) {
        best = maxFontSize;
        break;
      }
      const nextMeasure = measure(next);
      if (nextMeasure.overflow) {
        // 放大后会溢出，说明当前 size 已接近最优
        break;
      }
      size = next;
      continue;
    }

    // 落在理想区间，收敛
    break;
  }

  // 重新测量最终值，取准确状态
  const finalMeasure = measure(best);
  const finalOverflow = finalMeasure.overflow;
  const overflowRatio = finalOverflow
    ? Math.min(1, Math.max(0, finalMeasure.height / boxHeight - 1))
    : 0;

  // 恢复样式
  el.style.fontSize = prevFontSize;
  el.style.visibility = prevVisibility;
  if (prevWhiteSpace === '') {
    el.style.whiteSpace = prevWhiteSpace;
  }

  return {
    fontSize: best,
    overflow: finalOverflow,
    overflowRatio
  };
}
