/**
 * 对话合并器 v2
 * 
 * 功能：将 OCR 识别出的分散文字片段按阅读顺序合并成完整句子
 * 
 * 算法思路（漫画气泡特点）：
 * 1. OCR 引擎已完成坐标转换，所有文字都在统一的坐标系中
 * 2. 统一使用 X轴分组（同一列的气泡）、Y轴排序（从上到下）
 * 3. 使用 DBSCAN 思想，基于距离判断是否应合并
 * 4. 删除 verticalMode 参数，简化代码
 */

export interface OCRTextItem {
  /** 文字内容 */
  text: string;
  /** 包围盒 X 坐标 */
  x: number;
  /** 包围盒 Y 坐标 */
  y: number;
  /** 包围盒宽度 */
  width: number;
  /** 包围盒高度 */
  height: number;
  /** 右边界 */
  right: number;
  /** 下边界 */
  bottom: number;
  /** 置信度 */
  confidence: number;
  /** 是否竖排文字 */
  isVertical: boolean;
  /** 原始多边形顶点 (可选) */
  polygon?: Array<{ x: number; y: number }>;
}

export interface MergedDialog {
  /** 对话唯一标识符（用于调试和映射） */
  id: number;
  /** 合并后的完整句子 */
  text: string;
  /** 所有原始片段 */
  items: OCRTextItem[];
  /** 合并后的统一边界框 */
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** 合并后总字数 */
  charCount: number;
  /** 平均字符宽度（像素）- 用于字体大小计算 */
  charWidth: number;
  /** 每个片段的字符数和宽度信息 */
  itemCharWidths: Array<{ charCount: number; width: number; avgWidth: number }>;
  /** 气泡边界（带内边距和裁剪） */
  bubbleBounds?: BubbleBounds;
  /** 翻译后的文本 */
  translatedText?: string;
  /** 翻译是否成功 */
  translationSuccess?: boolean;
  /** 是否竖排文字（通过 OCR 片段的宽高比判断） */
  isVertical?: boolean;
  /** 用户手动设定的每个覆盖层字体大小（px），null/undefined 表示使用默认 */
  customFontSize?: number;
  /** 用户手动设定的覆盖层位置和尺寸（百分比），null/undefined 表示使用自动计算值 */
  customStyle?: {
    left?: string;
    top?: string;
    width?: string;
    height?: string;
  };
}

/** 翻译后的对话（带完整翻译信息） */
export interface TranslatedDialog extends MergedDialog {
  /** 翻译后的文本 */
  translatedText: string;
  /** 翻译是否成功 */
  translationSuccess: boolean;
  /** 对话 ID（用于与翻译结果映射） */
  id: number;
}

/** 估算译文横排显示所需尺寸 */
export interface EstimatedSize {
  /** 估算宽度 */
  width: number;
  /** 估算高度 */
  height: number;
  /** 是否超出原始气泡范围 */
  isOverflow: boolean;
}

export interface DialogMergerConfig {
  /** X轴容差阈值（像素）- 同一列判定 */
  xThreshold: number;
  /** Y轴容差阈值（像素）- 同一行判定 */
  yThreshold: number;
  /** 是否从右往左阅读（日漫模式）- 用于组内排序方向 */
  rtlMode: boolean;
  /** 气泡内边距（像素）- 为译文留出空间 */
  bubblePadding: number;
  /** 最大合并距离（像素）- 超出则不合并 */
  maxMergeDistance: number;
}

export interface BubbleBounds {
  /** 原始边界框 */
  raw: { x: number; y: number; width: number; height: number };
  /** 带内边距的边界框 */
  padded: { x: number; y: number; width: number; height: number };
  /** 裁剪后的边界框（不超出图片边界） */
  clipped: { x: number; y: number; width: number; height: number };
  /** 图片尺寸（用于边界裁剪） */
  imageBounds: { width: number; height: number };
}

