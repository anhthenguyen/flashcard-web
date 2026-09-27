(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RepositoryStorage = api;
})(globalThis, function () {
'use strict';
const path = { basename: value => value.split('/').pop() };
function decodeBase64(value) {
  return new TextDecoder().decode(Uint8Array.from(atob(value.replace(/\s/g, '')), char => char.charCodeAt(0)));
}
function encodeBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

function safePath(value) {
  if (typeof value !== 'string' || !value || /[\\\x00-\x1f]/.test(value) || value.startsWith('/') || value.split('/').some(p => !p || p === '.' || p === '..')) {
    throw Object.assign(new Error('Invalid repository path'), { status: 400 });
  }
  return value;
}

class RepositoryStore {
  constructor(env = (typeof process !== 'undefined' ? process.env : {}), fetcher = fetch) {
    this.provider = env.DATA_BACKEND;
    if (!['github', 'gitlab'].includes(this.provider)) throw new Error('DATA_BACKEND must be local, github or gitlab');
    this.repo = env.REPO_PROJECT;
    this.branch = env.REPO_BRANCH;
    if (!this.repo || !this.branch) throw new Error('REPO_PROJECT and REPO_BRANCH are required');
    if (this.provider === 'github' && !/^[^/]+\/[^/]+$/.test(this.repo)) throw new Error('GitHub REPO_PROJECT must be owner/repository');
    this.token = env.REPO_TOKEN;
    this.base = (env.REPO_API_URL || (this.provider === 'github' ? 'https://api.github.com' : 'https://gitlab.com/api/v4')).replace(/\/$/, '');
    if (new URL(this.base).protocol !== 'https:') throw new Error('REPO_API_URL must use HTTPS');
    this.root = env.REPO_ROOT ? safePath(env.REPO_ROOT) : '';
    // Native window.fetch cannot be invoked with RepositoryStore as its receiver.
    this.fetcher = (...args) => fetcher(...args);
    this.queue = Promise.resolve();
  }

  full(file) { return [this.root, safePath(file)].filter(Boolean).join('/'); }
  prefix() {
    return this.provider === 'github'
      ? '/repos/' + this.repo.split('/').map(encodeURIComponent).join('/')
      : '/projects/' + encodeURIComponent(this.repo);
  }
  fileUrl(file) {
    const full = this.full(file);
    return this.prefix() + (this.provider === 'github'
      ? '/contents/' + full.split('/').map(encodeURIComponent).join('/')
      : '/repository/files/' + encodeURIComponent(full));
  }
  async request(endpoint, { method = 'GET', body, missing = false, raw = false } = {}) {
    const headers = { Accept: raw ? 'application/vnd.github.raw+json' : 'application/json' };
    if (this.provider === 'github') {
      headers['X-GitHub-Api-Version'] = '2022-11-28';
      if (this.token) headers.Authorization = 'Bearer ' + this.token;
    } else if (this.token) headers['PRIVATE-TOKEN'] = this.token;
    if (body) headers['Content-Type'] = 'application/json';
    const response = await this.fetcher(this.base + endpoint, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000), redirect: 'error', cache: 'no-store', credentials: 'omit',
    });
    if (missing && response.status === 404) return null;
    if (!response.ok) {
      const status = response.status;
      throw Object.assign(new Error(`Repository API returned ${status}; check repository, branch, token permissions or rate limit`), { status: status === 409 ? 409 : 502, upstreamStatus: status });
    }
    return { data: raw ? await response.text() : await response.json(), headers: response.headers };
  }
  async read(file) {
    const endpoint = this.fileUrl(file) + '?ref=' + encodeURIComponent(this.branch);
    const result = await this.request(endpoint, { missing: true });
    if (!result) return null;
    const data = result.data;
    if (data.type && data.type !== 'file') throw new Error('Expected a repository file');
    let text;
    if (data.encoding === 'base64') text = decodeBase64(data.content);
    else if (this.provider === 'github' && data.encoding === 'none') text = (await this.request(endpoint, { raw: true })).data;
    else throw new Error('Unsupported repository file encoding');
    return { text, version: this.provider === 'github' ? data.sha : data.last_commit_id };
  }
  async write(file, text, previous) {
    if (!this.token) throw Object.assign(new Error('REPO_TOKEN is required to save repository files'), { status: 403 });
    const content = encodeBase64(text);
    const message = 'Flashcard: update ' + file;
    const github = this.provider === 'github';
    const body = github
      ? { message, content, branch: this.branch, ...(previous ? { sha: previous.version } : {}) }
      : { commit_message: message, content, encoding: 'base64', branch: this.branch, ...(previous ? { last_commit_id: previous.version } : {}) };
    await this.request(this.fileUrl(file), { method: github || previous ? 'PUT' : 'POST', body });
  }
  // Serialize read/modify/write operations across all files for this client.
  update(file, transform) {
    const operation = this.queue.then(async () => {
      const previous = await this.read(file);
      const next = transform(previous?.text ?? null);
      if (next.text !== undefined && next.text !== previous?.text) await this.write(file, next.text, previous);
      return next.result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  async listYamlFiles() {
    const directory = this.full('data');
    let entries = [];
    if (this.provider === 'github') {
      const result = await this.request(this.prefix() + '/git/trees/' + encodeURIComponent(this.branch) + '?recursive=1');
      if (result.data.truncated) throw new Error('Repository tree is too large; use a smaller repository');
      entries = result.data.tree.filter(item => item.type === 'blob');
    } else {
      let page = '1';
      while (page) {
        const query = new URLSearchParams({ path: directory, ref: this.branch, recursive: 'true', per_page: '100', page });
        const result = await this.request(this.prefix() + '/repository/tree?' + query);
        entries.push(...result.data.filter(item => item.type === 'blob'));
        const nextPage = result.headers.get('x-next-page');
        page = nextPage !== null ? nextPage : (result.data.length === 100 ? String(Number(page) + 1) : '');
      }
    }
    return entries.filter(item => item.path.startsWith(directory + '/') && /^[\w.-]+\.ya?ml$/i.test(path.basename(item.path)))
      .map(item => item.path.slice(directory.length + 1)).sort();
  }
}

return { RepositoryStore, safePath, encodeBase64, decodeBase64 };

});
