/**
 * 图片检测模块 v3
 * 简化逻辑，支持多种图片格式
 */

export interface DetectedImage {
  element: HTMLElement;
  src: string;
  position: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  aspectRatio: number;
  isManga: boolean;
}

// 需要过滤的图片格式/来源模式
const EXCLUDED_PATTERNS = [
  // GIF 动画（通常是广告）
  /\.gif$/i,
  // 常见的广告图片域名
  /doubleclick\.net/i,
  /googlesyndication\.com/i,
  /googleadservices\.com/i,
  /analytics/i,
  /tracking/i,
  /banner/i,
  /advertisement/i,
  /ad\./i,
  // 常见的社交分享按钮图片
  /share\.png/i,
  /social-/i,
  /icon-/i,
  // 常见的占位图片
  /placeholder/i,
  /spacer\.gif/i,
  /transparent\.png/i
];

// 最小图片尺寸阈值（长宽均小于此值时过滤）
const MIN_IMAGE_SIZE = 500;
// 最大长宽比阈值（超过此比例过滤，如又扁又长的横幅广告）
const MAX_ASPECT_RATIO = 4;

/**
 * 检查图片是否应该被过滤（广告/无关图片/小尺寸预览图）
 */
function shouldExcludeImage(src: string, width: number, height: number): boolean {
  // 【修改1】长宽均小于 MIN_IMAGE_SIZE 时过滤
  if (width < MIN_IMAGE_SIZE && height < MIN_IMAGE_SIZE) {
    console.log(`[MangaLens] 过滤小尺寸预览图: ${width}x${height}`);
    return true;
  }
  
  // 【修改2】过滤极端长宽比的图片（又扁又长的广告，如150x700）
  const aspectRatio = Math.max(width / height, height / width);
  if (aspectRatio > MAX_ASPECT_RATIO) {
    console.log(`[MangaLens] 过滤极端长宽比图片: ${width}x${height} (比例: ${aspectRatio.toFixed(2)})`);
    return true;
  }
  
  // 检查 URL 模式
  for (const pattern of EXCLUDED_PATTERNS) {
    if (pattern.test(src)) {
      console.log(`[MangaLens] 过滤广告图片: ${src}`);
      return true;
    }
  }
  
  return false;
}

export class ImageDetector {
  /**
   * 检测页面中的漫画图片（极简版）
   */
  detectMangaImages(): DetectedImage[] {
    const mangaImages: DetectedImage[] = [];

    // 1. 检测所有 img 标签（只检查尺寸）
    const imgs = document.querySelectorAll('img');
    console.log(`[MangaLens] 检测到 ${imgs.length} 个图片元素`);
    
    imgs.forEach((img) => {
      const rect = img.getBoundingClientRect();
      
      // 只检查：尺寸足够大且可见
      if (rect.width >= 30 && rect.height >= 30 && rect.width > 0) {
        const info = this.analyzeImage(img as HTMLImageElement);
        if (info && info.src) {
          mangaImages.push(info);
          console.log(`[MangaLens] 候选图片: ${info.width}x${info.height} - ${info.src.substring(0, 50)}...`);
        }
      }
    });

    // 2. 也检查一些常见的图片容器
    const containers = document.querySelectorAll('[style*="background"], [data-src], picture, figure');
    containers.forEach((container) => {
      const rect = container.getBoundingClientRect();
      if (rect.width >= 30 && rect.height >= 30) {
        const info = this.analyzeElement(container as HTMLElement);
        if (info && info.src && !mangaImages.some(img => img.src === info.src)) {
          mangaImages.push(info);
        }
      }
    });

    console.log(`[MangaLens] 最终候选图片数量: ${mangaImages.length}`);
    return mangaImages;
  }

