/**
 * Popup Script - 弹出窗口逻辑
 * v3.1 - DeepSeek V4 Pro 翻译引擎
 */

// DOM 元素
const toggleEnabled = document.getElementById('toggleEnabled');
const deepseekKeyInput = document.getElementById('deepseekKey');
const btnSave = document.getElementById('btnSave');
const btnTest = document.getElementById('btnTest');
const btnRefresh = document.getElementById('btnRefresh');
const btnSelect = document.getElementById('btnSelect');
const alertContainer = document.getElementById('alertContainer');
const processedCount = document.getElementById('processedCount');
const cacheCount = document.getElementById('cacheCount');

// OCR 直接API配置元素
const directConfigSection = document.getElementById('directConfigSection');
const tencentSecretIdInput = document.getElementById('tencentSecretId');
const tencentSecretKeyInput = document.getElementById('tencentSecretKey');
const directRegionSelect = document.getElementById('directRegion');
const directActionSelect = document.getElementById('directAction');
const btnSaveDirect = document.getElementById('btnSaveDirect');
const btnTestDirect = document.getElementById('btnTestDirect');

// 本地缓存
const toggleCacheEnabled = document.getElementById('toggleCacheEnabled');
const localCacheCount = document.getElementById('localCacheCount');

// 字体设置
const fontSizeInput = document.getElementById('fontSize');
const btnSaveFontSize = document.getElementById('btnSaveFontSize');

// 单次翻译上限
const batchLimitInput = document.getElementById('batchLimit');
const btnSaveBatchLimit = document.getElementById('btnSaveBatchLimit');
const btnContinueTranslation = document.getElementById('btnContinueTranslation');
const batchProgress = document.getElementById('batchProgress');

// 显示提示
function showAlert(message, type = 'success') {
  alertContainer.innerHTML = `<div class="alert alert-${type}">${message}</div>`;
  setTimeout(() => {
    alertContainer.innerHTML = '';
  }, 4000);
}

// 更新状态显示
async function updateStatus() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab.id) {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' });
      if (response) {
        processedCount.textContent = response.processedCount || 0;
        cacheCount.textContent = response.cacheSize || 0;
        if (response.localCacheSize !== undefined) {
          localCacheCount.textContent = response.localCacheSize;
        }
        if (response.cacheEnabled !== undefined) {
          toggleCacheEnabled.checked = response.cacheEnabled;
        }
        // 显示翻译进度
        if (response.batchCount !== undefined) {
          batchProgress.textContent = `${response.batchCount}/${response.batchLimit || 30}`;
        }
        // 显示/隐藏继续翻译按钮
        if (response.isPaused) {
          btnContinueTranslation.style.display = 'block';
        } else {
          btnContinueTranslation.style.display = 'none';
        }
      }
    }
  } catch (error) {
    console.error('获取状态失败:', error);
  }
}

// 加载保存的配置
async function loadConfig() {
  const result = await chrome.storage.local.get([
    'apiKey', 'apiSecret', 'deepseekApiKey', 'isEnabled',
    'tencentSecretId', 'tencentSecretKey', 'directRegion', 'directAction',
    'mangaLensFontSize', 'mangaLensBatchLimit'
  ]);
  
  if (result.deepseekApiKey) {
    deepseekKeyInput.value = result.deepseekApiKey;
  }
  toggleEnabled.checked = result.isEnabled !== false;
  
  // OCR 直接API配置（默认使用高精度OCR）
  if (result.tencentSecretId) {
    tencentSecretIdInput.value = result.tencentSecretId;
  }
  if (result.tencentSecretKey) {
    tencentSecretKeyInput.value = result.tencentSecretKey;
  }
  if (result.directRegion) {
    directRegionSelect.value = result.directRegion;
  }
  if (result.directAction) {
    directActionSelect.value = result.directAction;
  }
  
  // 字体大小设置
  if (result.mangaLensFontSize) {
    fontSizeInput.value = result.mangaLensFontSize;
  }

  // 单次翻译上限
  if (result.mangaLensBatchLimit) {
    batchLimitInput.value = result.mangaLensBatchLimit;
  }
}

// 初始化
async function init() {
  await loadConfig();
  await updateStatus();

  // 定期更新状态
  setInterval(updateStatus, 3000);
}

