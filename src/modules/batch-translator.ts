/**
 * 批量翻译模块
 * 
 * 专为漫画对话批量翻译设计：
 * 1. 将多段对话打包发送给 DeepSeek V4 Pro API
 * 2. 使用严格格式的 Prompt，确保返回结果可解析
 * 3. 按编号映射翻译结果到原始对话
 */

export interface DialogTranslationItem {
  /** 唯一标识符 */
  id: number;
  /** 原始文本（日文） */
  originalText: string;
  /** 翻译后文本（中文） */
  translatedText?: string;
  /** 翻译是否成功 */
  success: boolean;
  /** 错误信息（如果失败） */
  error?: string;
}

export interface BatchTranslationResult {
  /** 翻译结果列表（按原始顺序） */
  items: DialogTranslationItem[];
  /** 成功的数量 */
  successCount: number;
  /** 失败的数量 */
  failureCount: number;
  /** DeepSeek 请求 ID */
  requestId?: string;
}

export interface BatchTranslationConfig {
  /** DeepSeek API Key */
  apiKey: string;
  /** API 端点（可选，默认使用官方端点） */
  endpoint?: string;
  /** 模型名称（可选） */
  model?: string;
  /** 温度参数（可选，默认 0.7） */
  temperature?: number;
  /** 最大 token 数（可选） */
  maxTokens?: number;
  /** 单批最大对话数（可选，默认 20） */
  maxBatchSize?: number;
  /** 目标语言（可选，默认中文） */
  targetLanguage?: string;
}

/** 默认配置 */
const DEFAULT_CONFIG: Required<BatchTranslationConfig> = {
  apiKey: '',
  endpoint: 'https://api.deepseek.com/v1/chat/completions',
  model: 'deepseek-v4-pro',
  temperature: 0.7,
  maxTokens: 4000,
  // 【修改】每张图片一次翻译通信，不再分批
  maxBatchSize: 999,
  targetLanguage: '中文'
};

/**
 * 严格的系统提示词
 * 确保 MiniMax 只输出翻译结果，不输出额外分析
 * 
 * 【关键要求】
 * 1. 严格按照替换表修正OCR识别错误后再翻译
 * 2. 修正后的文本必须符合日语语法，不要输出任何修正说明
 * 3. 直接输出翻译结果，不要解释、不管原文是否像日语
 * 4. 如果原文看起来不像正常日语，按最可能的日语意思翻译
 */
const SYSTEM_PROMPT = `你是一个专业的日漫翻译助手。

任务：将日文漫画台词翻译成简体中文。

【重要上下文信息 - 必须参考】
- 翻译内容是漫画中的内容，每句话之间有一定的关系（对话连贯性）
- 请适当参考前后文的对照关系进行翻译，确保翻译结果语义连贯
- 如果某句话在单独看时语义模糊，可以结合上下文（编号相近的对话）来判断最合适的翻译

【强制执行规则 - 必须严格遵守】
1. 输出格式：【编号】翻译后的中文
2. 每个编号只对应一行翻译结果
3. 【绝对禁止】不输出任何推理过程、猜测、可能的翻译、备注
   * 错误示例：【001】いが → 可能来自... 【002】...
   * 正确示例：【001】呃 【002】...
4. 不输出引号、括号、前缀（如"翻译："、"答案是"等）
5. 翻译结果必须是纯中文，不要夹杂日文、英文
6. 直接输出翻译结果，不要询问或确认

【OCR识别错误自动修正 - 必须执行】
由于漫画OCR识别经常出错，翻译前必须先按以下规则修正：

单字符替换（优先级最高）：
- h → ん
- L → り
- < → く
- > →  >
- 。 → …
- 。 → 、（当看起来像日语顿号时）
- 八 → に 或 身体
- 尤 → な
- 戈 → な
- 寸 → す
- 书 → 書（书）
- U → う 或 ゆ
- O → お
- 0 → お
- 1 → い 或 一
- 3 → さん 或 み
- 5 → ご
- 7 → な
- 乙 → おつ
- つ → っ

词语替换（基于上下文）：
- 书前 → 書く前に
- 今身八L → 今身体が
- 面倒h尤 → 面倒な
- 気配< → 気づいた
- 出来L → 出来り
- あの书前 → あの人が書く前に
- 服装 → 服装（正确日语，直接翻译为"服装"）
- 言峰さん → 言峰先生

【修正示例】
输入：面倒h尤
修正后：面倒な
翻译：真麻烦

输入：気配<
修正后：気づいた
翻译：注意到了

输入：今身八L
修正后：今身体が
翻译：现在身体...

输入：书前
修正后：書く前に
翻译：写之前

【重要】
- 即使修正后的文本看起来很奇怪，也要直接翻译
- 不要说"这个词不对"、"无法翻译"等
- 按最合理的日语意思翻译成中文
- 翻译要简洁，符合漫画对话风格

现在开始翻译（先修正，再翻译，直接输出结果）：`;

/**
 * 构建批量翻译的 prompt
 */
function buildBatchPrompt(items: Array<{ id: number; text: string }>): string {
  const lines = items.map(item => `【${String(item.id).padStart(3, '0')}】${item.text}`);
  return lines.join('\n');
}

