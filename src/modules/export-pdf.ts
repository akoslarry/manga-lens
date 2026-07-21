/**
 * PDF导出模块 - MangaLens v4.0
 *
 * 功能：
 * 1. PDF模式浮动工具栏（导出全部/导出选中/全选/退出）
 * 2. 图片选择框（手动勾选导出目标，记录选中顺序）
 * 3. PDF生成（手动合成图片+覆盖层 → jsPDF写入，每图一页）
 * 4. 进度条反馈
 */

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
  /** 获取图片的缓存对话数据（用于恢复自定义字体大小） */
  getCachedDialogsForImage: (imageSrc: string) => Promise<any[] | null>;
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
  private selectedImages = new Set<string>(); // 选中的 imageSrc（无排序，导出时按DOM位置排）
  private toolbar: HTMLElement | null = null;
  private progressBar: HTMLElement | null = null;
  private checkboxes: Map<string, HTMLElement> = new Map(); // imageSrc → 选择框元素
  private callbacks: PDFExporterCallbacks;
  private editingOverlay: HTMLElement | null = null; // 当前正在编辑的覆盖层
  private editingToolbar: HTMLElement | null = null;  // 编辑工具栏(body子元素, fixed定位)
  private modifiedContainers = new Set<HTMLElement>(); // PDF模式下 pointer-events 被改为 auto 的容器
  private customFontSizes = new Map<string, number>();   // 每个覆盖层的自定义字号 (overlayId → px)
  private customOpacities = new Map<string, number>();    // 每个覆盖层的自定义透明度 (overlayId → 0~1)
  private globalOpacity = 0.88;                           // 全局默认背景透明度
  private deletedDialogIds = new Set<number>();           // 用户删除的 MergedDialog id，持久化时从缓存中移除
  private imageDataUrlCache = new Map<string, string>(); // imageSrc → dataURL 缓存(解决CORS)

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

  /** 获取当前所有覆盖层的自定义字体大小的快照（用于持久化） */
  getCustomFontSizes(): Map<string, number> {
    return new Map(this.customFontSizes);
  }

  /** 获取全局背景透明度 */
  getGlobalOpacity(): number {
    return this.globalOpacity;
  }

  /** 获取所有覆盖层的自定义透明度快照（overlayId → 0~1） */
  getCustomOpacities(): Map<string, number> {
    return new Map(this.customOpacities);
  }

  /** 清空自定义字体大小缓存 */
  resetCustomFontSizes(): void {
    this.customFontSizes.clear();
  }

  /** 获取被删除的 MergedDialog ID 集合（用于持久化时从缓存中移除） */
  getDeletedDialogIds(): Set<number> {
    return new Set(this.deletedDialogIds);
  }

  /** 清空删除追踪 */
  resetDeletedDialogIds(): void {
    this.deletedDialogIds.clear();
  }

  /** 进入PDF编辑模式 */
  enterPdfMode(savePath: string): void {
    if (this.isPdfMode) return;
    this.isPdfMode = true;
    this.savePath = savePath;
    this.selectedImages.clear();

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
    this.customFontSizes.clear();
    this.customOpacities.clear();
    this.deletedDialogIds.clear();

    this.isPdfMode = false;
    this.selectedImages.clear();

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
    checkbox.innerHTML = '<span class="ml-pdf-check-mark" style="font-size:16px;display:flex;align-items:center;justify-content:center;">✅</span>';
    checkbox.title = '点击切换选中/取消';

    // 默认选中
    this.selectedImages.add(imageSrc);

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

    const isSelected = checkbox.classList.contains('selected');
    checkbox.style.cssText = `
      position: fixed;
      top: ${rect.top + 8}px;
      left: ${rect.left + 8}px;
      z-index: 2147483646;
      width: 30px; height: 30px;
      border-radius: 8px;
      border: 2px solid ${isSelected ? 'rgba(102,126,234,0.8)' : 'rgba(255,255,255,0.25)'};
      background: ${isSelected ? 'rgba(102,126,234,0.3)' : 'rgba(0,0,0,0.45)'};
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
      pointer-events: auto;
      box-shadow: 0 2px 6px rgba(0,0,0,0.3);
    `;
  }

  /** 切换单张图片选中状态 */
  private toggleImageSelection(imageSrc: string, checkbox: HTMLElement, imageEl: HTMLImageElement): void {
    if (this.selectedImages.has(imageSrc)) {
      // 取消选中
      this.selectedImages.delete(imageSrc);
      checkbox.classList.remove('selected');
      const checkMark = checkbox.querySelector('.ml-pdf-check-mark') as HTMLElement;
      if (checkMark) checkMark.style.display = 'none';
    } else {
      // 选中
      this.selectedImages.add(imageSrc);
      checkbox.classList.add('selected');
      const checkMark = checkbox.querySelector('.ml-pdf-check-mark') as HTMLElement;
      if (checkMark) checkMark.style.display = '';
    }

    // 刷新复选框外观
    this.updateCheckboxPosition(imageEl, checkbox);
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
      this.checkboxes.forEach((checkbox) => {
        checkbox.classList.remove('selected');
        const checkMark = checkbox.querySelector('.ml-pdf-check-mark') as HTMLElement;
        if (checkMark) checkMark.style.display = 'none';
      });
    } else {
      // 全选
      for (const img of images) {
        this.selectedImages.add(img.src);
      }
      // 更新选择框UI
      this.checkboxes.forEach((checkbox, src) => {
        if (this.selectedImages.has(src)) {
          checkbox.classList.add('selected');
          const checkMark = checkbox.querySelector('.ml-pdf-check-mark') as HTMLElement;
          if (checkMark) checkMark.style.display = '';
        }
      });
    }

    // 刷新所有选择框外观
    const allImages = this.callbacks.getTranslatedImages();
    for (const img of allImages) {
      const cb = this.checkboxes.get(img.src);
      if (cb) this.updateCheckboxPosition(img, cb);
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
        pageOrder: 0
      });
    }

    // 统一按图片在网页中的DOM位置从上到下排序
    targets.sort((a, b) => {
      const aTop = a.imageElement.getBoundingClientRect().top;
      const bTop = b.imageElement.getBoundingClientRect().top;
      return aTop - bTop;
    });
    targets.forEach((t, i) => t.pageOrder = i + 1);

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

  /** 从缓存恢复每个覆盖层的自定义字体大小（异步调用） */
  async loadPersistedFontSizes(): Promise<void> {
    const images = this.callbacks.getTranslatedImages();
    for (const img of images) {
      const dialogs = await this.callbacks.getCachedDialogsForImage(img.src);
      if (!dialogs) continue;

      // 建立 dialogId → customFontSize 的映射
      const dialogFontMap = new Map<number, number>();
      for (const d of dialogs) {
        if (d.customFontSize) {
          dialogFontMap.set(d.id, d.customFontSize);
        }
      }
      if (dialogFontMap.size === 0) continue;

      // 应用到对应覆盖层
      const overlays = this.callbacks.getOverlaysForImage(img);
      for (const overlay of overlays) {
        const dialogId = parseInt(overlay.dataset.dialogId || '', 10);
        if (!isNaN(dialogId) && dialogFontMap.has(dialogId)) {
          const fontSize = dialogFontMap.get(dialogId)!;
          overlay.style.fontSize = `${fontSize}px`;
          this.customFontSizes.set(overlay.id, fontSize);
        }
      }
    }
    console.log('[PDFExport] 📐 已恢复自定义字体大小:', this.customFontSizes.size, '个覆盖层');
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

    // 阻止点击冒泡到 &lt;a&gt; 标签导致页面跳转
    overlay.addEventListener('click', this._onOverlayClick);

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
    overlay.removeEventListener('click', this._onOverlayClick);
    overlay.removeEventListener('dblclick', this._onOverlayDblClick);
    overlay.contentEditable = 'false';
    overlay.removeAttribute('contenteditable');

    // 移除resize handles (toolbar 已在 clearEditingState 中通过 editingToolbar 引用移除)
    overlay.querySelectorAll('.ml-resize-handle').forEach(h => h.remove());
  }

  /** 拦截容器背景点击，阻止穿透到 &lt;a&gt; 标签导致页面跳转 */
  private _onContainerClick = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
  };

  /** 拦截覆盖层本身点击，阻止事件冒泡到 &lt;a&gt; 标签导致跳转 */
  private _onOverlayClick = (e: Event) => {
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

    // 🔧 清除 overflow:hidden，否则 bottom:-4px 的 resize handles 会被裁剪，导致无法向下拉伸
    overlay.style.overflow = 'visible';

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
    this.editingOverlay.style.overflow = '';
    this.editingOverlay.contentEditable = 'false';
    this.editingOverlay.removeAttribute('contenteditable');
    this.editingOverlay.removeEventListener('mousedown', this._onDragStart);

    // 移除 resize handles
    this.editingOverlay.querySelectorAll('.ml-resize-handle').forEach(h => h.remove());

    // 移除 body 上的工具栏
    if (this.editingToolbar && this.editingToolbar.parentElement) {
      this.editingToolbar.remove();
    }
    this.editingToolbar = null;

    // 移除工具栏位置更新器
    if (this._toolbarPositionUpdater) {
      this.positionUpdaters = this.positionUpdaters.filter(fn => fn !== this._toolbarPositionUpdater);
      this._toolbarPositionUpdater = null;
    }

    this.editingOverlay = null;
  }

  // ============================================
  // 拖拽功能
  // ============================================

  private dragInfo: { startX: number; startY: number; startLeft: number; startTop: number } | null = null;

  private _onDragStart = (e: MouseEvent) => {
    if (!this.editingOverlay) return;

    // 点击 resize handles 时不启动拖拽
    const target = e.target as HTMLElement;
    if (target.closest('.ml-resize-handle') || target.closest('.ml-overlay-edit-toolbar') || target.closest('.ml-font-size-input')) {
      return;
    }

    e.stopPropagation();
    // 不调 preventDefault()，保留 contentEditable 的聚焦行为

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

    // 只有实际拖拽超过3px时才阻止默认行为（防止误拖拽时干扰文本选中）
    if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;

    e.preventDefault(); // 拖拽中阻止文本选中

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

    // 🔧 拖拽过程中同步更新工具栏位置
    if (this.editingToolbar) {
      this.updateToolbarPosition(this.editingOverlay);
    }
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
  // 编辑工具栏（删除 + 完成 + 字体大小）
  // 注：工具栏是 body 的直接子元素（fixed定位），不受 overlay 父容器 overflow:hidden 影响
  // ============================================

  private addEditToolbar(overlay: HTMLElement): void {
    // 移除旧工具栏
    if (this.editingToolbar && this.editingToolbar.parentElement) {
      this.editingToolbar.remove();
    }

    const toolbar = document.createElement('div');
    toolbar.className = 'ml-overlay-edit-toolbar';
    toolbar.style.cssText = `
      position: fixed;
      display: flex; flex-direction: column; gap: 4px; align-items: stretch;
      z-index: 2147483646; pointer-events: auto; white-space: nowrap;
      width: 130px;
    `;

    // 字体大小输入
    const fontSizeGroup = document.createElement('div');
    fontSizeGroup.style.cssText = `
      display: flex; align-items: center; justify-content: space-between; gap: 2px;
      background: rgba(0,0,0,0.75); border-radius: 4px; padding: 2px 6px;
    `;
    const fontSizeLabel = document.createElement('span');
    fontSizeLabel.textContent = '字号';
    fontSizeLabel.style.cssText = 'color: #aaa; font-size: 11px; user-select: none;';
    const fontSizeInput = document.createElement('input');
    fontSizeInput.className = 'ml-font-size-input';
    fontSizeInput.type = 'number';
    fontSizeInput.min = '4';
    fontSizeInput.max = '80';
    fontSizeInput.step = '1';

    // 初始值 = overlay 当前 fontSize
    const currentSize = parseInt(overlay.style.fontSize, 10) || 16;
    const savedSize = this.customFontSizes.get(overlay.id);
    fontSizeInput.value = String(savedSize || currentSize);
    fontSizeInput.style.cssText = `
      width: 48px; height: 22px; padding: 0 4px; font-size: 12px;
      text-align: center; border: 1px solid rgba(255,255,255,0.3);
      border-radius: 3px; background: rgba(255,255,255,0.15); color: #fff;
      outline: none; pointer-events: auto;
      -moz-appearance: textfield;
    `;
    // 隐藏 number input 的 spinner 箭头（避免挤占空间导致数字竖向显示）
    const styleSheet = document.createElement('style');
    styleSheet.textContent = `
      .ml-font-size-input::-webkit-outer-spin-button,
      .ml-font-size-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    `;
    toolbar.appendChild(styleSheet);
    fontSizeGroup.appendChild(fontSizeLabel);
    fontSizeGroup.appendChild(fontSizeInput);

    // 透明度滑块组
    const opacityGroup = document.createElement('div');
    opacityGroup.style.cssText = `
      display: flex; align-items: center; justify-content: space-between; gap: 2px;
      background: rgba(0,0,0,0.75); border-radius: 4px; padding: 2px 6px;
    `;
    const opacityLabel = document.createElement('span');
    opacityLabel.textContent = '透明';
    opacityLabel.style.cssText = 'color: #aaa; font-size: 11px; user-select: none;';
    const opacityInput = document.createElement('input');
    opacityInput.type = 'range';
    opacityInput.min = '0';
    opacityInput.max = '100';
    opacityInput.step = '1';
    // 初始值：优先从 customOpacities 取，否则用 globalOpacity
    const savedOpacity = this.customOpacities.get(overlay.id);
    const currentBgOpacity = savedOpacity !== undefined ? savedOpacity : this.globalOpacity;
    opacityInput.value = String(Math.round(currentBgOpacity * 100));
    opacityInput.style.cssText = `
      width: 60px; height: 20px;
      accent-color: #667eea;
      cursor: pointer; pointer-events: auto;
    `;
    opacityInput.title = `背景透明度: ${opacityInput.value}%`;
    const opacityValueSpan = document.createElement('span');
    opacityValueSpan.textContent = `${opacityInput.value}%`;
    opacityValueSpan.style.cssText = 'color: #fff; font-size: 11px; min-width: 30px; text-align: center;';
    opacityGroup.appendChild(opacityLabel);
    opacityGroup.appendChild(opacityInput);
    opacityGroup.appendChild(opacityValueSpan);

    // 透明度变化 → 立刻更新 overlay + 记录
    // 🔧 始终固定背景为白色 rgba(255,255,255,x)，仅修改 alpha 通道。
    //     之前用 regex 从 DOM 回读再替换 alpha 的方案存在浏览器格式归一化风险
    //     （如 rgb(255,255,255) 缺 alpha / rgba(255 255 255 / 0.88) 现代语法），
    //     匹配失败时背景会残留错误的颜色。
    const updateOpacity = () => {
      const newOpacity = parseInt(opacityInput.value, 10) / 100;
      if (isNaN(newOpacity)) return;
      overlay.style.backgroundColor = `rgba(255, 255, 255, ${newOpacity.toFixed(2)})`;
      this.customOpacities.set(overlay.id, newOpacity);
      opacityValueSpan.textContent = `${Math.round(newOpacity * 100)}%`;
      this.callbacks.onSaveEdits('', []);
    };
    opacityInput.addEventListener('input', updateOpacity);
    opacityInput.addEventListener('mousedown', (e) => e.stopPropagation());

    // 字号变化 → 立刻更新 overlay 并记录
    const updateFontSize = () => {
      const newSize = parseInt(fontSizeInput.value, 10);
      if (isNaN(newSize) || newSize < 4) return;
      overlay.style.fontSize = `${newSize}px`;
      this.customFontSizes.set(overlay.id, newSize);
      this.callbacks.onSaveEdits('', []);
    };
    fontSizeInput.addEventListener('input', updateFontSize);
    fontSizeInput.addEventListener('change', updateFontSize);
    fontSizeInput.addEventListener('mousedown', (e) => e.stopPropagation());

    // 删除按钮
    const btnDelete = document.createElement('button');
    btnDelete.textContent = '删除';
    btnDelete.style.cssText = `
      padding: 4px 10px; font-size: 12px; width: 100%;
      background: rgba(255,50,50,0.85); color: #fff;
      border: none; border-radius: 4px; cursor: pointer;
      pointer-events: auto; white-space: nowrap;
    `;
    btnDelete.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      // 🔧 记录被删除的 MergedDialog ID，持久化时从缓存中移除
      const dialogId = parseInt(overlay.dataset.dialogId || '', 10);
      if (!isNaN(dialogId)) {
        this.deletedDialogIds.add(dialogId);
      }
      this.customFontSizes.delete(overlay.id);
      this.callbacks.onSaveEdits('', []);
      overlay.remove();
      this.clearEditingState();
    });

    // 确认按钮
    const btnDone = document.createElement('button');
    btnDone.textContent = '确认';
    btnDone.style.cssText = `
      padding: 4px 10px; font-size: 12px; width: 100%;
      background: rgba(102,126,234,0.85); color: #fff;
      border: none; border-radius: 4px; cursor: pointer;
      pointer-events: auto; white-space: nowrap;
    `;
    btnDone.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.callbacks.onSaveEdits('', []);
      this.clearEditingState();
    });

    toolbar.appendChild(fontSizeGroup);
    toolbar.appendChild(opacityGroup);
    toolbar.appendChild(btnDelete);
    toolbar.appendChild(btnDone);

    document.body.appendChild(toolbar);
    this.editingToolbar = toolbar;

    // 初始定位 + 注册位置更新
    this.updateToolbarPosition(overlay);
    this._toolbarPositionUpdater = () => this.updateToolbarPosition(overlay);
    this.positionUpdaters.push(this._toolbarPositionUpdater);
    this.ensureScrollListener();
  }

  private _toolbarPositionUpdater: (() => void) | null = null;

  /** 更新工具栏位置（保持在overlay正下方，若overlay位于视口下1/4则翻转到上方） */
  private updateToolbarPosition(overlay: HTMLElement): void {
    if (!this.editingToolbar) return;
    const rect = overlay.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      this.editingToolbar.style.display = 'none';
      return;
    }
    this.editingToolbar.style.display = 'flex';

    // 🔧 检测覆盖层是否位于视口的下 1/4：若中心点在底 1/4，工具栏翻到上方，避免被裁出屏幕
    const viewportH = window.innerHeight;
    const overlayCenterY = (rect.top + rect.bottom) / 2;
    const isBottomQuarter = overlayCenterY > viewportH * 0.75;

    if (isBottomQuarter) {
      // 工具栏放在覆盖层上方：bottom = 视口底部 - 覆盖层顶 + 4px 间距
      const toolbarH = this.editingToolbar.offsetHeight || 110; // 回退估算高度
      this.editingToolbar.style.top = '';
      this.editingToolbar.style.bottom = `${viewportH - rect.top + 4}px`;
    } else {
      this.editingToolbar.style.top = `${rect.bottom + 4}px`;
      this.editingToolbar.style.bottom = '';
    }
    this.editingToolbar.style.left = `${Math.max(4, rect.left)}px`;
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

    // 🔧 预拉取所有跨域图片为 data URL（通过 background service worker，不受 CORS 限制）
    const originalSrcs = new Map<HTMLImageElement, string>();
    try {
      await this.prefetchImageDataUrls(targets, originalSrcs);
    } catch (e) {
      console.warn('[PDFExport] 图片预拉取部分失败，将尝试降级方案:', e);
    }

    // 🔧 等待所有替换后的图片加载完毕
    await this.waitForImagesToLoad(targets);

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
          // 🔧 手动合成：图片 + 覆盖层文字 → canvas
          const canvas = await this.compositeImageWithOverlays(target);

          const imgRatio = canvas.height / canvas.width;
          const pageHeight = Math.min(PDF_PAGE_WIDTH * imgRatio, 594);

          if (i > 0) pdf.addPage([PDF_PAGE_WIDTH, pageHeight]);
          const canvasDataUrl = canvas.toDataURL('image/png');
          pdf.addImage(canvasDataUrl, 'PNG', 0, 0, PDF_PAGE_WIDTH, pageHeight);

        } catch (compositeError) {
          console.warn(`[PDFExport] 合成失败 (${target.imageSrc}):`, compositeError);
          // 降级：使用 data URL 直接在 canvas 上绘制纯图片
          try {
            const dataUrl = this.imageDataUrlCache.get(target.imageSrc);
            if (!dataUrl) throw new Error('无缓存 data URL');

            const img = await this.loadImageFromDataUrl(dataUrl);
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.fillStyle = '#ffffff';
              ctx.fillRect(0, 0, canvas.width, canvas.height);
              ctx.drawImage(img, 0, 0);

              const imgRatio = canvas.height / canvas.width;
              const pageHeight = Math.min(PDF_PAGE_WIDTH * imgRatio, 594);

              if (i > 0) pdf.addPage([PDF_PAGE_WIDTH, pageHeight]);
              pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, PDF_PAGE_WIDTH, pageHeight);
            }
          } catch (fallbackError) {
            console.error(`[PDFExport] 降级方案也失败:`, fallbackError);
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
      // 🔧 恢复原始图片 src
      for (const [img, originalSrc] of originalSrcs) {
        img.src = originalSrc;
      }
      this.imageDataUrlCache.clear();
      this.restoreUIAfterScreenshot();
      this.removeProgressBar();
    }

    console.log(`[PDFExport] ✅ PDF生成完成: ${targets.length}张图片`);
  }

  /** 通过 background service worker 预拉取跨域图片为 data URL，并临时替换 img.src */
  private async prefetchImageDataUrls(
    targets: ExportTarget[],
    originalSrcs: Map<HTMLImageElement, string>
  ): Promise<void> {
    const uniqueUrls = [...new Set(targets.map(t => t.imageSrc))];

    // 并行拉取所有图片
    const results = await Promise.allSettled(
      uniqueUrls.map(async (url) => {
        // 已经是 data URL 或同源的跳过
        if (url.startsWith('data:') || this.isSameOrigin(url)) {
          this.imageDataUrlCache.set(url, url);
          return;
        }

        return new Promise<void>((resolve, reject) => {
          chrome.runtime.sendMessage(
            { target: 'background', type: 'FETCH_IMAGE_DATA_URL', imageUrl: url },
            (response) => {
              if (response?.success && response.dataUrl) {
                this.imageDataUrlCache.set(url, response.dataUrl);
                resolve();
              } else {
                reject(new Error(response?.error || '拉取失败'));
              }
            }
          );
        });
      })
    );

    // 替换图片 src 为 data URL
    for (const target of targets) {
      const dataUrl = this.imageDataUrlCache.get(target.imageSrc);
      if (dataUrl && dataUrl !== target.imageSrc) {
        originalSrcs.set(target.imageElement, target.imageSrc);
        target.imageElement.src = dataUrl;
      }
    }

    const successCount = results.filter(r => r.status === 'fulfilled').length;
    const failCount = results.filter(r => r.status === 'rejected').length;
    console.log(`[PDFExport] 📥 图片预拉取: ${successCount} 成功, ${failCount} 失败 (共 ${uniqueUrls.length} 张)`);
  }

  /** 判断 URL 是否与当前页面同源 */
  private isSameOrigin(url: string): boolean {
    try {
      const u = new URL(url);
      return u.origin === window.location.origin;
    } catch {
      return false;
    }
  }

  /** 从 data URL 加载 Image 对象 */
  private loadImageFromDataUrl(dataUrl: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('data URL 图片加载失败'));
      img.src = dataUrl;
    });
  }

  /** 等待所有替换了 src 的图片加载完毕 */
  private async waitForImagesToLoad(targets: ExportTarget[]): Promise<void> {
    const promises = targets
      .filter(t => t.imageElement.complete === false)
      .map(t => new Promise<void>((resolve) => {
        const onLoad = () => {
          t.imageElement.removeEventListener('load', onLoad);
          t.imageElement.removeEventListener('error', onLoad);
          resolve();
        };
        t.imageElement.addEventListener('load', onLoad);
        t.imageElement.addEventListener('error', onLoad);
        // 超时保护
        setTimeout(() => {
          t.imageElement.removeEventListener('load', onLoad);
          t.imageElement.removeEventListener('error', onLoad);
          resolve();
        }, 5000);
      }));

    if (promises.length > 0) {
      await Promise.all(promises);
      console.log(`[PDFExport] 📸 等待 ${promises.length} 张图片加载完毕`);
    }
  }

  /**
   * 🔧 手动合成图片 + 覆盖层文字到 canvas
   * 避免 html2canvas 在 inline 父元素、overflow:hidden 容器等场景下的渲染问题
   */
  private async compositeImageWithOverlays(target: ExportTarget): Promise<HTMLCanvasElement> {
    const dataUrl = this.imageDataUrlCache.get(target.imageSrc);
    if (!dataUrl) throw new Error('无缓存 data URL');

    // 1. 加载原图
    const img = await this.loadImageFromDataUrl(dataUrl);
    const imgNaturalW = img.naturalWidth;
    const imgNaturalH = img.naturalHeight;

    // 2. 创建画布（使用原图自然尺寸，确保最高质量）
    const canvas = document.createElement('canvas');
    canvas.width = imgNaturalW;
    canvas.height = imgNaturalH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建 canvas 上下文');

    // 3. 绘制白色背景 + 原图
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);

    // 4. 获取覆盖层数据
    const overlays = this.callbacks.getOverlaysForImage(target.imageElement);
    if (overlays.length === 0) {
      return canvas;
    }

    // 5. 获取图片当前显示尺寸（用于比例换算）
    const imgRect = target.imageElement.getBoundingClientRect();
    const scaleX = imgNaturalW / imgRect.width;
    const scaleY = imgNaturalH / imgRect.height;

    // 6. 逐个绘制覆盖层文字到 canvas
    for (const overlay of overlays) {
      const text = overlay.textContent?.trim();
      if (!text) continue;

      const overlayRect = overlay.getBoundingClientRect();
      // 覆盖层在 canvas 上的坐标（相对于图片左上角）
      const ox = (overlayRect.left - imgRect.left) * scaleX;
      const oy = (overlayRect.top - imgRect.top) * scaleY;
      const ow = overlayRect.width * scaleX;
      const oh = overlayRect.height * scaleY;

      // 跳过完全不可见的覆盖层
      if (ow < 1 || oh < 1) continue;

      const style = window.getComputedStyle(overlay);
      const fontSize = parseFloat(style.fontSize) * scaleX;
      const padding = parseFloat(style.padding) * scaleX || 0;
      const fontFamily = style.fontFamily || 'sans-serif';
      const color = style.color || '#000000';
      const textAlign = style.textAlign || 'center';
      const writingMode = style.writingMode || 'horizontal-tb';

      // 解析背景色
      let bgColor = style.backgroundColor;
      let bgOpacity = 1;
      if (bgColor === 'rgba(0, 0, 0, 0)' || bgColor === 'transparent') {
        bgOpacity = 0;
      } else if (bgColor.startsWith('rgba')) {
        const match = bgColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+),?\s*([\d.]+)?\)/);
        if (match) {
          const r = parseInt(match[1]), g = parseInt(match[2]), b = parseInt(match[3]);
          bgOpacity = match[4] ? parseFloat(match[4]) : 1;
          bgColor = `rgb(${r},${g},${b})`;
        }
      }

      ctx.save();

      // 绘制背景
      if (bgOpacity > 0) {
        const borderRadius = parseFloat(style.borderRadius) * scaleX || 0;
        ctx.fillStyle = bgColor;
        ctx.globalAlpha = bgOpacity;
        if (borderRadius > 0) {
          this.roundRect(ctx, ox, oy, ow, oh, borderRadius);
          ctx.fill();
        } else {
          ctx.fillRect(ox, oy, ow, oh);
        }
        ctx.globalAlpha = 1;
      }

      // 设置文字样式
      ctx.fillStyle = color;
      ctx.textBaseline = 'middle';

      if (writingMode === 'vertical-rl') {
        // 竖排文字
        ctx.textAlign = 'center';
        const chars = [...text];
        const charSize = Math.min(fontSize, oh / (chars.length + 1));
        ctx.font = `${charSize}px ${fontFamily}`;
        for (let ci = 0; ci < chars.length; ci++) {
          const cy = oy + padding + (ci + 0.5) * (oh - padding * 2) / chars.length;
          ctx.fillText(chars[ci], ox + ow / 2, cy);
        }
      } else {
        // 横排文字 — 使用自适应字号确保不溢出
        const maxWidth = ow - padding * 2;
        const maxHeight = oh - padding * 2;
        if (maxWidth <= 0 || maxHeight <= 0) {
          ctx.restore();
          continue;
        }

        let drawFontSize = fontSize;
        let lines = this.wrapText(ctx, text, maxWidth, drawFontSize, fontFamily);
        // 如果文字高度不够，缩小字号
        while (lines.length * drawFontSize * 1.4 > maxHeight && drawFontSize > 4) {
          drawFontSize -= 1;
          lines = this.wrapText(ctx, text, maxWidth, drawFontSize, fontFamily);
        }
        // 如果文字宽度不够，也缩小字号
        ctx.font = `${drawFontSize}px ${fontFamily}`;
        let textWidth = 0;
        for (const line of lines) {
          const lw = ctx.measureText(line).width;
          if (lw > textWidth) textWidth = lw;
        }
        while (textWidth > maxWidth && drawFontSize > 4) {
          drawFontSize -= 1;
          ctx.font = `${drawFontSize}px ${fontFamily}`;
          lines = this.wrapText(ctx, text, maxWidth, drawFontSize, fontFamily);
          textWidth = 0;
          for (const line of lines) {
            const lw = ctx.measureText(line).width;
            if (lw > textWidth) textWidth = lw;
          }
        }

        ctx.font = `${drawFontSize}px ${fontFamily}`;
        const lineHeight = drawFontSize * 1.3;
        const totalTextHeight = lines.length * lineHeight;
        let startY = oy + (oh - totalTextHeight) / 2 + lineHeight / 2;
        if (startY < oy + padding) startY = oy + padding + lineHeight / 2;

        for (const line of lines) {
          let x: number;
          if (textAlign === 'center') {
            x = ox + ow / 2;
            ctx.textAlign = 'center';
          } else if (textAlign === 'right') {
            x = ox + ow - padding;
            ctx.textAlign = 'right';
          } else {
            x = ox + padding;
            ctx.textAlign = 'left';
          }
          ctx.fillText(line, x, startY);
          startY += lineHeight;
        }
      }

      ctx.restore();
    }

    return canvas;
  }

  /** 在 canvas 上绘制圆角矩形 */
  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number, r: number
  ): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  /** 手动文字换行（中英日混排） */
  private wrapText(
    ctx: CanvasRenderingContext2D,
    text: string,
    maxWidth: number,
    fontSize: number,
    fontFamily: string
  ): string[] {
    ctx.font = `${fontSize}px ${fontFamily}`;
    const lines: string[] = [];
    const chars = [...text];
    let currentLine = '';

    for (const char of chars) {
      const testLine = currentLine + char;
      const testWidth = ctx.measureText(testLine).width;
      if (testWidth > maxWidth && currentLine.length > 0) {
        lines.push(currentLine);
        currentLine = char;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) {
      lines.push(currentLine);
    }

    return lines.length > 0 ? lines : [text];
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