// 启动
init();

// 保存配置
btnSave.addEventListener('click', async () => {
  const deepseekKey = deepseekKeyInput.value.trim();

  // 允许不填（使用环境变量），但至少提示
  if (!deepseekKey) {
    showAlert('⚠️ DeepSeek API Key 为空，将尝试使用环境变量 DEEPSEEK_API_KEY', 'warning');
  }

  // 保存到 storage
  await chrome.storage.local.set({
    deepseekApiKey: deepseekKey
  });

  // 通知 content script
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab.id) {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'CONFIGURE_API',
        deepseekApiKey: deepseekKey
      });
    }
  } catch (error) {
    console.error('通知 content script 失败:', error);
  }

  showAlert('✅ DeepSeek 配置已保存！', 'success');
});

// 测试连接
btnTest.addEventListener('click', async () => {
  const deepseekKey = deepseekKeyInput.value.trim() || process.env.DEEPSEEK_API_KEY;

  if (!deepseekKey) {
    showAlert('请先填写 DeepSeek API Key 或设置环境变量 DEEPSEEK_API_KEY', 'error');
    return;
  }

  showAlert('正在测试 DeepSeek 连接...', 'warning');

  try {
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${deepseekKey}`
      },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        messages: [
          { role: 'user', content: '你好' }
        ],
        max_tokens: 10
      })
    });

    if (response.ok) {
      showAlert('✅ DeepSeek API 连接成功！', 'success');
    } else {
      const error = await response.text();
      showAlert(`❌ 连接失败: ${response.status}`, 'error');
    }
  } catch (error) {
    showAlert(`❌ 连接错误: ${error.message}`, 'error');
  }
});

// 保存直接API配置（使用高精度OCR）
btnSaveDirect.addEventListener('click', async () => {
  const secretId = tencentSecretIdInput.value.trim();
  const secretKey = tencentSecretKeyInput.value.trim();
  const directAction = directActionSelect.value;
  
  if (!secretId || !secretKey) {
    showAlert('请填写 SecretId 和 SecretKey', 'error');
    return;
  }
  
  const config = {
    ocrMode: 'direct',
    tencentSecretId: secretId,
    tencentSecretKey: secretKey,
    directRegion: directRegionSelect.value,
    directAction: directAction
  };
  
  await chrome.storage.local.set(config);
  
  // 通知 content script
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab.id) {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'CONFIGURE_OCR_DIRECT',
        ...config
      });
    }
  } catch (error) {
    console.error('通知 content script 失败:', error);
  }
  
  showAlert(`✅ ${directAction === 'GeneralAccurateOCR' ? '高精度' : directAction === 'HandwritingOCR' ? '手写体' : '基础'}OCR配置已保存！`, 'success');
});

// 测试直接API连接
btnTestDirect.addEventListener('click', async () => {
  const secretId = tencentSecretIdInput.value.trim();
  const secretKey = tencentSecretKeyInput.value.trim();
  const directAction = directActionSelect.value;
  
  if (!secretId || !secretKey) {
    showAlert('请先填写 SecretId 和 SecretKey', 'error');
    return;
  }
  
  const actionLabel = directAction === 'GeneralAccurateOCR' ? '高精度' : directAction === 'HandwritingOCR' ? '手写体' : '基础';
  showAlert(`正在测试腾讯云${actionLabel}OCR...`, 'warning');
  
  try {
    // 通过 background script 发送测试请求（避免 CORS 问题）
    const response = await chrome.runtime.sendMessage({
      target: 'background',
      type: 'TEST_DIRECT_OCR',
      secretId: secretId,
      secretKey: secretKey,
      region: directRegionSelect.value,
      action: directAction
    });
    
    if (response.success) {
      showAlert(`✅ ${actionLabel}OCR连接成功！`, 'success');
    } else {
      showAlert(`❌ 测试失败: ${response.message}`, 'error');
    }
  } catch (error) {
    console.error('直接API测试失败:', error);
    showAlert(`❌ 测试失败: ${error.message || '请刷新页面后重试'}`, 'error');
  }
});

// 刷新翻译
btnRefresh.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab.id) {
      await chrome.tabs.sendMessage(tab.id, { type: 'REFRESH' });
      showAlert('已刷新，正在重新翻译...', 'success');
    }
  } catch (error) {
    showAlert('刷新失败，请刷新页面后重试', 'error');
  }
});

// 手动选择图片
btnSelect.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab.id) {
      await chrome.tabs.sendMessage(tab.id, { type: 'SELECT_IMAGE' });
      showAlert('请在页面上点击要翻译的图片...', 'warning');
      window.close();
    }
  } catch (error) {
    showAlert('选择失败，请刷新页面后重试', 'error');
  }
});

// 保存字体大小设置
btnSaveFontSize.addEventListener('click', async () => {
  let fontSize = parseInt(fontSizeInput.value, 10);
  
  if (isNaN(fontSize) || fontSize < 10) {
    fontSize = 10;
  } else if (fontSize > 36) {
    fontSize = 36;
  }
  fontSizeInput.value = fontSize;

  // 持久化到 storage
  await chrome.storage.local.set({ mangaLensFontSize: fontSize });

  // 通知 content script
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab.id) {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'UPDATE_FONT_SIZE',
        fontSize
      });
    }
  } catch (error) {
    console.error('通知 content script 失败:', error);
  }

  showAlert(`✅ 字体大小已保存: ${fontSize}px（新图片刷新后生效）`, 'success');
});

// 保存单次翻译上限
btnSaveBatchLimit.addEventListener('click', async () => {
  let limit = parseInt(batchLimitInput.value, 10);

  if (isNaN(limit) || limit < 1) {
    limit = 1;
  } else if (limit > 100) {
    limit = 100;
  }
  batchLimitInput.value = limit;

  // 持久化到 storage
  await chrome.storage.local.set({ mangaLensBatchLimit: limit });

  // 通知 content script
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab.id) {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'UPDATE_BATCH_LIMIT',
        limit
      });
    }
  } catch (error) {
    console.error('通知 content script 失败:', error);
  }

  showAlert(`✅ 单次翻译上限已保存: ${limit} 张`, 'success');
  updateStatus();
});

// PDF导出
const pdfSavePath = document.getElementById('pdfSavePath');
const btnEnterPdfMode = document.getElementById('btnEnterPdfMode');

btnEnterPdfMode.addEventListener('click', async () => {
  const savePath = pdfSavePath.value.trim();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab.id) {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'ENTER_PDF_MODE',
        savePath
      });
      if (response && response.success) {
        showAlert('📄 已进入PDF导出模式（页面顶部可见工具栏）', 'success');
        window.close(); // 关闭popup让用户在页面上操作
      } else if (response && response.message === 'no translated images') {
        showAlert('⚠️ 暂无可导出的翻译结果，请先完成翻译', 'warning');
      } else {
        showAlert('进入PDF模式失败，请刷新页面后重试', 'error');
      }
    }
  } catch (error) {
    showAlert('操作失败，请刷新页面后重试', 'error');
  }
});

// 继续翻译按钮
btnContinueTranslation.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab.id) {
      await chrome.tabs.sendMessage(tab.id, { type: 'CONTINUE_TRANSLATION' });
      showAlert('✅ 翻译已恢复，计数已清零', 'success');
      btnContinueTranslation.style.display = 'none';
      await updateStatus();
    }
  } catch (error) {
    showAlert('操作失败，请刷新页面后重试', 'error');
  }
});

// 开关控制
toggleEnabled.addEventListener('change', async () => {
  const enabled = toggleEnabled.checked;
  await chrome.storage.local.set({ isEnabled: enabled });

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab.id) {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'TOGGLE_ENABLED',
        enabled
      });
    }
  } catch (error) {
    console.error('切换状态失败:', error);
  }

  await updateStatus();
});

// 本地缓存开关控制
toggleCacheEnabled.addEventListener('change', async () => {
  const enabled = toggleCacheEnabled.checked;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab.id) {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'TOGGLE_CACHE',
        enabled
      });
    }
  } catch (error) {
    console.error('切换缓存状态失败:', error);
  }

  await updateStatus();
});

// 标签页切换
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    // 移除所有active
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    
    // 添加active
    tab.classList.add('active');
    const targetId = `tab-${tab.dataset.tab}`;
    document.getElementById(targetId).classList.add('active');
  });
});

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', init);
init();
