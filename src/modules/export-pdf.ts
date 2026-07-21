/**
 * PDF导出模块 - MangaLens v4.0
 *
 * 功能：
 * 1. PDF模式浮动工具栏（导出全部/导出选中/全选/退出）
 * 2. 图片选择框（手动勾选导出目标，记录选中顺序）
 * 3. PDF生成（html2canvas截图 + jsPDF写入，每图一页）
 * 4. 进度条反馈
 */

import html2canvas from 'html2canvas';
import { jsPDF } from 'jspdf';

// ============================================
// 类型定义
// ============================================

export interface ExportTarget {
  imageSrc: string;
  imageElement: HTMLImageElement;
  containerElement: HTMLElement;   // 覆盖层容器 (position:absolute 的那个)
  parentElement: HTMLElement;      // 包含 img + container 的外层容器
  pageOrder: number;               // 在PDF中的页码
}

export interface PDFExporterCallbacks {
  /** 请求图片覆盖层数据（从 overlayManager 获取） */
  getOverlaysForImage: (imageEl: HTMLImageElement) => HTMLElement[];
  /** 获取已翻译图片列表 */
  getTranslatedImages: () => HTMLImageElement[];
  /** 获取指定图片的覆盖层容器 */
  getContainerForImage: (imageEl: HTMLImageElement) => HTMLElement | undefined;
  /** 退出PDF模式时调用（content-script 处理确认弹窗） */
  onExitRequest: () => void;
  /** 持久化用户修改 */
  onSaveEdits: (imageSrc: string, overlays: HTMLElement[]) => void;
}

// ============================================
// PDFExporter 主体
// ============================================

export class PDFExporter {
  private isPdfMode = false;
  private savePath = '';
  private selectedImages = new Map<string, number>(); // imageSrc → 选中序号(1-based)
  private selectionCounter = 0;                        // 累加选中序号
  private toolbar: HTMLElement | null = null;
  private progressBar: HTMLElement | null = null;
  private checkboxes: Map<string, HTMLElement> = new Map(); // imageSrc → 选择框元素
  private callbacks: PDFExporterCallbacks;
  private editingOverlay: HTMLElement | null = null; // 当前正在编辑的覆盖层
  private modifiedContainers = new Set<HTMLElement>(); // PDF模式下 pointer-events 被改为 auto 的容器

  // 工具栏按钮引用
  private btnExportAll: HTMLElement | null = null;
  private btnExportSelected: HTMLElement | null = null;
  private btnSelectAll: HTMLElement | null = null;
  private labelCount: HTMLElement | null = null;

  constructor(callbacks: PDFExporterCallbacks) {
    this.callbacks = callbacks;
  }

  /** 配置回调（由 content-script 在初始化时调用） */
  configure(callbacks: PDFExporterCallbacks): void {
    this.callbacks = callbacks;
  }

  // ============================================
  // 模式管理
  // ============================================

  /** 是否在PDF模式中 */
  get pdfMode(): boolean {
    return this.isPdfMode;
  }

  /** 获取保存子目录 */
  getSavePath(): string {
    return this.savePath;
  }

  /** 进入PDF编辑模式 */
  enterPdfMode(savePath: string): void {
    if (this.isPdfMode) return;
    this.isPdfMode = true;
    this.savePath = savePath;
    this.selectedImages.clear();
    this.selectionCounter = 0;

    // 1. 创建浮动工具栏
    this.createToolbar();

    // 2. 为所有已翻译图片创建选择框（默认全选）
    this.refreshCheckboxes();

    // 3. 页面顶部偏移（防止工具栏遮挡内容）
    document.documentElement.style.scrollPaddingTop = '60px';
    document.body.style.paddingTop = '60px';

    console.log('[PDFExport] ✅ 进入PDF导出模式, 保存目录:', savePath || '(默认)');
  }

  /** 退出PDF编辑模式 */
  exitPdfMode(): void {
    if (!this.isPdfMode) return;

    // 移除工具栏
    this.removeToolbar();

    // 移除所有选择框
    this.checkboxes.forEach((checkbox) => {
      if (checkbox.parentElement) checkbox.remove();
    });
    this.checkboxes.clear();

    // 移除进度条
    this.removeProgressBar();

    // 恢复页面偏移
    document.documentElement.style.scrollPaddingTop = '';
    document.body.style.paddingTop = '';

    // 清理编辑态覆盖层
    this.clearEditingState();

    this.isPdfMode = false;
    this.selectedImages.clear();
    this.selectionCounter = 0;

    console.log('[PDFExport] ❌ 退出PDF导出模式');
  }

