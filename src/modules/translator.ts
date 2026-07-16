/**
 * 翻译模块
 * 支持多种翻译 API：腾讯云、MyMemory、DeepSeek
 */

export interface TranslationResult {
  translatedText: string;
  sourceText: string;
  detectedLanguage?: string;
}

export interface TranslatorConfig {
  tencentSecretId?: string;
  tencentSecretKey?: string;
  deepseekApiKey?: string;
}

export class Translator {
  private config: TranslatorConfig = {};
  private useCount = {
    tencent: 0,
    mymemory: 0,
    deepseek: 0
  };

  /**
   * 配置翻译 API
   */
  configure(config: TranslatorConfig): void {
    this.config = config;
    console.log('[MangaLens] 翻译模块配置完成', {
      hasTencent: !!config.tencentSecretId,
      hasDeepSeek: !!config.deepseekApiKey
    });
  }

  /**
   * 翻译日文到中文
   */
  async translateJapaneseToChinese(text: string): Promise<TranslationResult> {
    if (!text || text.trim().length === 0) {
      return {
        translatedText: '',
        sourceText: text
      };
    }

    // 清理文本
    const cleanText = text.trim();
    
    // 记录源语言
    console.log(`[MangaLens] 翻译请求: "${cleanText.substring(0, 50)}${cleanText.length > 50 ? '...' : ''}"`);

    // 按优先级尝试翻译
    let result: TranslationResult;
    let success = false;

    // 1. 首先尝试 DeepSeek（用户提供的）
    if (this.config.deepseekApiKey) {
      try {
        result = await this.translateWithDeepSeek(cleanText);
        if (result.translatedText) {
          this.useCount.deepseek++;
          console.log('[MangaLens] ✓ DeepSeek 翻译成功');
          success = true;
        }
      } catch (error) {
        console.warn('[MangaLens] DeepSeek 翻译失败:', error);
      }
    }

    // 2. 尝试腾讯云
    if (!success && this.config.tencentSecretId && this.config.tencentSecretKey) {
      try {
        result = await this.translateWithTencent(cleanText);
        if (result.translatedText) {
          this.useCount.tencent++;
          console.log('[MangaLens] ✓ 腾讯云翻译成功');
          success = true;
        }
      } catch (error) {
        console.warn('[MangaLens] 腾讯云翻译失败:', error);
      }
    }

    // 3. 最后使用 MyMemory 免费 API
    if (!success) {
      try {
        result = await this.translateWithMyMemory(cleanText);
        this.useCount.mymemory++;
        console.log('[MangaLens] ✓ MyMemory 翻译成功');
        success = true;
      } catch (error) {
        console.error('[MangaLens] 所有翻译 API 都失败了:', error);
        // 返回原文作为后备
        result = {
          translatedText: `[翻译失败] ${cleanText}`,
          sourceText: cleanText
        };
      }
    }

    return result!;
  }

  /**
   * 使用 DeepSeek V4 Pro API 翻译
   */
  private async translateWithDeepSeek(text: string): Promise<TranslationResult> {
    const apiKey = this.config.deepseekApiKey!;
    
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        messages: [
          {
            role: 'system',
            content: `你是一个专业的日漫翻译助手。请将下面的日文漫画台词翻译成中文。

翻译要求：
1. 保持原作品的语气和风格（口语化、符合漫画风格）
2. 人名和专有名词可以直接保留或音译
3. 注意日语的特殊表达方式和敬语
4. 如果是拟声词或拟态词，用中文的习惯表达
5. 保持翻译的自然流畅，不要生硬直译

请直接输出翻译结果，不要解释。`
          },
          {
            role: 'user',
            content: `翻译以下日文：\n${text}`
          }
        ],
        temperature: 0.7,
        max_tokens: 500
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`DeepSeek API 错误: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    
    if (data.choices && data.choices.length > 0) {
      const translated = data.choices[0].message?.content?.trim() || '';
      return {
        translatedText: translated,
        sourceText: text,
        detectedLanguage: 'ja'
      };
    }

    throw new Error('DeepSeek API 返回格式错误');
  }

  /**
   * 使用腾讯云翻译
   */
  private async translateWithTencent(text: string): Promise<TranslationResult> {
    const { secretId, secretKey } = this.config;
    if (!secretId || !secretKey) {
      throw new Error('腾讯云密钥未配置');
    }

    // 腾讯云翻译 API
    const timestamp = Math.floor(Date.now() / 1000);
    const requestBody = {
      SourceText: text,
      Source: 'ja',
      Target: 'zh',
      ProjectId: 0
    };

    // 生成签名
    const signature = await this.generateTC3Signature(
      secretId,
      secretKey,
      timestamp,
      JSON.stringify(requestBody)
    );

    const response = await fetch(
      `https://tmt.tencentcloudapi.com/?Timestamp=${timestamp}&Nonce=${Math.floor(Math.random() * 1000000)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-TC-Action': 'TextTranslate',
          'X-TC-Version': '2018-03-21',
          'X-TC-Timestamp': String(timestamp),
          'X-TC-Region': 'ap-shanghai',
          'X-TC-Key': secretId,
          'X-TC-Signature': signature
        },
        body: JSON.stringify(requestBody)
      }
    );

    if (!response.ok) {
      throw new Error(`腾讯云 API 错误: ${response.status}`);
    }

    const data = await response.json();
    
    if (data.Response && data.Response.TargetText) {
      return {
        translatedText: data.Response.TargetText,
        sourceText: text,
        detectedLanguage: data.Response.Source || 'ja'
      };
    }

    throw new Error('腾讯云 API 返回格式错误');
  }

  /**
   * 生成 TC3-HMAC-SHA256 签名
   */
  private async generateTC3Signature(
    secretId: string,
    secretKey: string,
    timestamp: number,
    payload: string
  ): Promise<string> {
    const encoder = new TextEncoder();
    
    // 使用 Web Crypto API
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secretKey),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    
    const signature = await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(`${secretId}${timestamp}`)
    );
    
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
  }

  /**
   * 使用 MyMemory 免费 API 翻译
   */
  private async translateWithMyMemory(text: string): Promise<TranslationResult> {
    const encodedText = encodeURIComponent(text);
    const url = `https://api.mymemory.translated.net/get?q=${encodedText}&langpair=ja|zh`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`MyMemory API 错误: ${response.status}`);
    }

    const data = await response.json();

    if (data.responseStatus === 200 && data.responseData) {
      return {
        translatedText: data.responseData.translatedText,
        sourceText: text,
        detectedLanguage: 'ja'
      };
    }

    throw new Error('MyMemory API 返回错误');
  }

  /**
   * 批量翻译
   */
  async translateBatch(texts: string[]): Promise<TranslationResult[]> {
    const results: TranslationResult[] = [];
    
    for (const text of texts) {
      try {
        const result = await this.translateJapaneseToChinese(text);
        results.push(result);
        // 添加延迟避免 API 限流
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        console.error(`[MangaLens] 翻译失败 "${text}":`, error);
        results.push({
          translatedText: `[翻译失败] ${text}`,
          sourceText: text
        });
      }
    }
    
    return results;
  }

  /**
   * 获取使用统计
   */
  getUsageStats(): { tencent: number; mymemory: number; deepseek: number } {
    return { ...this.useCount };
  }

  /**
   * 获取缓存大小（兼容性方法）
   */
  getCacheSize(): number {
    return 0;
  }
}

// 导出单例
export const translator = new Translator();