/**
 * 解析 MiniMax 返回的翻译结果
 */
function parseTranslationResponse(
  response: string,
  expectedIds: number[]
): Map<number, string> {
  const result = new Map<number, string>();
  
  // 按行分割响应
  const lines = response.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  
  for (const line of lines) {
    // 匹配格式：【001】翻译内容
    const match = line.match(/^【(\d+)】(.+)$/);
    if (match) {
      const id = parseInt(match[1], 10);
      const text = match[2].trim();
      
      // 只接受预期的编号
      if (expectedIds.includes(id)) {
        result.set(id, text);
      }
    }
  }
  
  return result;
}

/**
 * 批量翻译器类
 */
export class BatchTranslator {
  private config: BatchTranslationConfig;

  constructor(config: BatchTranslationConfig) {
    if (!config.apiKey) {
      throw new Error('DeepSeek API Key 不能为空');
    }
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 批量翻译多段对话
   * 
   * @param items 需要翻译的对话列表
   * @returns 翻译结果
   */
  async translate(
    items: Array<{ id: number; text: string }>
  ): Promise<BatchTranslationResult> {
    if (items.length === 0) {
      return { items: [], successCount: 0, failureCount: 0 };
    }

    console.log(`[BatchTranslator] 开始批量翻译 ${items.length} 段对话...`);

    try {
      // 调用 DeepSeek API
      const response = await this.callDeepSeekAPI(items);
      
      // 解析响应
      const translations = parseTranslationResponse(response.content, items.map(i => i.id));
      
      // 构建结果
      const resultItems: DialogTranslationItem[] = items.map(item => {
        const translated = translations.get(item.id);
        if (translated) {
          return {
            id: item.id,
            originalText: item.text,
            translatedText: translated,
            success: true
          };
        } else {
          return {
            id: item.id,
            originalText: item.text,
            success: false,
            error: '响应中未找到对应编号的翻译'
          };
        }
      });

      const successCount = resultItems.filter(r => r.success).length;
      const failureCount = resultItems.filter(r => !r.success).length;

      console.log(`[BatchTranslator] 翻译完成: ${successCount} 成功, ${failureCount} 失败`);

      return {
        items: resultItems,
        successCount,
        failureCount,
        requestId: response.requestId
      };

    } catch (error) {
      console.error('[BatchTranslator] 批量翻译失败:', error);
      
      // 失败时，所有条目都标记为失败，保留原文
      return {
        items: items.map(item => ({
          id: item.id,
          originalText: item.text,
          success: false,
          error: error instanceof Error ? error.message : '未知错误'
        })),
        successCount: 0,
        failureCount: items.length
      };
    }
  }

  /**
   * 调用 DeepSeek V4 Pro API
   */
  private async callDeepSeekAPI(
    items: Array<{ id: number; text: string }>
  ): Promise<{ content: string; requestId: string }> {
    const prompt = buildBatchPrompt(items);

    const response = await fetch(this.config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          {
            role: 'system',
            content: SYSTEM_PROMPT
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`DeepSeek API 错误: ${response.status} - ${errorText}`);
    }

    const data = await response.json();

    if (!data.choices || data.choices.length === 0) {
      throw new Error('DeepSeek API 返回格式错误');
    }

    const content = data.choices[0].message?.content?.trim() || '';
    const requestId = data.id || '';

    console.log(`[BatchTranslator] API 响应长度: ${content.length} 字符`);

    return { content, requestId };
  }

  /**
   * 分批翻译（当对话数量超过单批限制时）
   * 
   * @param items 所有需要翻译的对话
   * @param onProgress 每批完成后的回调（可选）
   */
  async translateInBatches(
    items: Array<{ id: number; text: string }>,
    onProgress?: (completed: number, total: number) => void
  ): Promise<BatchTranslationResult> {
    const maxBatchSize = this.config.maxBatchSize;
    const allResults: DialogTranslationItem[] = [];
    let totalSuccess = 0;
    let totalFailure = 0;
    let lastRequestId = '';

    // 分批处理
    for (let i = 0; i < items.length; i += maxBatchSize) {
      const batch = items.slice(i, i + maxBatchSize);
      const batchNum = Math.floor(i / maxBatchSize) + 1;
      const totalBatches = Math.ceil(items.length / maxBatchSize);

      console.log(`[BatchTranslator] 处理批次 ${batchNum}/${totalBatches} (${batch.length} 条)`);

      const result = await this.translate(batch);
      
      allResults.push(...result.items);
      totalSuccess += result.successCount;
      totalFailure += result.failureCount;
      if (result.requestId) lastRequestId = result.requestId;

      // 触发进度回调
      if (onProgress) {
        onProgress(Math.min(i + maxBatchSize, items.length), items.length);
      }

      // 批次之间添加短暂延迟
      if (i + maxBatchSize < items.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    return {
      items: allResults,
      successCount: totalSuccess,
      failureCount: totalFailure,
      requestId: lastRequestId
    };
  }
}

/**
 * 便捷函数：快速批量翻译
 */
export async function batchTranslate(
  dialogs: Array<{ id: number; text: string }>,
  apiKey: string
): Promise<BatchTranslationResult> {
  const translator = new BatchTranslator({ apiKey });
  return translator.translate(dialogs);
}
