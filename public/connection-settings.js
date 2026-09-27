(function () {
  'use strict';
  function errorMessage(error) {
    const status = error.upstreamStatus;
    if (status === 401) return 'Token không hợp lệ hoặc đã hết hạn. Hãy nhập lại trong Cấu hình repository.';
    if (status === 403) return 'API từ chối truy cập. Kiểm tra quyền token, quyền ghi branch và hạn mức API.';
    if (status === 404) return 'Không tìm thấy repository hoặc branch. Kiểm tra cấu hình và quyền đọc của token.';
    if ([400, 409, 422].includes(status)) return 'Không lưu được thay đổi. File có thể đã được sửa ở nơi khác hoặc branch đang được bảo vệ. Hãy tải lại và thử lại.';
    if (status === 429) return 'Đã vượt hạn mức API. Hãy chờ rồi thử lại.';
    if (error.name === 'TimeoutError' || (error.name === 'TypeError' && /failed to fetch|networkerror|load failed|fetch failed/i.test(error.message))) return 'Không kết nối được API. Kiểm tra mạng, API URL và cấu hình CORS nếu dùng máy chủ riêng.';
    return error.message || 'Không tải được dữ liệu.';
  }
  async function init({ connect, disconnect, pause }) {
    const get = id => document.getElementById(id);
    const panel = get('connectionPanel');
    const status = get('connectionStatus');
    const button = get('connectRepository');
    const forget = get('disconnectRepository');
    const loaded = BrowserRepository.loadConnection(localStorage, sessionStorage);
    const config = loaded.config;
    get('repoProvider').value = config.provider || 'github';
    get('repoProject').value = config.project || '';
    get('repoBranch').value = config.branch || 'main';
    get('repoRoot').value = config.root || '';
    get('repoApiUrl').value = config.apiUrl || '';
    get('repoToken').value = loaded.token;
    get('rememberToken').checked = Boolean(loaded.token);
    get('syncState').checked = Boolean(config.syncState);
    if (!config.project && location.hostname.endsWith('.github.io')) {
      const owner = location.hostname.slice(0, -'.github.io'.length);
      get('repoProject').value = owner + '/' + (location.pathname.split('/').filter(Boolean)[0] || owner + '.github.io');
    }
    panel.addEventListener('toggle', () => { if (panel.open) pause(); });
    get('rememberToken').addEventListener('change', () => {
      if (!get('rememberToken').checked) sessionStorage.removeItem(BrowserRepository.sessionKey);
    });
    async function submit(event) {
      event?.preventDefault();
      if (button.disabled) return;
      button.disabled = true;
      forget.disabled = true;
      status.textContent = 'Đang kết nối…';
      get('apiError').hidden = true;
      const config = {
        provider: get('repoProvider').value,
        project: get('repoProject').value.trim(), branch: get('repoBranch').value.trim(),
        root: get('repoRoot').value.trim(), apiUrl: get('repoApiUrl').value.trim(),
        syncState: get('syncState').checked,
      };
      const token = get('repoToken').value.trim();
      try {
        if (config.syncState && !token) throw new Error('Cần token để đồng bộ vị trí học lên repository.');
        const client = new BrowserRepository.BrowserApi(config, token);
        await connect(client);
        BrowserRepository.saveConnection(config, token, get('rememberToken').checked, localStorage, sessionStorage);
        status.textContent = `${config.provider === 'github' ? 'GitHub' : 'GitLab'}: ${config.project} · ${config.branch}${token ? '' : ' · Chỉ đọc'} · ${config.syncState ? 'Đồng bộ vị trí học' : 'Vị trí học lưu trên thiết bị'}`;
        panel.open = false;
      } catch (error) {
        await disconnect();
        status.textContent = errorMessage(error);
        panel.open = true;
      } finally {
        button.disabled = false;
        forget.disabled = false;
      }
    }
    get('connectionForm').addEventListener('submit', submit);
    forget.addEventListener('click', async () => {
      button.disabled = true;
      forget.disabled = true;
      try {
        await disconnect();
        sessionStorage.removeItem(BrowserRepository.sessionKey);
        localStorage.removeItem(BrowserRepository.configKey);
        get('repoToken').value = '';
        get('rememberToken').checked = false;
        get('apiError').hidden = true;
        panel.open = true;
        status.textContent = 'Đã ngắt kết nối và xóa token. Vị trí học trên thiết bị được giữ lại.';
      } finally { button.disabled = false; forget.disabled = false; }
    });
    if (config.project) await submit();
  }
  globalThis.RepositorySettings = { init, errorMessage };
})();