const DEFAULT_CONFIG: DialogMergerConfig = {
  xThreshold: 40,        // X轴容差：同一行的气泡X起始点差异
  yThreshold: 40,        // Y轴容差：同一列的气泡Y起始点差异
  rtlMode: true,         // 日漫默认从右往左阅读
  bubblePadding: 8,
  maxMergeDistance: 300   // 最大合并距离：超出则不合并
};

/**
 * 对话合并器类 v2
 */
export class DialogMerger {
  private config: DialogMergerConfig;

  constructor(config: Partial<DialogMergerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 合并 OCR 结果中的分散文字
   * 
   * 竖排模式（verticalMode=true）：
   * 1. 按X轴分组（同一列的气泡）
   * 2. 组内按Y轴排序（从上到下）
   * 
   * 横排模式（verticalMode=false）：
   * 1. 按Y轴分组（同一行的气泡）
   * 2. 组内按X轴排序（从左到右）
   */
  merge(items: OCRTextItem[]): MergedDialog[] {
    if (items.length === 0) return [];

    // 预处理：计算边界 + 判断方向
    const processedItems = items.map(item => ({
      ...item,
      right: item.x + item.width,
      bottom: item.y + item.height,
      // 判断是否为竖排：优先使用 OCR 的 isVertical，否则根据宽高比
      _isVertical: item.isVertical !== undefined ? item.isVertical : (item.height > item.width)
    }));

    // 【方案B】分离竖排和横排片段，分别处理
    const verticalItems = processedItems.filter(item => item._isVertical);
    const horizontalItems = processedItems.filter(item => !item._isVertical);

    console.log(`[DialogMerger] 📊 片段方向分布: 竖排=${verticalItems.length}, 横排=${horizontalItems.length}`);

    // 竖排片段用 X 轴分组
    const verticalGroups = this.groupByXAxisForVertical(verticalItems);
    
    // 横排片段用 Y 轴分组
    const horizontalGroups = this.groupByYAxisForHorizontal(horizontalItems);

    // 处理竖排分组：组内按 Y 排序，组间按 X 排序（从右到左）
    const processedVerticalDialogs = this.processGroups(
      verticalGroups, 
      true,  // isVertical = true
      this.config.rtlMode
    );

    // 处理横排分组：组内按 X 排序，组间按 Y 排序（从上到下）
    const processedHorizontalDialogs = this.processGroups(
      horizontalGroups,
      false, // isVertical = false
      this.config.rtlMode
    );

    // 合并两种对话结果
    const mergedDialogs = [...processedVerticalDialogs, ...processedHorizontalDialogs];

    console.log(`[DialogMerger] ✅ 合并完成: ${items.length} 个片段 → ${mergedDialogs.length} 个对话`);
    console.log(`  竖排对话: ${processedVerticalDialogs.length}, 横排对话: ${processedHorizontalDialogs.length}`);

    return mergedDialogs;
  }

  /**
   * 处理分组：组内排序 + 组间排序 + 合并相邻片段
   */
  private processGroups(
    groups: Array<Array<OCRTextItem & { right: number; bottom: number; _isVertical: boolean }>>,
    isVertical: boolean,
    rtlMode: boolean
  ): MergedDialog[] {
    if (groups.length === 0) return [];

    const mergedDialogs: MergedDialog[] = [];
    let dialogId = 0;
    const modeName = isVertical ? '竖排' : '横排';

    // 组间排序
    let sortedGroups: typeof groups;
    if (isVertical) {
      // 竖排：组间按 X 排序（从右到左）
      sortedGroups = [...groups].sort((g1, g2) => {
        const x1 = g1[0].x + g1[0].width / 2;
        const x2 = g2[0].x + g2[0].width / 2;
        return rtlMode ? x2 - x1 : x1 - x2;
      });
    } else {
      // 横排：组间按 Y 排序（从上到下）
      sortedGroups = [...groups].sort((g1, g2) => {
        const y1 = g1[0].y + g1[0].height / 2;
        const y2 = g2[0].y + g2[0].height / 2;
        return y1 - y2;
      });
    }

    for (let g = 0; g < sortedGroups.length; g++) {
      const group = sortedGroups[g];
      if (group.length === 0) continue;

      // 组内排序
      let sortedItems: typeof group;
      if (isVertical) {
        // 竖排（从右到左阅读）：按 X 从大到小排序（右侧先读）
        sortedItems = [...group].sort((a, b) => b.x - a.x);
      } else {
        sortedItems = rtlMode 
          ? [...group].sort((a, b) => b.x - a.x)  // 横排从右到左
          : [...group].sort((a, b) => a.x - b.x); // 横排从左到右
      }

      console.log(`[DialogMerger] 📋 ${modeName}组${g} 排序后:`);
      for (let i = 0; i < sortedItems.length; i++) {
        const item = sortedItems[i];
        console.log(`  [${i}] "${item.text.slice(0, 10)}" X=${item.x}-${item.right} Y=${item.y}-${item.bottom}`);
      }

      let currentDialog: MergedDialog | null = null;

      for (let i = 0; i < sortedItems.length; i++) {
        const item = sortedItems[i];
        if (!currentDialog) {
          currentDialog = this.createMergedDialog(item, dialogId++);
        } else {
          const lastItem = currentDialog.items[currentDialog.items.length - 1];
          const shouldMerge = this.shouldMergeByDirection(lastItem, item, isVertical);

          if (shouldMerge) {
            console.log(`[DialogMerger] ✅ ${modeName}组${g} 片段[${i}]"${item.text.slice(0,8)}" 合并到当前对话`);
            currentDialog = this.mergeItemToDialog(currentDialog, item);
          } else {
            console.log(`[DialogMerger] ❌ ${modeName}组${g} 片段[${i}]"${item.text.slice(0,8)}" 不合并，创建新对话`);
            mergedDialogs.push(currentDialog);
            currentDialog = this.createMergedDialog(item, dialogId++);
          }
        }
      }

      if (currentDialog) {
        mergedDialogs.push(currentDialog);
      }
    }

    return mergedDialogs;
  }

  /**
   * 按X轴分组（同一列的气泡）- 竖排片段专用
   * 
   * 只处理竖排片段（isVertical=true）
   * 逻辑：基于 Y 起始点分组（不再限制 X 间距）
   * - Y起始点相近：判断片段的 Y 起始位置是否与当前行的起始位置接近
   * 同一行（Y起始相近）的所有片段都归为一组，不管 X 坐标如何
   */
  private groupByXAxisForVertical(
    items: Array<OCRTextItem & { right: number; bottom: number; _isVertical: boolean }>
  ): Array<Array<typeof items[0]>> {
    
    // 行接口（按Y起始点分组）
    interface Row {
      startY: number;      // 行的Y起始基准（第一个片段的y）
      endY: number;        // 行的当前底部（最大bottom）
      items: Array<OCRTextItem & { right: number; bottom: number }>;
    }

    // 调试日志：打印所有片段的坐标
    console.log(`[DialogMerger] 📊 Y起始点分组输入: ${items.length} 个片段`);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      console.log(`  [${i}] "${item.text.slice(0, 10)}" X=${item.x}-${item.right} Y=${item.y}-${item.bottom} (Y起始=${item.y})`);
    }

    // 1. 按Y起始点从上到下排序
    const sorted = [...items].sort((a, b) => a.y - b.y);

    const rows: Row[] = [];

    for (const item of sorted) {
      // 2. 查找匹配的行（只按Y起始点判断）
      let matched = false;

      for (const row of rows) {
        // 计算Y起始点差值
        const yDiff = Math.abs(item.y - row.startY);

        // 关键判断：只按Y起始点相近分组，不再限制X间距
        if (yDiff <= this.config.yThreshold) {
          console.log(`[DialogMerger] 🔗 Y起始分组: "${item.text.slice(0, 8)}" 加入行(Y起始差=${yDiff.toFixed(1)})`);
          row.items.push(item);
          row.endY = Math.max(row.endY, item.bottom);  // 更新行底部
          matched = true;
          break;
        }
      }

      // 3. 无法匹配则创建新行
      if (!matched) {
        console.log(`[DialogMerger] 🆕 Y起始分组: "${item.text.slice(0, 8)}" 创建新行(Y起始=${item.y})`);
        rows.push({
          startY: item.y,
          endY: item.bottom,
          items: [item]
        });
      }
    }

    console.log(`[DialogMerger] Y起始分组结果: ${rows.length} 行`);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      console.log(`  行${i}: Y起始=${row.startY}, Y底部=${row.endY}, ${row.items.length}个片段`);
      console.log(`    片段: [${row.items.map(it => `"${it.text.slice(0, 6)}"`).join(', ')}]`);
    }

