/**
 * 翻译结果本地缓存模块
 * 
 * 功能：
 * 1. 将已翻译的 MergedDialog[] 按图片 URL 缓存到 chrome.storage.local
 * 2. 提供读取/写入/删除/清空接口
 * 3. 支持启用/禁用缓存读取开关（方便调试）
 * 4. 自动淘汰最早条目，上限 200 条
 */

import type { MergedDialog } from './dialog-merger';

const CACHE_STORAGE_KEY = 'mangaLensCache';
const CACHE_ENABLED_KEY = 'mangaLensCacheEnabled';

interface CachedEntry {
  /** 图片 URL */
  imageUrl: string;
  /** 合并并翻译后的对话数据 */
  dialogs: MergedDialog[];
  /** 缓存时间戳 */
  timestamp: number;
}

class TranslationCache {
  private cacheEnabled = true;

  // ==================== 开关控制 ====================

  /** 是否启用缓存读取 */
  isEnabled(): boolean {
    return this.cacheEnabled;
  }

  /** 设置缓存读取开关 */
  async setEnabled(enabled: boolean): Promise<void> {
    this.cacheEnabled = enabled;
    try {
      await chrome.storage.local.set({ [CACHE_ENABLED_KEY]: enabled });
      console.log(`[Cache] 缓存读取已${enabled ? '启用' : '禁用'}`);
    } catch (e) {
      console.warn('[Cache] 保存开关状态失败:', e);
    }
  }

  /** 从 storage 加载开关状态 */
  async loadEnabledState(): Promise<void> {
    try {
      const result = await chrome.storage.local.get([CACHE_ENABLED_KEY]);
      this.cacheEnabled = result[CACHE_ENABLED_KEY] !== false; // 默认启用
      console.log(`[Cache] 加载缓存状态: ${this.cacheEnabled ? '启用' : '禁用'}`);
    } catch (e) {
      this.cacheEnabled = true;
    }
  }

  // ==================== 缓存读写 ====================

  /** 获取全部缓存数据 */
  private async loadAll(): Promise<Record<string, CachedEntry>> {
    try {
      const result = await chrome.storage.local.get([CACHE_STORAGE_KEY]);
      return result[CACHE_STORAGE_KEY] || {};
    } catch (e) {
      console.warn('[Cache] 读取缓存失败:', e);
      return {};
    }
  }

  /** 保存全部缓存数据 */
  private async saveAll(cache: Record<string, CachedEntry>): Promise<void> {
    try {
      await chrome.storage.local.set({ [CACHE_STORAGE_KEY]: cache });
    } catch (e) {
      console.warn('[Cache] 保存缓存失败（可能超出配额）:', e);
    }
  }

  /**
   * 读取指定图片的缓存
   * @returns 缓存对话数据，未命中返回 null
   */
  async get(imageUrl: string): Promise<MergedDialog[] | null> {
    if (!this.cacheEnabled) {
      return null;
    }
    try {
      const cache = await this.loadAll();
      const entry = cache[imageUrl];
      if (entry && entry.dialogs && entry.dialogs.length > 0) {
        console.log(`[Cache] ✅ 命中: ${imageUrl.substring(0, 50)}... (${entry.dialogs.length} 个对话)`);
        return entry.dialogs;
      }
    } catch (e) {
      console.warn('[Cache] 读取条目失败:', e);
    }
    return null;
  }

  /**
   * 保存指定图片的翻译结果
   */
  async set(imageUrl: string, dialogs: MergedDialog[]): Promise<void> {
    try {
      const cache = await this.loadAll();
      cache[imageUrl] = {
        imageUrl,
        dialogs,
        timestamp: Date.now()
      };

      // 超过上限时淘汰最早条目
      const entries = Object.entries(cache);
      const MAX_ENTRIES = 200;
      if (entries.length > MAX_ENTRIES) {
        entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
        const removeCount = entries.length - MAX_ENTRIES;
        for (let i = 0; i < removeCount; i++) {
          delete cache[entries[i][0]];
        }
        console.log(`[Cache] 淘汰 ${removeCount} 条最早缓存`);
      }

      await this.saveAll(cache);
      console.log(`[Cache] 💾 已保存: ${imageUrl.substring(0, 50)}... (共 ${Object.keys(cache).length} 条)`);
    } catch (e) {
      console.warn('[Cache] 保存条目失败:', e);
    }
  }

  /**
   * 删除指定图片的缓存
   */
  async delete(imageUrl: string): Promise<void> {
    try {
      const cache = await this.loadAll();
      if (cache[imageUrl]) {
        delete cache[imageUrl];
        await this.saveAll(cache);
        console.log(`[Cache] 🗑️ 已删除: ${imageUrl.substring(0, 50)}...`);
      }
    } catch (e) {
      console.warn('[Cache] 删除条目失败:', e);
    }
  }

  /**
   * 清空全部缓存
   */
  async clearAll(): Promise<void> {
    try {
      await chrome.storage.local.remove([CACHE_STORAGE_KEY]);
      console.log('[Cache] 🔄 已清空全部缓存');
    } catch (e) {
      console.warn('[Cache] 清空缓存失败:', e);
    }
  }

  /**
   * 获取缓存条目数量
   */
  async getSize(): Promise<number> {
    try {
      const cache = await this.loadAll();
      return Object.keys(cache).length;
    } catch {
      return 0;
    }
  }
}

/** 单例导出 */
export const translationCache = new TranslationCache();