  // ============================================
  // 浮动工具栏
  // ============================================

  private createToolbar(): void {
    // 移除旧工具栏
    this.removeToolbar();

    const toolbar = document.createElement('div');
    toolbar.id = 'manga-lens-pdf-toolbar';
    toolbar.innerHTML = `
      <style>
        #manga-lens-pdf-toolbar {
          position: fixed; top: 0; left: 0; right: 0;
          z-index: 2147483647;
          height: 52px;
          background: linear-gradient(135deg, #1a1a2e, #16213e);
          border-bottom: 1px solid rgba(102,126,234,0.4);
          display: flex; align-items: center; padding: 0 16px; gap: 10px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          color: #e0e0e0; font-size: 13px;
          box-shadow: 0 2px 16px rgba(0,0,0,0.5);
        }
        #manga-lens-pdf-toolbar .ml-pdf-btn {
          padding: 7px 14px; border: none; border-radius: 8px;
          font-size: 13px; font-weight: 500; cursor: pointer;
          transition: all 0.2s; white-space: nowrap;
        }
        .ml-pdf-btn-export-all {
          background: linear-gradient(135deg, #667eea, #764ba2);
          color: #fff;
        }
        .ml-pdf-btn-export-all:hover { opacity: 0.9; transform: translateY(-1px); }
        .ml-pdf-btn-export-selected {
          background: linear-gradient(135deg, #f57c00, #ff9800);
          color: #fff;
        }
        .ml-pdf-btn-export-selected:hover { opacity: 0.9; transform: translateY(-1px); }
        .ml-pdf-btn-export-selected:disabled {
          opacity: 0.4; cursor: not-allowed; transform: none;
        }
        .ml-pdf-btn-select-all {
          background: rgba(255,255,255,0.1);
          color: #c0c0d0; border: 1px solid rgba(255,255,255,0.15);
        }
        .ml-pdf-btn-select-all:hover { background: rgba(255,255,255,0.18); }
        .ml-pdf-btn-exit {
          background: rgba(255,80,80,0.15);
          color: #ff6666; border: 1px solid rgba(255,80,80,0.3);
          margin-left: auto;
        }
        .ml-pdf-btn-exit:hover { background: rgba(255,80,80,0.25); }
        .ml-pdf-info {
          color: #888; font-size: 12px; border-left: 1px solid rgba(255,255,255,0.1);
          padding-left: 10px;
        }
      </style>
      <span style="font-weight:600;color:#fff;">📄 PDF导出模式</span>
      <button class="ml-pdf-btn ml-pdf-btn-export-all" id="ml-pdf-btn-export-all">📦 导出全部</button>
      <button class="ml-pdf-btn ml-pdf-btn-export-selected" id="ml-pdf-btn-export-selected" disabled>
        ✅ 导出选中 (<span id="ml-pdf-selected-count">0</span>)
      </button>
      <button class="ml-pdf-btn ml-pdf-btn-select-all" id="ml-pdf-btn-select-all">⬜ 取消全选</button>
      <span class="ml-pdf-info" id="ml-pdf-toolbar-info">已翻译: 0 | 已选中: 0</span>
      <button class="ml-pdf-btn ml-pdf-btn-exit" id="ml-pdf-btn-exit">❌ 退出</button>
    `;

    document.body.appendChild(toolbar);
    this.toolbar = toolbar;

    // 绑定按钮事件
    this.btnExportAll = toolbar.querySelector('#ml-pdf-btn-export-all');
    this.btnExportSelected = toolbar.querySelector('#ml-pdf-btn-export-selected');
    this.btnSelectAll = toolbar.querySelector('#ml-pdf-btn-select-all');
    this.labelCount = toolbar.querySelector('#ml-pdf-toolbar-info');

    this.btnExportAll?.addEventListener('click', () => this.exportAll());
    this.btnExportSelected?.addEventListener('click', () => this.exportSelected());
    this.btnSelectAll?.addEventListener('click', () => this.toggleSelectAll());
    toolbar.querySelector('#ml-pdf-btn-exit')?.addEventListener('click', () => this.callbacks.onExitRequest());

    this.updateToolbarCounts();
  }

  private removeToolbar(): void {
    if (this.toolbar && this.toolbar.parentElement) {
      this.toolbar.remove();
    }
    this.toolbar = null;
    this.btnExportAll = null;
    this.btnExportSelected = null;
    this.btnSelectAll = null;
    this.labelCount = null;
  }

