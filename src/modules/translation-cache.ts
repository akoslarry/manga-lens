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
import { FONT_SIZE_ALGO_VERSION } from './font-fitter';

const CACHE_STORAGE_KEY = 'mangaLensCache';
const CACHE_ENABLED_KEY = 'mangaLensCacheEnabled';

interface CachedEntry {
  /** 图片 URL */
  imageUrl: string;
  /** 合并并翻译后的对话数据 */
  dialogs: MergedDialog[];
  /** 缓存时间戳 */
  timestamp: number;
  /**
   * 字体大小算法版本号（条目级）
   *
   * 与每个 dialog 的 fontSizeVersion 保持一致，冗余存储在条目上便于快速判断
   * 整条缓存是否需要迁移。低于 FONT_SIZE_ALGO_VERSION 时会在读取时触发重算。
   */
  fontSizeVersion?: number;
}

class TranslationCache {
  private cacheEnabled = true;

  // 写操作互斥锁：串行化「读-改-写」，避免并发 set/delete 互相覆盖丢失条目
  private writeQueue: Promise<void> = Promise.resolve();

  /** 串行执行写操作（读-改-写原子化） */
  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(fn);
    // 无论成功失败都释放锁（用 catch 吞掉错误避免锁链断裂）
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

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
    // 诊断：打印当前缓存整体积大小（估算，序列化后字节数）
    try {
      const sizeBytes = JSON.stringify(cache).length;
      const sizeKB = (sizeBytes / 1024).toFixed(1);
      const sizeMB = (sizeBytes / 1024 / 1024).toFixed(2);
      console.log(`[Cache] 📊 缓存体积: ${sizeBytes} 字节 (${sizeKB} KB / ${sizeMB} MB)，条目 ${Object.keys(cache).length} 条`);
    } catch (sizeErr) {
      console.warn('[Cache] 计算缓存体积失败:', sizeErr);
    }

    try {
      await chrome.storage.local.set({ [CACHE_STORAGE_KEY]: cache });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isQuota = /quota|exceed|maximum|MAX_WRITE/i.test(msg);
      console.error(
        `[Cache] ❌ 保存缓存失败${isQuota ? '（确认超出 storage.local 配额 10MB！）' : ''}:`,
        e
      );
    }
  }

  /**
   * 读取指定图片的缓存
   * @returns 缓存对话数据：
   *   - null：无缓存条目（从未翻译过该图片）
   *   - []（空数组）：纯场景页，已确认无文字（OCR 识别 0 个文本框）
   *   - 非空数组：有对话数据（含翻译结果）
   */
  async get(imageUrl: string): Promise<MergedDialog[] | null> {
    if (!this.cacheEnabled) {
      return null;
    }
    try {
      const cache = await this.loadAll();
      const entry = cache[imageUrl];
      if (entry) {
        if (entry.dialogs && entry.dialogs.length > 0) {
          console.log(`[Cache] ✅ 命中: ${imageUrl.substring(0, 50)}... (${entry.dialogs.length} 个对话)`);
        } else {
          console.log(`[Cache] ✅ 命中（纯场景页，无文字）: ${imageUrl.substring(0, 50)}...`);
        }

        // 🔧 字体算法版本迁移：版本缺失或落后时，标记并回写缓存
        //    字号本身不持久化（渲染时实时计算），因此只需升版本号，
        //    渲染阶段会自动使用最新算法重新计算字体大小。
        if (this.needsFontSizeMigration(entry)) {
          this.migrateFontSizeVersion(imageUrl, entry).catch((e) => {
            console.warn('[Cache] 字体版本迁移回写失败:', e);
          });
        }

        return entry.dialogs;
      }
      // 未命中：打印查询 key 与缓存中存在的 key，辅助定位 key 不匹配问题
      console.warn(`[Cache] ❌ 未命中: ${imageUrl}`);
      const keys = Object.keys(cache);
      console.warn(`[Cache] 缓存中现有 ${keys.length} 个 key:`);
      // 打印前 20 个 key 便于对比
      keys.slice(0, 20).forEach((k, i) => console.warn(`[Cache]   [${i}] ${k}`));
      if (keys.length > 20) {
        console.warn(`[Cache]   ... 其余 ${keys.length - 20} 个 key 省略`);
      }
    } catch (e) {
      console.warn('[Cache] 读取条目失败:', e);
    }
    return null;
  }

  /** 判断条目是否需要字体算法版本迁移 */
  private needsFontSizeMigration(entry: CachedEntry): boolean {
    const entryVer = entry.fontSizeVersion;
    if (entryVer === undefined || entryVer < FONT_SIZE_ALGO_VERSION) return true;
    // 兼容早期只写了 dialog 级版本号、条目级缺失的情况
    return (entry.dialogs || []).some(
      (d) => d.fontSizeVersion === undefined || d.fontSizeVersion < FONT_SIZE_ALGO_VERSION
    );
  }

  /**
   * 将条目的字体算法版本升级到当前版本并回写缓存
   *
   * 说明：字号不持久化，渲染时按最新算法实时计算，因此迁移只需更新版本标记，
   * 无需修改 dialogs 的其他数据；用户的手动调整（customFontSize 等）会被保留。
   */
  private async migrateFontSizeVersion(imageUrl: string, entry: CachedEntry): Promise<void> {
    await this.withWriteLock(async () => {
      const cache = await this.loadAll();
      const current = cache[imageUrl];
      if (!current) return;

      // 保留用户手动设置的字体大小，不因算法升级而清空
      for (const d of current.dialogs || []) {
        d.fontSizeVersion = FONT_SIZE_ALGO_VERSION;
      }
      current.fontSizeVersion = FONT_SIZE_ALGO_VERSION;

      await this.saveAll(cache);
      console.log(
        `[Cache] 🔄 字体算法已迁移至 v${FONT_SIZE_ALGO_VERSION}: ${imageUrl.substring(0, 50)}...`
      );
    });
  }

  /**
   * 保存指定图片的翻译结果
   */
  async set(imageUrl: string, dialogs: MergedDialog[]): Promise<void> {
    await this.withWriteLock(async () => {
      try {
        const cache = await this.loadAll();
        // 🔧 写入时统一打上当前字体算法版本号
        //    每个 dialog 与条目本身都记录，便于后续按版本判断是否需重算
        for (const d of dialogs) {
          d.fontSizeVersion = FONT_SIZE_ALGO_VERSION;
        }
        cache[imageUrl] = {
          imageUrl,
          dialogs,
          timestamp: Date.now(),
          fontSizeVersion: FONT_SIZE_ALGO_VERSION
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
    });
  }

  /**
   * 删除指定图片的缓存
   */
  async delete(imageUrl: string): Promise<void> {
    await this.withWriteLock(async () => {
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
    });
  }

  /**
   * 清空全部缓存
   */
  async clearAll(): Promise<void> {
    await this.withWriteLock(async () => {
      try {
        await chrome.storage.local.remove([CACHE_STORAGE_KEY]);
        console.log('[Cache] 🔄 已清空全部缓存');
      } catch (e) {
        console.warn('[Cache] 清空缓存失败:', e);
      }
    });
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