    // 返回行中的片段数组（组内按X从右到左排序）
    return rows.map(row => row.items.sort((a, b) => b.x - a.x));
  }

  /**
   * 按Y轴分组（同一行的气泡）- 横排片段专用
   * 
   * 只处理横排片段（isVertical=false）
   * 逻辑：基于 X 起始点分组（不再限制 Y 间距）
   * - X起始点相近：判断片段的 X 起始位置是否与当前行的起始位置接近
   * 同一行（X起始相近）的所有片段都归为一组，不管 Y 坐标如何
   */
  private groupByYAxisForHorizontal(
    items: Array<OCRTextItem & { right: number; bottom: number; _isVertical: boolean }>
  ): Array<Array<typeof items[0]>> {
    
    // 行接口（按X起始点分组）
    interface Row {
      startX: number;      // 行的X起始基准（第一个片段的x）
      endX: number;        // 行的当前右边界（最大right）
      items: Array<OCRTextItem & { right: number; bottom: number }>;
    }

    // 调试日志：打印所有片段的坐标
    console.log(`[DialogMerger] 📊 X起始点分组输入: ${items.length} 个片段`);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      console.log(`  [${i}] "${item.text.slice(0, 10)}" Y=${item.y}-${item.bottom} X=${item.x}-${item.right} (X起始=${item.x})`);
    }

    // 1. 按X起始点从左到右排序
    const sorted = [...items].sort((a, b) => a.x - b.x);

    const rows: Row[] = [];

    for (const item of sorted) {
      // 2. 查找匹配的行（只按X起始点判断）
      let matched = false;

      for (const row of rows) {
        // 计算X起始点差值
        const xDiff = Math.abs(item.x - row.startX);

        // 关键判断：只按X起始点相近分组，不再限制Y间距
        if (xDiff <= this.config.xThreshold) {
          console.log(`[DialogMerger] 🔗 X起始分组: "${item.text.slice(0, 8)}" 加入行(X起始差=${xDiff.toFixed(1)})`);
          row.items.push(item);
          row.endX = Math.max(row.endX, item.right);  // 更新行右边界
          matched = true;
          break;
        }
      }

      // 3. 无法匹配则创建新行
      if (!matched) {
        console.log(`[DialogMerger] 🆕 X起始分组: "${item.text.slice(0, 8)}" 创建新行(X起始=${item.x})`);
        rows.push({
          startX: item.x,
          endX: item.right,
          items: [item]
        });
      }
    }

    console.log(`[DialogMerger] X起始分组结果: ${rows.length} 行`);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      console.log(`  行${i}: X起始=${row.startX}, X右界=${row.endX}, ${row.items.length}个片段`);
      console.log(`    片段: [${row.items.map(it => `"${it.text.slice(0, 6)}"`).join(', ')}]`);
    }

    // 返回行中的片段数组（组内按Y从上到下排序）
    return rows.map(row => row.items.sort((a, b) => a.y - b.y));
  }

  /**
   * 根据方向检查两个片段是否应该合并
   * 
   * 竖排模式（isVertical=true）：
   * - Y轴起始点差值：判断是否同一行（< yThreshold）
   * - X轴距离：判断从右到左排列是否相邻
   * - 合并条件：Y起始点相近 且 X方向间隔合理
   * 
   * 横排模式（isVertical=false）：
   * - X轴距离：当前片段左侧到上一个片段右侧的距离
   * - Y轴距离：两个片段Y轴中心的距离
   * - 合并条件：X轴距离和Y轴距离都在阈值内
   */
  private shouldMergeByDirection(
    item1: OCRTextItem & { right: number; bottom: number },
    item2: OCRTextItem & { right: number; bottom: number },
    isVertical: boolean
  ): boolean {
    if (isVertical) {
      // ===== 竖排模式（从右到左阅读）=====
      // 1. 判断是否同一行：Y起始点差值
      const yStartDiff = Math.abs(item2.y - item1.y);
      // 2. 判断X方向间隔：item1在右侧，item2在左侧
      // item1.x 是右侧边界附近，item2.right 是左侧边界
      const xDistance = item1.x - item2.right;  // 正数表示 item2 在 item1 左边

      // 合并条件：Y起始点相近 且 X方向合理（边缘间距小于|20|）
      const xEdgeThreshold = 20;  // 边缘间距阈值 |20|
      const shouldMerge = (
        yStartDiff <= this.config.yThreshold &&      // 同一行
        Math.abs(xDistance) <= xEdgeThreshold  // 边缘间距在 |20| 以内
      );

      const totalDistance = Math.sqrt(yStartDiff * yStartDiff + xDistance * xDistance);

      console.log(`[DialogMerger] 🔍 合并检查(竖排): "${item1.text.slice(0, 8)}" → "${item2.text.slice(0, 8)}"`);
      console.log(`    Y起始差=${yStartDiff.toFixed(1)}<=${this.config.yThreshold}, X距离=${xDistance.toFixed(1)}, total=${totalDistance.toFixed(1)} → ${shouldMerge ? '✅' : '❌'}`);
      return shouldMerge;
      
    } else {
      // ===== 横排模式 =====
      // 边界距离：item1 的下边界与 item2 的上边界的距离
      const yEdgeDistance = Math.abs(item2.y - item1.bottom);

      // 合并条件：上下边缘间距在 |20| 以内
      const yEdgeThreshold = 20;
      const shouldMerge = yEdgeDistance <= yEdgeThreshold;

      console.log(`[DialogMerger] 🔍 合并检查(横排): "${item1.text.slice(0, 8)}" → "${item2.text.slice(0, 8)}"`);
      console.log(`    yEdgeDistance=|${item2.y} - ${item1.bottom}|=${yEdgeDistance.toFixed(1)}<=${yEdgeThreshold} → ${shouldMerge ? '✅' : '❌'}`);
      return shouldMerge;
    }
  }

  /**
   * 兼容旧接口：检查两个片段是否应该合并
   */
  private shouldMerge(
    item1: OCRTextItem & { right: number; bottom: number },
    item2: OCRTextItem & { right: number; bottom: number }
  ): boolean {
    const item1IsVertical = item1.isVertical !== undefined ? item1.isVertical : (item1.height > item1.width);
    const item2IsVertical = item2.isVertical !== undefined ? item2.isVertical : (item2.height > item2.width);
    
    if (item1IsVertical !== item2IsVertical) {
      console.log(`[DialogMerger] ❌ 方向不一致，不合并`);
      return false;
    }

    return this.shouldMergeByDirection(item1, item2, item1IsVertical);
  }

  /**
   * 检查两个文本片段是否可能是OCR错误拆分
   * 
   * OCR可能将一个完整的句子错误地识别成多个片段，
   * 常见情况：
   * 1. 空格或标点被识别为分隔符
   * 2. 同音字替换（如は/わ、へ/え等）
   * 3. 特殊符号导致拆分（如・、ー等）
   */
  private checkPotentialOCRSplit(text1: string, text2: string): boolean {
    if (!text1 || !text2) return false;
    
    // 常见OCR拆分模式
    const last1 = text1.slice(-1);
    const first2 = text2.slice(0, 1);
    
    // 检查是否是常见的假名拆分
    // 如 "かけら" 可能被拆成 "かけ" + "ら"
    // 或者 "材料は" 可能被拆成 "材料" + "は"
    const hiraganaPairs: Array<[string, string[]]> = [
      ['か', ['か', 'が', 'き', 'く', 'け', 'こ']],  // ka行
      ['き', ['き', 'ぎ', 'き', 'く', 'け', 'こ']],
      ['く', ['く', 'ぐ', 'き', 'く', 'け', 'こ']],
      ['け', ['け', 'げ', 'き', 'く', 'け', 'こ']],
      ['こ', ['こ', 'ご', 'き', 'く', 'け', 'こ']],
      ['た', ['た', 'だ', 'ち', 'つ', 'て', 'と']],  // ta行
      ['ち', ['ち', 'じ', 'ち', 'つ', 'て', 'と']],
      ['つ', ['つ', 'づ', 'ち', 'つ', 'て', 'と']],
      ['て', ['て', 'で', 'ち', 'つ', 'て', 'と']],
      ['と', ['と', 'ど', 'ち', 'つ', 'て', 'と']],
      ['な', ['な', 'に', 'ぬ', 'ね', 'の']],  // na行
      ['に', ['に', 'に', 'ぬ', 'ね', 'の']],
      ['ぬ', ['ぬ', 'ぬ', 'に', 'ね', 'の']],
      ['ね', ['ね', 'ね', 'に', 'ぬ', 'の']],
      ['の', ['の', 'に', 'ぬ', 'ね', 'の']],
      ['は', ['は', 'ば', 'ぱ', 'へ', 'ほ']],  // ha行（は在句子中间时常变为わ）
      ['へ', ['へ', 'べ', 'ぺ', 'へ', 'え']],
      ['ほ', ['ほ', 'ぼ', 'ぽ', 'へ', 'ほ']],
      ['ま', ['ま', 'み', 'む', 'め', 'も']],  // ma行
      ['み', ['み', 'み', 'む', 'め', 'も']],
      ['む', ['む', 'む', 'み', 'め', 'も']],
      ['め', ['め', 'め', 'み', 'む', 'も']],
      ['も', ['も', 'み', 'む', 'め', 'も']],
      ['や', ['や', 'ゆ', 'よ']],  // ya行
      ['ゆ', ['ゆ', 'ゆ', 'よ']],
      ['よ', ['よ', 'ゆ', 'よ']],
      ['ら', ['ら', 'り', 'る', 'れ', 'ろ']],  // ra行
      ['り', ['り', 'り', 'る', 'れ', 'ろ']],
      ['る', ['る', 'り', 'る', 'れ', 'ろ']],
      ['れ', ['れ', 'り', 'る', 'れ', 'ろ']],
      ['ろ', ['ろ', 'り', 'る', 'れ', 'ろ']],
      ['わ', ['わ', 'を', 'は', 'ん']],  // wa行（を在现代日语中只作助词）
      ['を', ['を', 'お', 'わ']],
      ['ん', ['ん', 'な', 'に', 'ぬ', 'ね', 'の']],  // ん可能与n行混淆
    ];
    
    // 查找匹配的假名对
    for (const [expected, alternatives] of hiraganaPairs) {
      if (last1 === expected && alternatives.includes(first2)) {
        return true;  // 可能是同行的假名拆分
      }
    }
    
    // 检查是否是片假名拆分（如 "ヒ・ミ" 中的 "・" 被识别为分隔符）
    // 这种情况下两个片段应该合并
    // 例如："ヒ・ミ" 被拆成 "ヒ" 和 "ミ"
    const katakana: string = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン';
    const isLastKatakana = katakana.includes(last1);
    const isFirstKatakana = katakana.includes(first2);
    
    // 如果两个都是片假名，且可能是同一个词的拆分
    if (isLastKatakana && isFirstKatakana) {
      // 检查是否是常见的片假名组合
      // 例如：チ与ツ（ヂ/ヅ的情况）
      const possibleCombos = [
        ['チ', 'ツ'],  // ち、つ可能被混淆
        ['ツ', 'チ'],
        ['シ', 'ツ'],
        ['ツ', 'シ'],
        ['ジ', 'ヂ'],
        ['ヂ', 'ジ'],
        ['ズ', 'ヅ'],
        ['ヅ', 'ズ'],
      ];
      
      for (const [c1, c2] of possibleCombos) {
        if (last1 === c1 && first2 === c2) {
          return true;
        }
      }
    }
    
    // 检查是否是数字或符号导致的拆分
    // 如 "10" 可能被拆成 "1" 和 "0"
    const numbers = '0123456789';
    if (numbers.includes(last1) && numbers.includes(first2)) {
      return true;  // 数字连续，可能是数字串的拆分
    }
    
    // 检查是否是罗马字的拆分
    // 如 "ABC" 可能被拆成 "AB" 和 "C"
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    if (letters.includes(last1) && letters.includes(first2)) {
      return true;  // 字母连续，可能是字符串的拆分
    }
    
    return false;
  }

  /**
   * 创建合并对话
   */
  private createMergedDialog(
    item: OCRTextItem & { right: number; bottom: number },
    id: number
  ): MergedDialog {
    const charCount = item.text.length;
    const avgWidth = charCount > 0 ? item.width / charCount : item.width;
    // 优先使用 OCR 传来的 isVertical，只在未定义时 fallback 到宽高比判断
    const isVertical = item.isVertical !== undefined ? item.isVertical : (item.height > item.width);

    return {
      id,
      text: item.text,
      items: [{
        text: item.text,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
        right: item.right,      // 添加 right 属性
        bottom: item.bottom,    // 添加 bottom 属性
        confidence: item.confidence,
        isVertical: item.isVertical
      }],
      boundingBox: {
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height
      },
      charCount,
      charWidth: avgWidth,
      itemCharWidths: [{ charCount, width: item.width, avgWidth }],
      isVertical
    };
  }

  /**
   * 将片段合并到对话
   */
  private mergeItemToDialog(
    dialog: MergedDialog,
    item: OCRTextItem & { right: number; bottom: number }
  ): MergedDialog {
    // 合并文字
    // 坐标已被转换到统一坐标系，统一使用 append 到末尾
    const mergedText = dialog.text + item.text;

    // 计算扩展边界框：X取最小（最左边），Y取最小（最上边）
    const newX = Math.min(dialog.boundingBox.x, item.x);
    const newY = Math.min(dialog.boundingBox.y, item.y);
    const maxRight = Math.max(dialog.boundingBox.x + dialog.boundingBox.width, item.right);
    const maxBottom = Math.max(dialog.boundingBox.y + dialog.boundingBox.height, item.bottom);

    const newBoundingBox = {
      x: newX,
      y: newY,
      width: maxRight - newX,
      height: maxBottom - newY
    };

    // 计算合并后的平均字符宽度
    const itemCharCount = item.text.length;
    const itemAvgWidth = itemCharCount > 0 ? item.width / itemCharCount : item.width;
    
    // 合并片段的字符宽度信息
    const newItemCharWidths = [...dialog.itemCharWidths, { 
      charCount: itemCharCount, 
      width: item.width, 
      avgWidth: itemAvgWidth 
    }];

    // 计算整体平均字符宽度（加权平均）
    const totalCharCount = dialog.charCount + itemCharCount;
    const totalWidth = dialog.boundingBox.width + item.width;
    const newCharWidth = totalCharCount > 0 ? totalWidth / totalCharCount : itemAvgWidth;

    // 优先使用 OCR 传来的 isVertical，保持文本方向一致性
    // 规则：如果 height > width，判定为竖排（只在未定义时使用）
    const itemIsVertical = item.isVertical !== undefined ? item.isVertical : (item.height > item.width);
    const allItemsVertical = [...dialog.items, { isVertical: itemIsVertical }];
    const verticalCount = allItemsVertical.filter(i => i.isVertical).length;
    const voteIsVertical = verticalCount >= allItemsVertical.length / 2;
    
    // 【关键修复】基于片段实际排列方向判断：X跨度明显大于Y跨度 → 横排
    const allItems = [...dialog.items, item];
    const minX = Math.min(...allItems.map(i => i.x));
    const allMaxRight = Math.max(...allItems.map(i => i.right));
    const minY = Math.min(...allItems.map(i => i.y));
    const allMaxBottom = Math.max(...allItems.map(i => i.bottom));
    const xSpan = allMaxRight - minX;
    const ySpan = allMaxBottom - minY;
    const isHorizontalArrangement = xSpan > ySpan * 1.2;
    
    // 排列方向优先于投票结果：水平排列强制为横排
    const newIsVertical = isHorizontalArrangement ? false : voteIsVertical;
    
    if (isHorizontalArrangement) {
      console.log(`[DialogMerger] 📐 排列方向覆盖: X跨度=${xSpan.toFixed(1)} > Y跨度=${ySpan.toFixed(1)}×1.2，强制横排`);
    }

    return {
      ...dialog,
      text: mergedText,
      items: [...dialog.items, {
        text: item.text,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
        right: item.right,      // 添加 right 属性
        bottom: item.bottom,    // 添加 bottom 属性
        confidence: item.confidence,
        isVertical: item.isVertical
      }],
      boundingBox: newBoundingBox,
      charCount: mergedText.length,
      charWidth: newCharWidth,
      itemCharWidths: newItemCharWidths,
      isVertical: newIsVertical
    };
  }

  /**
   * 计算气泡边界
   */
  calculateBubbleBounds(
    dialog: MergedDialog,
    imageWidth: number,
    imageHeight: number
  ): BubbleBounds {
    const padding = this.config.bubblePadding;
    
    const raw = { ...dialog.boundingBox };
    
    const padded: BubbleBounds['padded'] = {
      x: raw.x - padding,
      y: raw.y - padding,
      width: raw.width + padding * 2,
      height: raw.height + padding * 2
    };
    
    const clipped: BubbleBounds['clipped'] = {
      x: Math.max(0, padded.x),
      y: Math.max(0, padded.y),
      width: Math.min(imageWidth - padded.x, padded.width),
      height: Math.min(imageHeight - padded.y, padded.height)
    };
    
    if (clipped.width < 0) clipped.width = 0;
    if (clipped.height < 0) clipped.height = 0;
    
    return {
      raw,
      padded,
      clipped,
      imageBounds: { width: imageWidth, height: imageHeight }
    };
  }

  /**
   * 批量计算气泡边界
   */
  calculateAllBubbleBounds(
    dialogs: MergedDialog[],
    imageWidth: number,
    imageHeight: number
  ): MergedDialog[] {
    return dialogs.map(dialog => ({
      ...dialog,
      bubbleBounds: this.calculateBubbleBounds(dialog, imageWidth, imageHeight)
    }));
  }

  /**
   * 更新配置
   */
  setConfig(config: Partial<DialogMergerConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

/**
 * 便捷函数：从 OCR 结果直接合并
 */
export function mergeDialogs(
  ocrItems: OCRTextItem[],
  config?: Partial<DialogMergerConfig>
): MergedDialog[] {
  const merger = new DialogMerger(config);
  return merger.merge(ocrItems);
}
