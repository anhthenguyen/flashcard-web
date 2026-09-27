(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./repository-store'), require('./card-format'));
  else root.BrowserRepository = factory(root.RepositoryStorage, root.CardFormat);
})(globalThis, function ({ RepositoryStore, safePath }, { parseYamlList, buildYamlFromCards, parseTexts, unknownFileFor }) {
  const configKey = 'flashcard.repository.config';
  const sessionKey = 'flashcard.repository.session';
  const configFields = ['provider', 'project', 'branch', 'root', 'apiUrl', 'syncState'];

  function publicConfig(config) {
    return Object.fromEntries(configFields.map(key => [key, config[key]]));
  }
  function identity(config) {
    return JSON.stringify([config.provider, config.apiUrl || '', config.project, config.branch, config.root || '']);
  }
  function saveConnection(config, token, remember, local, session) {
    local.setItem(configKey, JSON.stringify(publicConfig(config)));
    session.removeItem(sessionKey);
    if (remember && token) session.setItem(sessionKey, JSON.stringify({ identity: identity(config), token }));
  }
  function loadConnection(local, session) {
    let config = {}, token = '';
    try { config = publicConfig(JSON.parse(local.getItem(configKey) || '{}')); } catch (_) { /* Empty settings. */ }
    try {
      const saved = JSON.parse(session.getItem(sessionKey) || '{}');
      if (saved.identity === identity(config)) token = saved.token || '';
    } catch (_) { /* A new session has no token. */ }
    return { config, token };
  }
  function yamlFile(file) {
    safePath(file);
    if (!/^[\w.-]+\.ya?ml$/i.test(file.split('/').pop())) throw new Error('Tên file YAML không hợp lệ.');
    return file;
  }

  class BrowserApi {
    constructor(config, token, { fetcher = fetch, storage = localStorage } = {}) {
      this.config = publicConfig(config);
      this.storage = storage;
      this.stateKey = 'flashcard.position.' + identity(config);
      this.canWrite = Boolean(token);
      this.store = new RepositoryStore({
        DATA_BACKEND: config.provider, REPO_PROJECT: config.project, REPO_BRANCH: config.branch,
        REPO_ROOT: config.root, REPO_API_URL: config.apiUrl, REPO_TOKEN: token,
      }, fetcher);
      this.details = new Map();
    }
    async cards(file) {
      const entry = await this.store.read('data/' + yamlFile(file));
      return parseYamlList(entry?.text || '');
    }
    async request(route, options = {}) {
      const url = new URL(route, 'https://flashcard.invalid');
      const method = options.method || 'GET';
      const body = options.body ? JSON.parse(options.body) : {};
      if (method === 'GET' && url.pathname === '/api/files') {
        const files = await this.store.listYamlFiles();
        return { files, defaultFile: 'cards.yaml', unknownFile: 'cards_unknown.yaml', unknownCount: 0 };
      }
      if (method === 'GET' && url.pathname === '/api/cards') {
        const file = yamlFile(url.searchParams.get('file') || 'cards.yaml');
        const unknownFile = unknownFileFor(file);
        const [cards, unknown] = await Promise.all([this.cards(file), this.cards(unknownFile)]);
        return { cards, file, unknownFile, unknownCount: unknown.length };
      }
      if (method === 'GET' && url.pathname === '/api/details') {
        const file = yamlFile(url.searchParams.get('file'));
        const word = url.searchParams.get('word');
        if (!word || /[<>:"/\\|?*\x00-\x1f]/.test(word) || word === '.' || word === '..') return { available: false };
        const parts = file.split('/');
        parts.pop();
        const detailPath = ['data', ...parts, 'details', word + '.md'].join('/');
        if (!this.details.has(detailPath)) {
          const entry = await this.store.read(detailPath);
          this.details.set(detailPath, entry ? { available: true, markdown: entry.text } : { available: false });
        }
        return this.details.get(detailPath);
      }
      if (method === 'GET' && url.pathname === '/api/texts') return parseTexts((await this.store.read('texts.yaml'))?.text || '');
      if (url.pathname === '/api/state') {
        if (method === 'GET') {
          const saved = this.storage.getItem(this.stateKey);
          const remote = this.config.syncState ? await this.store.read('last-state.json') : null;
          const state = JSON.parse(remote?.text || saved || '{}');
          const lastFile = state.lastFile || state.file || null;
          return { ...state, lastFile, file: lastFile, word: state.files?.[lastFile]?.word, mean: state.files?.[lastFile]?.mean };
        }
        if (method === 'POST') {
          if (body.file) yamlFile(body.file);
          const change = text => {
            const state = JSON.parse(text || '{}');
            state.files = { ...(state.files || {}) };
            if (body.file) {
              state.lastFile = body.file;
              if (body.word || body.mean) state.files[body.file] = { word: body.word, mean: body.mean };
              else delete state.files[body.file];
            }
            return { text: JSON.stringify(state, null, 2), result: { ok: true } };
          };
          this.storage.setItem(this.stateKey, change(this.storage.getItem(this.stateKey)).text);
          if (this.config.syncState) return this.store.update('last-state.json', change);
          return { ok: true };
        }
      }
      if (method === 'POST' && ['/api/save-unknown', '/api/remove-unknown'].includes(url.pathname)) {
        if (!this.canWrite) throw new Error('Nhập token trong Cấu hình để lưu thay đổi.');
        const source = yamlFile(body.sourceFile || 'cards.yaml');
        const targetFile = yamlFile(body.targetFile || unknownFileFor(source));
        const card = body.card || {};
        if (!card.word || !card.mean) throw new Error('Thẻ thiếu từ hoặc nghĩa.');
        return this.store.update('data/' + targetFile, text => {
          const cards = parseYamlList(text || '');
          const index = cards.findIndex(c => c.word === card.word && c.mean === card.mean);
          if (url.pathname === '/api/save-unknown') {
            if (index !== -1) return { result: { ok: false, duplicate: true, count: cards.length } };
            cards.push(card);
          } else {
            if (index === -1) throw new Error('Từ không còn trong danh sách chưa thuộc. Hãy tải lại dữ liệu.');
            cards.splice(index, 1);
          }
          return { text: buildYamlFromCards(cards), result: { ok: true, targetFile, count: cards.length } };
        });
      }
      throw new Error('Thao tác không được hỗ trợ.');
    }
  }
  return { BrowserApi, saveConnection, loadConnection, configKey, sessionKey };
});