  /** 更新工具栏计数显示 */
  updateToolbarCounts(): void {
    if (!this.labelCount) return;

    const images = this.callbacks.getTranslatedImages();
    const translated = images.length;
    const selected = this.selectedImages.size;

    this.labelCount.textContent = `已翻译: ${translated} | 已选中: ${selected}`;

    // 更新导出选中按钮的状态和计数
    const countSpan = document.getElementById('ml-pdf-selected-count');
    if (countSpan) countSpan.textContent = String(selected);

    if (this.btnExportSelected) {
      (this.btnExportSelected as HTMLButtonElement).disabled = selected === 0;
    }

    // 全选按钮文字
    if (this.btnSelectAll) {
      this.btnSelectAll.textContent = selected === translated && translated > 0
        ? '☑ 取消全选' : '⬜ 全选';
    }
  }

  // ============================================
  // 图片选择
  // ============================================

  /** 为指定图片创建选择框（默认选中） */
  createCheckbox(imageEl: HTMLImageElement, containerEl: HTMLElement): void {
    // containerEl 保留用于未来扩展（如检测覆盖层容器状态）
    void containerEl;
    const imageSrc = imageEl.src;
    if (this.checkboxes.has(imageSrc)) return;

    // 创建选择框
    const checkbox = document.createElement('div');
    checkbox.className = 'manga-lens-pdf-checkbox selected';
    checkbox.dataset.imageSrc = imageSrc;
    checkbox.innerHTML = '<span class="ml-pdf-check-mark">✓</span>';
    checkbox.title = '点击切换选中/取消';

    // 默认选中
    this.selectionCounter++;
    this.selectedImages.set(imageSrc, this.selectionCounter);

    // 序号角标
    const badge = document.createElement('div');
    badge.className = 'manga-lens-pdf-order-badge';
    badge.textContent = String(this.selectionCounter);
    checkbox.appendChild(badge);

    // 挂载到 body，使用 fixed 定位
    document.body.appendChild(checkbox);

    // 注册位置更新器
    const updatePos = () => this.updateCheckboxPosition(imageEl, checkbox);
    updatePos();
    this.positionUpdaters.push(updatePos);
    this.ensureScrollListener();

    // 点击切换
    checkbox.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.toggleImageSelection(imageSrc, checkbox, imageEl);
    });

    this.checkboxes.set(imageSrc, checkbox);
    this.updateToolbarCounts();
  }

  /** 更新已翻译图片的选择框（新翻译完成时调用） */
  refreshCheckboxes(): void {
    const images = this.callbacks.getTranslatedImages();
    const seen = new Set<string>();

    for (const img of images) {
      seen.add(img.src);
      if (!this.checkboxes.has(img.src)) {
        // 新翻译完成的图片 → 创建选择框
        // 找父容器
        const parent = img.parentElement;
        if (parent) {
          this.createCheckbox(img, parent);
        }
      }
    }

    // 移除已不存在的图片选择框
    this.checkboxes.forEach((_checkbox, src) => {
      if (!seen.has(src)) {
        this.removeCheckbox(src);
      }
    });

    this.updateToolbarCounts();
  }

  /** 更新选择框固定位置 */
  private updateCheckboxPosition(imageEl: HTMLImageElement, checkbox: HTMLElement): void {
    const rect = imageEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      checkbox.style.display = 'none';
      return;
    }

    checkbox.style.display = 'flex';
    checkbox.style.cssText = `
      position: fixed;
      top: ${rect.top + 8}px;
      left: ${rect.right - 36}px;
      z-index: 2147483646;
      width: 28px; height: 28px;
      border-radius: 8px;
      border: 2px solid rgba(102,126,234,0.6);
      background: rgba(26,26,46,0.9);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s;
      pointer-events: auto;
    `;
  }

  /** 切换单张图片选中状态 */
  private toggleImageSelection(imageSrc: string, checkbox: HTMLElement, _imageEl: HTMLImageElement): void {
    if (this.selectedImages.has(imageSrc)) {
      // 取消选中
      this.selectedImages.delete(imageSrc);
      checkbox.classList.remove('selected');
      const checkMark = checkbox.querySelector('.ml-pdf-check-mark') as HTMLElement;
      if (checkMark) checkMark.style.display = 'none';
      // 移除序号角标
      const badge = checkbox.querySelector('.manga-lens-pdf-order-badge');
      if (badge) badge.remove();
    } else {
      // 选中
      this.selectionCounter++;
      this.selectedImages.set(imageSrc, this.selectionCounter);
      checkbox.classList.add('selected');
      const checkMark = checkbox.querySelector('.ml-pdf-check-mark') as HTMLElement;
      if (checkMark) checkMark.style.display = '';
      // 添加序号角标
      let badge = checkbox.querySelector('.manga-lens-pdf-order-badge') as HTMLElement;
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'manga-lens-pdf-order-badge';
        badge.style.cssText = `
          position: absolute; top: -6px; left: -6px;
          width: 18px; height: 18px;
          background: #ff9800; color: #fff;
          border-radius: 50%; font-size: 10px;
          text-align: center; line-height: 18px;
          font-weight: 600; pointer-events: none;
        `;
        checkbox.appendChild(badge);
      }
      badge.textContent = String(this.selectionCounter);
    }

    this.updateToolbarCounts();
  }

  private removeCheckbox(imageSrc: string): void {
    const checkbox = this.checkboxes.get(imageSrc);
    if (checkbox) {
      if (checkbox.parentElement) checkbox.remove();
      this.checkboxes.delete(imageSrc);
      this.selectedImages.delete(imageSrc);
    }
  }

  /** 全选/取消全选 */
  private toggleSelectAll(): void {
    const images = this.callbacks.getTranslatedImages();

    if (this.selectedImages.size === images.length && images.length > 0) {
      // 取消全选
      this.selectedImages.clear();
      this.selectionCounter = 0;
      this.checkboxes.forEach((checkbox) => {
        checkbox.classList.remove('selected');
        const checkMark = checkbox.querySelector('.ml-pdf-check-mark') as HTMLElement;
        if (checkMark) checkMark.style.display = 'none';
        const badge = checkbox.querySelector('.manga-lens-pdf-order-badge');
        if (badge) badge.remove();
      });
    } else {
      // 全选（保持当前计数器继续累加）
      for (const img of images) {
        if (!this.selectedImages.has(img.src)) {
          this.selectionCounter++;
          this.selectedImages.set(img.src, this.selectionCounter);
        }
      }
      // 更新选择框UI
      this.checkboxes.forEach((checkbox, src) => {
        if (this.selectedImages.has(src)) {
          checkbox.classList.add('selected');
          const checkMark = checkbox.querySelector('.ml-pdf-check-mark') as HTMLElement;
          if (checkMark) checkMark.style.display = '';
          let badge = checkbox.querySelector('.manga-lens-pdf-order-badge') as HTMLElement;
          if (!badge) {
            badge = document.createElement('div');
            badge.className = 'manga-lens-pdf-order-badge';
            badge.style.cssText = `
              position: absolute; top: -6px; left: -6px;
              width: 18px; height: 18px;
              background: #ff9800; color: #fff;
              border-radius: 50%; font-size: 10px;
              text-align: center; line-height: 18px;
              font-weight: 600; pointer-events: none;
            `;
            checkbox.appendChild(badge);
          }
          badge.textContent = String(this.selectedImages.get(src));
        }
      });
    }

    this.updateToolbarCounts();
  }

  /** 获取选中的导出目标（按选中顺序排序） */
  getSelectedTargets(): ExportTarget[] {
    return this.buildTargets(true);
  }

  /** 获取所有已翻译导出目标（按DOM顺序排序） */
  getAllTargets(): ExportTarget[] {
    return this.buildTargets(false);
  }

  private buildTargets(selectedOnly: boolean): ExportTarget[] {
    const images = this.callbacks.getTranslatedImages();
    const targets: ExportTarget[] = [];

    for (const img of images) {
      if (selectedOnly && !this.selectedImages.has(img.src)) continue;

      const overlays = this.callbacks.getOverlaysForImage(img);
      const parent = img.parentElement;
      if (!parent) continue;

      targets.push({
        imageSrc: img.src,
        imageElement: img,
        containerElement: overlays[0]?.parentElement || parent,
        parentElement: parent,
        pageOrder: selectedOnly ? (this.selectedImages.get(img.src) || 0) : targets.length + 1
      });
    }

    // 按页码排序
    if (selectedOnly) {
      targets.sort((a, b) => a.pageOrder - b.pageOrder);
    }
    // 全部导出按DOM顺序（getBoundingClientRect().top 排序）
    else {
      targets.sort((a, b) => {
        const aTop = a.imageElement.getBoundingClientRect().top;
        const bTop = b.imageElement.getBoundingClientRect().top;
        return aTop - bTop;
      });
      targets.forEach((t, i) => t.pageOrder = i + 1);
    }

    return targets;
  }

  // ============================================
  // 覆盖层编辑管理
  // ============================================

  /** 启用覆盖层编辑 */
  enableOverlayEditing(): void {
    const images = this.callbacks.getTranslatedImages();
    for (const img of images) {
      // 使覆盖层容器拦截点击，防止穿透到图片下方的 &lt;a&gt; 链接导致跳转
      const container = this.callbacks.getContainerForImage(img);
      if (container && !this.modifiedContainers.has(container)) {
        container.style.pointerEvents = 'auto';
        container.addEventListener('click', this._onContainerClick, true);
        this.modifiedContainers.add(container);
      }

      const overlays = this.callbacks.getOverlaysForImage(img);
      for (const overlay of overlays) {
        this.makeOverlayEditable(overlay);
      }
    }
    console.log('[PDFExport] ✏️ 覆盖层编辑模式已启用');
  }

  /** 禁用覆盖层编辑 */
  disableOverlayEditing(): void {
    const images = this.callbacks.getTranslatedImages();
    for (const img of images) {
      const overlays = this.callbacks.getOverlaysForImage(img);
      for (const overlay of overlays) {
        this.makeOverlayReadOnly(overlay);
      }
    }

    // 恢复容器 pointer-events 和移除点击拦截
    for (const container of this.modifiedContainers) {
      container.style.pointerEvents = 'none';
      container.removeEventListener('click', this._onContainerClick, true);
    }
    this.modifiedContainers.clear();

    this.clearEditingState();
    console.log('[PDFExport] 🔒 覆盖层编辑模式已禁用');
  }

  /** 使单个覆盖层可编辑 */
  private makeOverlayEditable(overlay: HTMLElement): void {
    const style = overlay.style;
    style.pointerEvents = 'auto';
    style.cursor = 'pointer';

    // hover 提示
    overlay.addEventListener('mouseenter', this._onOverlayHover);
    overlay.addEventListener('mouseleave', this._onOverlayLeave);

    // 双击进入编辑态
    overlay.addEventListener('dblclick', this._onOverlayDblClick);
  }

  /** 使单个覆盖层只读 */
  private makeOverlayReadOnly(overlay: HTMLElement): void {
    const style = overlay.style;
    style.pointerEvents = 'none';
    style.cursor = '';
    style.outline = '';

    overlay.removeEventListener('mouseenter', this._onOverlayHover);
    overlay.removeEventListener('mouseleave', this._onOverlayLeave);
    overlay.removeEventListener('dblclick', this._onOverlayDblClick);
    overlay.contentEditable = 'false';
    overlay.removeAttribute('contenteditable');

    // 移除编辑工具栏
    const toolbar = overlay.querySelector('.ml-overlay-edit-toolbar');
    if (toolbar) toolbar.remove();

    // 移除resize handles
    overlay.querySelectorAll('.ml-resize-handle').forEach(h => h.remove());
  }

  /** 拦截容器点击，阻止穿透到 &lt;a&gt; 标签导致页面跳转 */
  private _onContainerClick = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
  };

  private _onOverlayHover = (e: Event) => {
    const el = e.currentTarget as HTMLElement;
    if (el !== this.editingOverlay) {
      el.style.outline = '1px dashed rgba(102,126,234,0.5)';
    }
  };

  private _onOverlayLeave = (e: Event) => {
    const el = e.currentTarget as HTMLElement;
    if (el !== this.editingOverlay) {
      el.style.outline = '';
    }
  };

  private _onOverlayDblClick = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
    const overlay = e.currentTarget as HTMLElement;
    this.enterOverlayEditMode(overlay);
  };

  /** 进入单个覆盖层编辑态 */
  private enterOverlayEditMode(overlay: HTMLElement): void {
    // 先退出之前的编辑态
    this.clearEditingState();

    this.editingOverlay = overlay;
    overlay.style.outline = '2px solid #667eea';
    overlay.style.zIndex = '10';

    // 文字可编辑
    overlay.contentEditable = 'true';
    overlay.setAttribute('contenteditable', 'true');

    // 可拖拽
    overlay.addEventListener('mousedown', this._onDragStart);

    // 添加resize handles
    this.addResizeHandles(overlay);

    // 添加编辑工具栏
    this.addEditToolbar(overlay);
  }

  /** 退出单个覆盖层编辑态 */
  private clearEditingState(): void {
    if (!this.editingOverlay) return;

    this.editingOverlay.style.outline = '';
    this.editingOverlay.style.zIndex = '1';
    this.editingOverlay.contentEditable = 'false';
    this.editingOverlay.removeAttribute('contenteditable');
    this.editingOverlay.removeEventListener('mousedown', this._onDragStart);

    // 移除工具栏
    const toolbar = this.editingOverlay.querySelector('.ml-overlay-edit-toolbar');
    if (toolbar) toolbar.remove();

    // 移除resize handles
    this.editingOverlay.querySelectorAll('.ml-resize-handle').forEach(h => h.remove());

    this.editingOverlay = null;
  }

  // ============================================
  // 拖拽功能
  // ============================================

  private dragInfo: { startX: number; startY: number; startLeft: number; startTop: number } | null = null;

  private _onDragStart = (e: MouseEvent) => {
    if (!this.editingOverlay) return;
    e.stopPropagation();
    e.preventDefault();

    const rect = this.editingOverlay.getBoundingClientRect();
    this.dragInfo = {
      startX: e.clientX,
      startY: e.clientY,
      startLeft: rect.left,
      startTop: rect.top
    };

    document.addEventListener('mousemove', this._onDragMove);
    document.addEventListener('mouseup', this._onDragEnd);
  };

  private _onDragMove = (e: MouseEvent) => {
    if (!this.dragInfo || !this.editingOverlay) return;

    const dx = e.clientX - this.dragInfo.startX;
    const dy = e.clientY - this.dragInfo.startY;

    const parent = this.editingOverlay.parentElement;
    if (!parent) return;

    const parentRect = parent.getBoundingClientRect();
    const newLeftPx = this.dragInfo.startLeft - parentRect.left + dx;
    const newTopPx = this.dragInfo.startTop - parentRect.top + dy;

    // 转换回百分比
    const leftPercent = (newLeftPx / parentRect.width) * 100;
    const topPercent = (newTopPx / parentRect.height) * 100;

    this.editingOverlay.style.left = `${Math.max(0, Math.min(100, leftPercent))}%`;
    this.editingOverlay.style.top = `${Math.max(0, Math.min(100, topPercent))}%`;
  };

  private _onDragEnd = () => {
    this.dragInfo = null;
    this.callbacks.onSaveEdits('', []);
    document.removeEventListener('mousemove', this._onDragMove);
    document.removeEventListener('mouseup', this._onDragEnd);
  };

  // ============================================
  // Resize Handles
  // ============================================

  private addResizeHandles(overlay: HTMLElement): void {
    const positions = ['nw', 'ne', 'sw', 'se'];
    for (const pos of positions) {
      const handle = document.createElement('div');
      handle.className = `ml-resize-handle ml-resize-${pos}`;
      handle.style.cssText = `
        position: absolute;
        width: 10px; height: 10px;
        background: #667eea;
        border: 1px solid #fff;
        border-radius: 2px;
        z-index: 20;
        pointer-events: auto;
      `;
      // 位置
      if (pos.includes('n')) handle.style.top = '-4px';
      if (pos.includes('s')) handle.style.bottom = '-4px';
      if (pos.includes('w')) handle.style.left = '-4px';
      if (pos.includes('e')) handle.style.right = '-4px';

      // 光标
      handle.style.cursor = `${pos}-resize`;

      // 拖拽缩放
      handle.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.startResize(overlay, pos, e);
      });

      overlay.appendChild(handle);
    }
  }

  private resizeInfo: { handle: string; startX: number; startY: number; startW: number; startH: number; startL: number; startT: number } | null = null;

  private startResize(overlay: HTMLElement, handle: string, e: MouseEvent): void {
    const rect = overlay.getBoundingClientRect();
    const parent = overlay.parentElement;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();

    this.resizeInfo = {
      handle,
      startX: e.clientX,
      startY: e.clientY,
      startW: parseFloat(overlay.style.width) || (rect.width / parentRect.width * 100),
      startH: parseFloat(overlay.style.height) || (rect.height / parentRect.height * 100),
      startL: parseFloat(overlay.style.left) || (rect.left / parentRect.width * 100),
      startT: parseFloat(overlay.style.top) || (rect.top / parentRect.height * 100)
    };

    const onMove = (ev: MouseEvent) => {
      if (!this.resizeInfo) return;
      const parentR = parent.getBoundingClientRect();
      const dxPct = ((ev.clientX - this.resizeInfo.startX) / parentR.width) * 100;
      const dyPct = ((ev.clientY - this.resizeInfo.startY) / parentR.height) * 100;

      let { startW, startH, startL, startT } = this.resizeInfo;
      const h = this.resizeInfo.handle;

      if (h.includes('e')) startW = Math.max(2, startW + dxPct);
      if (h.includes('w')) { startW = Math.max(2, startW - dxPct); startL = startL + dxPct; }
      if (h.includes('s')) startH = Math.max(2, startH + dyPct);
      if (h.includes('n')) { startH = Math.max(2, startH - dyPct); startT = startT + dyPct; }

      overlay.style.width = `${startW}%`;
      overlay.style.height = `${startH}%`;
      overlay.style.left = `${startL}%`;
      overlay.style.top = `${startT}%`;
    };

    const onUp = () => {
      this.resizeInfo = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // ============================================
  // 编辑工具栏（删除按钮）
  // ============================================

  private addEditToolbar(overlay: HTMLElement): void {
    const toolbar = document.createElement('div');
    toolbar.className = 'ml-overlay-edit-toolbar';
    toolbar.style.cssText = `
      position: absolute; bottom: -28px; left: 0; right: 0;
      display: flex; gap: 4px; justify-content: center;
      z-index: 20; pointer-events: auto;
    `;

    const btnDelete = document.createElement('button');
    btnDelete.textContent = '× 删除';
    btnDelete.style.cssText = `
      padding: 2px 8px; font-size: 11px;
      background: rgba(255,50,50,0.85); color: #fff;
      border: none; border-radius: 4px; cursor: pointer;
      pointer-events: auto;
    `;
    btnDelete.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.callbacks.onSaveEdits('', []);
      overlay.remove();
      this.clearEditingState();
    });

    const btnDone = document.createElement('button');
    btnDone.textContent = '✓ 完成';
    btnDone.style.cssText = `
      padding: 2px 8px; font-size: 11px;
      background: rgba(102,126,234,0.85); color: #fff;
      border: none; border-radius: 4px; cursor: pointer;
      pointer-events: auto;
    `;
    btnDone.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.callbacks.onSaveEdits('', []);
      this.clearEditingState();
    });

    toolbar.appendChild(btnDelete);
    toolbar.appendChild(btnDone);
    overlay.appendChild(toolbar);
  }

  // ============================================
  // PDF生成
  // ============================================

  /** 导出全部已翻译图片 */
  async exportAll(): Promise<void> {
    const targets = this.getAllTargets();
    if (targets.length === 0) {
      alert('暂无可导出的翻译结果');
      return;
    }
    await this.generatePDF(targets);
  }

  /** 导出选中的图片 */
  async exportSelected(): Promise<void> {
    const targets = this.getSelectedTargets();
    if (targets.length === 0) {
      alert('请先选择要导出的图片');
      return;
    }
    await this.generatePDF(targets);
  }

  /** 执行PDF生成 */
  async generatePDF(targets: ExportTarget[]): Promise<void> {
    this.showProgressBar(0, targets.length);
    this.hideUIForScreenshot();

    try {
      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4'
      });

      const PDF_PAGE_WIDTH = 210; // mm

      for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        this.updateProgressBar(i + 1, targets.length);

        try {
          const canvas = await html2canvas(target.parentElement, {
            allowTaint: false,
            useCORS: true,
            scale: 1,
            backgroundColor: '#ffffff',
            logging: false,
            windowWidth: target.parentElement.scrollWidth,
            windowHeight: target.parentElement.scrollHeight,
          });

          const imgRatio = canvas.height / canvas.width;
          const pageHeight = Math.min(PDF_PAGE_WIDTH * imgRatio, 594);

          if (i > 0) pdf.addPage([PDF_PAGE_WIDTH, pageHeight]);
          const canvasDataUrl = canvas.toDataURL('image/png');
          pdf.addImage(canvasDataUrl, 'PNG', 0, 0, PDF_PAGE_WIDTH, pageHeight);

        } catch (html2canvasError) {
          console.warn(`[PDFExport] html2canvas 失败 (${target.imageSrc}):`, html2canvasError);
          // 降级：直接在canvas上绘制图片
          try {
            const canvas = document.createElement('canvas');
            canvas.width = target.imageElement.naturalWidth;
            canvas.height = target.imageElement.naturalHeight;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.fillStyle = '#ffffff';
              ctx.fillRect(0, 0, canvas.width, canvas.height);
              ctx.drawImage(target.imageElement, 0, 0);

              const imgRatio = canvas.height / canvas.width;
              const pageHeight = Math.min(PDF_PAGE_WIDTH * imgRatio, 594);

              if (i > 0) pdf.addPage([PDF_PAGE_WIDTH, pageHeight]);
              pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, PDF_PAGE_WIDTH, pageHeight);
            }
          } catch (fallbackError) {
            console.error(`[PDFExport] 降级方案也失败:`, fallbackError);
            // 跳过这张图
          }
        }
      }

      // 触发下载
      const dateStr = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      const filename = `${this.savePath ? this.savePath + '/' : ''}manga-${dateStr}.pdf`;
      const pdfBlob = pdf.output('blob');
      const blobUrl = URL.createObjectURL(pdfBlob);

      chrome.runtime.sendMessage({
        target: 'background',
        type: 'DOWNLOAD_PDF',
        url: blobUrl,
        filename: filename,
        saveAs: false
      });

    } catch (error) {
      console.error('[PDFExport] PDF生成失败:', error);
      alert('PDF 生成失败，请查看控制台了解详情');
    } finally {
      this.restoreUIAfterScreenshot();
      this.removeProgressBar();
    }

    console.log(`[PDFExport] ✅ PDF生成完成: ${targets.length}张图片`);
  }

  // ============================================
  // 进度条
  // ============================================

  private showProgressBar(current: number, total: number): void {
    this.removeProgressBar();

    const bar = document.createElement('div');
    bar.id = 'manga-lens-pdf-progress';
    bar.innerHTML = `
      <style>
        #manga-lens-pdf-progress {
          position: fixed; bottom: 24px; right: 24px;
          z-index: 2147483647;
          background: rgba(26,26,46,0.95);
          border: 1px solid rgba(102,126,234,0.4);
          border-radius: 12px;
          padding: 16px 20px;
          color: #e0e0e0;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 13px;
          box-shadow: 0 4px 16px rgba(0,0,0,0.3);
          min-width: 200px;
        }
        .ml-pdf-progress-text { margin-bottom: 8px; }
        .ml-pdf-progress-bar-outer {
          background: rgba(255,255,255,0.1);
          border-radius: 6px; height: 8px; overflow: hidden;
        }
        .ml-pdf-progress-bar-inner {
          height: 100%; border-radius: 6px;
          background: linear-gradient(135deg, #667eea, #764ba2);
          transition: width 0.3s;
        }
      </style>
      <div class="ml-pdf-progress-text">📄 正在生成PDF... ${current}/${total}</div>
      <div class="ml-pdf-progress-bar-outer">
        <div class="ml-pdf-progress-bar-inner" style="width: ${Math.round((current / total) * 100)}%"></div>
      </div>
    `;

    document.body.appendChild(bar);
    this.progressBar = bar;
  }

  private updateProgressBar(current: number, total: number): void {
    if (!this.progressBar) return;

    const textEl = this.progressBar.querySelector('.ml-pdf-progress-text');
    const barEl = this.progressBar.querySelector('.ml-pdf-progress-bar-inner') as HTMLElement;

    if (textEl) textEl.textContent = `📄 正在生成PDF... ${current}/${total}`;
    if (barEl) barEl.style.width = `${Math.round((current / total) * 100)}%`;
  }

  private removeProgressBar(): void {
    if (this.progressBar && this.progressBar.parentElement) {
      this.progressBar.remove();
    }
    this.progressBar = null;
  }

  // ============================================
  // 截图辅助
  // ============================================

  /** 临时隐藏UI元素（截图前） */
  private hideUIForScreenshot(): void {
    // 隐藏工具栏
    if (this.toolbar) this.toolbar.style.display = 'none';
    // 隐藏选择框
    this.checkboxes.forEach((checkbox) => {
      checkbox.style.display = 'none';
    });
  }

  /** 恢复UI元素（截图后） */
  private restoreUIAfterScreenshot(): void {
    // 恢复工具栏
    if (this.toolbar) this.toolbar.style.display = '';
    // 恢复选择框
    this.checkboxes.forEach((checkbox) => {
      checkbox.style.display = '';
    });
    // 重新定位选择框
    const images = this.callbacks.getTranslatedImages();
    for (const img of images) {
      const checkbox = this.checkboxes.get(img.src);
      if (checkbox) {
        this.updateCheckboxPosition(img, checkbox);
      }
    }
  }

  // ============================================
  // scroll/resize 监听
  // ============================================

  private positionUpdaters: Array<() => void> = [];
  private scrollListenerBound = false;

  private ensureScrollListener(): void {
    if (this.scrollListenerBound) return;
    this.scrollListenerBound = true;
    window.addEventListener('scroll', this._onScrollResize, { passive: true });
    window.addEventListener('resize', this._onScrollResize, { passive: true });
  }

  private _onScrollResize = () => {
    this.positionUpdaters.forEach(fn => fn());
  };

  /** 清理所有资源 */
  destroy(): void {
    this.exitPdfMode();
    if (this.scrollListenerBound) {
      window.removeEventListener('scroll', this._onScrollResize);
      window.removeEventListener('resize', this._onScrollResize);
      this.scrollListenerBound = false;
    }
    this.positionUpdaters = [];
  }
}

// 单例导出
export const pdfExporter = new PDFExporter({
  getOverlaysForImage: () => [],
  getTranslatedImages: () => [],
  onExitRequest: () => {},
  onSaveEdits: () => {}
});