  /**
   * 分析任意元素
   */
  private analyzeElement(element: HTMLElement): DetectedImage | null {
    const rect = element.getBoundingClientRect();
    
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    let src = '';

    // 尝试获取图片 URL
    if (element.tagName === 'IMG') {
      src = (element as HTMLImageElement).src;
    } else if (element.dataset.src) {
      src = element.dataset.src;
    } else if (element.style.backgroundImage) {
      const match = element.style.backgroundImage.match(/url\(["']?([^"']+)["']?\)/);
      if (match) src = match[1];
    }

    // 查找子元素中的图片
    if (!src) {
      const img = element.querySelector('img');
      if (img) src = img.src || img.dataset.src || '';
    }
    const source = element.querySelector('source');
    if (source && !src) {
      src = (source as HTMLSourceElement).srcset?.split(' ')[0] || '';
    }

    if (!src) {
      return null;
    }
    
    // 过滤广告图片和 GIF
    if (shouldExcludeImage(src, rect.width, rect.height)) {
      return null;
    }

    return {
      element: element,
      src: src,
      position: {
        x: rect.left + window.scrollX,
        y: rect.top + window.scrollY,
        width: rect.width,
        height: rect.height
      },
      aspectRatio: rect.height / rect.width,
      isManga: true
    };
  }

  /**
   * 分析 img 元素
   */
  private analyzeImage(img: HTMLImageElement): DetectedImage | null {
    const rect = img.getBoundingClientRect();
    
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    let src = img.src || img.dataset?.src || img.dataset?.lazySrc || '';
    
    if (!src) {
      return null;
    }
    
    // 过滤广告图片和 GIF
    if (shouldExcludeImage(src, rect.width, rect.height)) {
      return null;
    }

    return {
      element: img,
      src: src,
      position: {
        x: rect.left + window.scrollX,
        y: rect.top + window.scrollY,
        width: rect.width,
        height: rect.height
      },
      aspectRatio: rect.height / rect.width,
      isManga: true
    };
  }

