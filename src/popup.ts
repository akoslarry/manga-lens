// Popup UI Logic
document.addEventListener('DOMContentLoaded', async () => {
  // Tab switching
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.getElementById(`tab-${tab.getAttribute('data-tab')}`)?.classList.add('active');
    });
  });

  // Load saved config
  const config = await chrome.storage.sync.get(['minimaxKey', 'tencentSecretId', 'tencentSecretKey', 'directRegion', 'directAction', 'fontSize']);
  
  if (config.minimaxKey) {
    (document.getElementById('minimaxKey') as HTMLInputElement).value = config.minimaxKey;
  }
  if (config.tencentSecretId) {
    (document.getElementById('tencentSecretId') as HTMLInputElement).value = config.tencentSecretId;
  }
  if (config.tencentSecretKey) {
    (document.getElementById('tencentSecretKey') as HTMLInputElement).value = config.tencentSecretKey;
  }
  if (config.directRegion) {
    (document.getElementById('directRegion') as HTMLSelectElement).value = config.directRegion;
  }
  if (config.directAction) {
    (document.getElementById('directAction') as HTMLSelectElement).value = config.directAction;
  }
  if (config.fontSize) {
    (document.getElementById('fontSize') as HTMLInputElement).value = String(config.fontSize);
  }

  // Save config
  document.getElementById('btnSave')?.addEventListener('click', async () => {
    const key = (document.getElementById('minimaxKey') as HTMLInputElement).value;
    await chrome.storage.sync.set({ minimaxKey: key });
    showAlert('success', 'API Key 保存成功！');
  });

  // Save direct config
  document.getElementById('btnSaveDirect')?.addEventListener('click', async () => {
    const secretId = (document.getElementById('tencentSecretId') as HTMLInputElement).value;
    const secretKey = (document.getElementById('tencentSecretKey') as HTMLInputElement).value;
    const region = (document.getElementById('directRegion') as HTMLSelectElement).value;
    const action = (document.getElementById('directAction') as HTMLSelectElement).value;
    
    await chrome.storage.sync.set({ 
      tencentSecretId: secretId, 
      tencentSecretKey: secretKey,
      directRegion: region,
      directAction: action
    });
    showAlert('success', 'OCR 配置保存成功！');
  });

  // Save font size
  document.getElementById('fontSize')?.addEventListener('change', async (e) => {
    const fontSize = parseInt((e.target as HTMLInputElement).value);
    if (fontSize >= 10 && fontSize <= 36) {
      await chrome.storage.sync.set({ fontSize });
      showAlert('success', `字体大小已保存为 ${fontSize}px`);
    } else {
      showAlert('error', '字体大小范围：10-36px');
    }
  });

  // Test connection
  document.getElementById('btnTest')?.addEventListener('click', async () => {
    const key = (document.getElementById('minimaxKey') as HTMLInputElement).value;
    if (!key) {
      showAlert('error', '请输入 API Key');
      return;
    }
    showAlert('info', '正在测试...');
    try {
      const res = await fetch('https://api.minimaxi.chat/v1/text/chatcompletion_v2', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'abab6.5s-chat', messages: [{ role: 'user', content: 'hi' }] })
      });
      if (res.ok) {
        showAlert('success', '连接成功！');
      } else {
        showAlert('error', `连接失败: ${res.status}`);
      }
    } catch (e) {
      showAlert('error', '网络错误');
    }
  });

  // Refresh page
  document.getElementById('btnRefresh')?.addEventListener('click', () => {
    chrome.tabs.reload();
  });

  // Select image
  document.getElementById('btnSelect')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'selectImage' });
  });

  // Load stats
  const stats = await chrome.storage.local.get(['processedCount', 'cacheCount']);
  document.getElementById('processedCount')!.textContent = String(stats.processedCount || 0);
  document.getElementById('cacheCount')!.textContent = String(stats.cacheCount || 0);
});

function showAlert(type: 'success' | 'error' | 'info', message: string) {
  const container = document.getElementById('alertContainer')!;
  container.innerHTML = `<div class="alert alert-${type}">${message}</div>`;
  setTimeout(() => container.innerHTML = '', 3000);
}