  /**
   * 手动选择图片（简化版）
   */
  async selectImage(): Promise<DetectedImage | null> {
    return new Promise((resolve) => {
      console.log('[MangaLens] 进入手动选择模式');
      
      // 保存 this 引用
      const detector = this;
      
      // 创建选择提示
      const instruction = document.createElement('div');
      instruction.id = 'manga-lens-selector-instruction';
      instruction.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: linear-gradient(135deg, #667eea, #764ba2);
        color: white;
        padding: 16px 32px;
        border-radius: 12px;
        font-size: 18px;
        font-family: 'Microsoft YaHei', sans-serif;
        z-index: 2147483647;
        box-shadow: 0 4px 20px rgba(102, 126, 234, 0.5);
        text-align: center;
      `;
      instruction.innerHTML = '🎯 点击漫画图片进行翻译<br><span style="font-size:14px;opacity:0.8">按 ESC 取消</span>';

      document.body.appendChild(instruction);

      // 清理函数
      const cleanup = () => {
        const el = document.getElementById('manga-lens-selector-instruction');
        if (el) el.remove();
        document.removeEventListener('click', handleClick, true);
        document.removeEventListener('keydown', handleKeydown);
      };

      // 点击处理函数
      const handleClick = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();

        const target = e.target as HTMLElement;
        
        // 查找图片元素
        let imageElement: HTMLElement | null = null;
        
        if (target.tagName === 'IMG') {
          imageElement = target;
        } else {
          imageElement = target.closest('img, picture, figure, [data-src], div') as HTMLElement;
        }

        if (imageElement) {
          const info = detector.analyzeElement(imageElement);
          if (info && info.src) {
            cleanup();
            console.log('[MangaLens] 用户选择了图片:', info.src.substring(0, 50));
            resolve(info);
            return;
          }
        }
        
        // 没找到图片，提示用户
        alert('请点击漫画图片区域！');
      };

      // ESC 取消
      const handleKeydown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          console.log('[MangaLens] 用户取消选择');
          cleanup();
          resolve(null);
        }
      };

      document.addEventListener('click', handleClick, true);
      document.addEventListener('keydown', handleKeydown);
      
      console.log('[MangaLens] 等待用户选择图片...');
    });
  }

  /**
   * 监听页面变化（新图片、懒加载、滚动刷新）
   * 支持多种图片加载方式：
   * 1. DOM 新增节点
   * 2. 懒加载（src/data-src 变化）
   * 3. Intersection Observer 触发的图片
   */
  observeNewImages(callback: (images: DetectedImage[]) => void): () => void {
    const processedSrcs = new Set<string>();
    const pendingImages = new Map<string, { element: HTMLElement; src: string; timeout: number }>();
    const DEBOUNCE_MS = 500; // 防抖延迟

    // 处理待处理的图片（防抖）
    const processPending = () => {
      const now = Date.now();
      pendingImages.forEach((data, src) => {
        if (now >= data.timeout) {
          const info = this.analyzeElement(data.element);
          if (info && info.src && !processedSrcs.has(info.src)) {
            processedSrcs.add(info.src);
            callback([info]);
          }
          pendingImages.delete(src);
        }
      });
    };

    // 定期检查待处理图片
    const intervalId = setInterval(processPending, DEBOUNCE_MS);

    // 1. MutationObserver：监听 DOM 新增节点
    const mutationObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeName === 'IMG' || node.nodeName === 'PICTURE' || node.nodeName === 'FIGURE') {
            const element = node as HTMLElement;
            const src = element.tagName === 'IMG' 
              ? (element as HTMLImageElement).src 
              : this.extractSrcFromElement(element);
            
            if (src && !processedSrcs.has(src)) {
              pendingImages.set(src, {
                element,
                src,
                timeout: Date.now() + DEBOUNCE_MS
              });
            }
          }
        });
      });
    });

    // 2. 监听已存在图片的 src/data-src 变化（懒加载模式）
    const existingImages = document.querySelectorAll('img');
    existingImages.forEach((img) => {
      // 保存初始 src
      const initialSrc = img.src || img.dataset?.src || img.dataset?.lazySrc || '';
      if (initialSrc) {
        processedSrcs.add(initialSrc);
      }

      // 监听 src 属性变化
      const srcObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (mutation.type === 'attributes' && mutation.attributeName === 'src') {
            const newSrc = (mutation.target as HTMLImageElement).src;
            if (newSrc && !processedSrcs.has(newSrc)) {
              pendingImages.set(newSrc, {
                element: mutation.target as HTMLElement,
                src: newSrc,
                timeout: Date.now() + DEBOUNCE_MS
              });
            }
          }
        });
      });
      srcObserver.observe(img, { attributes: true, attributeFilter: ['src', 'data-src', 'data-lazy-src'] });
    });

    // 3. Intersection Observer：检测图片进入视口（更可靠的懒加载检测）
    const intersectionObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const img = entry.target as HTMLImageElement;
          const src = img.src || img.dataset?.src || img.dataset?.lazySrc || '';
          
          if (src && !processedSrcs.has(src)) {
            pendingImages.set(src, {
              element: img,
              src,
              timeout: Date.now() + DEBOUNCE_MS
            });
          }
        }
      });
    }, {
      root: null, // viewport
      rootMargin: '100px', // 提前 100px 开始处理
      threshold: 0
    });

    // 对所有当前图片和未来图片启用 Intersection Observer
    const observeImage = (img: HTMLImageElement) => {
      const src = img.src || img.dataset?.src || img.dataset?.lazySrc || '';
      if (src && !processedSrcs.has(src)) {
        intersectionObserver.observe(img);
      }
    };

    existingImages.forEach(observeImage);

    // 监听新的 img 元素（通过 MutationObserver）
    const newImgObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeName === 'IMG') {
            observeImage(node as HTMLImageElement);
          }
          // 也检查 Picture 或 Figure 内的 img
          if (node.nodeName === 'PICTURE' || node.nodeName === 'FIGURE') {
            const img = (node as HTMLElement).querySelector('img');
            if (img) observeImage(img);
          }
        });
      });
    });

    // 启动所有观察器
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
    newImgObserver.observe(document.body, {
      childList: true,
      subtree: true
    });

    // 清理函数
    return () => {
      mutationObserver.disconnect();
      newImgObserver.disconnect();
      intersectionObserver.disconnect();
      clearInterval(intervalId);
      pendingImages.forEach((data) => clearTimeout(data.timeout));
      pendingImages.clear();
    };
  }

  /**
   * 从元素中提取 src
   */
  private extractSrcFromElement(element: HTMLElement): string {
    if (element.tagName === 'IMG') {
      return (element as HTMLImageElement).src;
    }
    if (element.dataset.src) {
      return element.dataset.src;
    }
    if (element.style.backgroundImage) {
      const match = element.style.backgroundImage.match(/url\(["']?([^"']+)["']?\)/);
      if (match) return match[1];
    }
    const img = element.querySelector('img');
    if (img) return img.src || img.dataset?.src || '';
    return '';
  }
}

// 导出单例
export const imageDetector = new ImageDetector();
