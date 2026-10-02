const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function fixture(settings = {}) {
  const nodes = new Map(), writes = [], requests = [], faces = new Set(), notices = [];
  const errors = new Map(), delayed = new Map(), presets = new Map();
  function element(id = '', tagName = 'DIV') {
    const values = new Map(), priorities = new Map();
    return {
      id, tagName, value: '', textContent: '', innerHTML: '', checked: false, disabled: false,
      dataset: {}, children: [], listeners: {}, isConnected: true,
      style: { getPropertyValue: key => values.get(key) || '', getPropertyPriority: key => priorities.get(key) || '',
        setProperty(key, value, priority = '') { values.set(key, value); priorities.set(key, priority); },
        removeProperty(key) { values.delete(key); } },
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
      async emit(type, extra = {}) { for (const fn of this.listeners[type] || []) await fn({ target: this, ...extra }); },
      appendChild(child) { this.children.push(child); return child; }, append(...children) { this.children.push(...children); },
      after(child) { this.derived = child; }, remove() { this.isConnected = false; },
      querySelectorAll: () => [], closest: () => null, click() {}
    };
  }
  const get = id => { if (!nodes.has(id)) nodes.set(id, element(id)); return nodes.get(id); };
  const scopes = ['homeScreen', 'qq', 'cphone', 'myphone', 'worldBook', 'douban', 'alipay', 'settings', 'other'].map(key => {
    const node = element(`scope-${key}`, 'INPUT'); node.dataset.scope = key; return node;
  });
  const table = {
    where() { return { equals() { return { toArray: async () => [...presets.values()] }; }, first: async () => undefined }; },
    async get(id) { return presets.get(id); }, async add(value) { presets.set(presets.size + 1, value); },
    async update(id, value) { Object.assign(presets.get(id), value); }, async delete(id) { presets.delete(id); }
  };
  const c = { console, URL, AbortController, setTimeout, clearTimeout,
    state: { globalSettings: { id: 'main', unrelated: { keep: true }, ...settings } },
    db: { globalSettings: { async put(value) { writes.push(JSON.parse(JSON.stringify(value))); } }, appearancePresets: table },
    document: { body: element('body'), styleSheets: [], fonts: { add: face => faces.add(face), delete: face => faces.delete(face) },
      getElementById: get, createElement: tag => element('', tag.toUpperCase()), querySelectorAll: selector => selector.includes('font-scope-list') ? scopes : [] },
    dynamicFontStyle: element('dynamic-font-style', 'STYLE'),
    FontFace: class { constructor(family, bytes) { this.family = family; this.bytes = bytes; } async load() { if (new Uint8Array(this.bytes)[0] === 0) throw Error('bad font'); return this; } },
    async fetch(url) {
      requests.push(url);
      if (delayed.has(url)) await delayed.get(url);
      if (errors.has(url)) throw Error(errors.get(url));
      return { ok: !url.includes('404'), status: url.includes('404') ? 404 : 200,
        headers: { get: () => url.includes('webpage') ? 'text/html' : 'font/woff2' },
        arrayBuffer: async () => Uint8Array.from([url.includes('broken') ? 0 : 1, 2]).buffer };
    },
    FileReader: class { readAsDataURL(file) { this.result = file.data; queueMicrotask(() => this.onload()); } },
    showToast: (message, kind) => notices.push({ message, kind }),
    showCustomPrompt: async () => '字体预设', showCustomConfirm: async () => true,
    showChoiceModal: async () => 'discard', showScreen: id => { c.screen = id; }
  };
  c.window = c;
  vm.createContext(c);
  vm.runInContext(source('modules/data/custom-fonts.js'), c);
  vm.runInContext(source('modules/settings/font-presets.js'), c);
  c.bindFontSettingsEvents();
  c.openFontSettings();
  return { c, get, scopes, writes, requests, faces, notices, errors, delayed, presets, element,
    run: code => vm.runInContext(code, c), async flush() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); } };
}

test('预览开关展开、关闭；字号重置同步 UI，正式设置不变，事件不重复绑定', async () => {
  const f = fixture({ globalFontSize: 12 });
  f.get('font-preview-toggle').checked = true; await f.get('font-preview-toggle').emit('change'); await f.flush();
  assert.equal(f.get('font-preview-container').style.display, 'block');
  assert.equal(f.get('font-preview').style.fontSize, '12px');
  await f.get('reset-font-size-btn').emit('click');
  assert.equal(f.get('font-size-slider').value, 16); assert.equal(f.get('font-size-value').textContent, '16');
  assert.equal(f.get('font-preview').style.fontSize, '16px'); assert.equal(f.c.state.globalSettings.globalFontSize, 12);
  f.get('font-preview-toggle').checked = false; await f.get('font-preview-toggle').emit('change');
  assert.equal(f.get('font-preview-container').style.display, 'none');
  f.c.bindFontSettingsEvents(); assert.equal(f.get('save-font-btn').listeners.click.length, 1);
});

test('本地字体默认字号 16 在启动恢复，范围设置及旧字段均可读取', async () => {
  const f = fixture({ fontLocalData: 'data:font/ttf;base64,AQ==', globalFontSize: 16 });
  await f.c.applyCustomFont('');
  assert.equal(f.requests.length, 1); assert.equal(f.faces.size, 1);
  assert.match(f.c.dynamicFontStyle.textContent, /ephone-user-font/);
  assert.equal(f.c.normalizeFontSettings(f.c.state.globalSettings).fontSourceMode, 'local');
  const startup = source('src/js-bundles/event-bindings-a/global-controls-and-music.jsfrag');
  assert.match(startup, /if \(state.globalSettings\) void applyCustomFont/);
});

test('清空链接做预览不清除正式字体；预览与正式字体不同来源时互不影响', async () => {
  const f = fixture({ fontUrl: 'https://fonts.example/old.woff2' });
  await f.c.applyCustomFont(f.c.state.globalSettings.fontUrl);
  const before = f.c.dynamicFontStyle.textContent;
  f.get('font-preview-toggle').checked = true;
  await f.c.applyCustomFont('', true);
  assert.equal(f.c.dynamicFontStyle.textContent, before);
  await f.c.applyCustomFont('https://fonts.example/new.woff2', true);
  assert.equal(f.c.dynamicFontStyle.textContent, before);
  assert.match(f.get('font-preview').style.fontFamily, /ephone-user-font-2/);
  assert.equal(f.c.state.globalSettings.fontUrl, 'https://fonts.example/old.woff2');
});

test('无效、404、网页及无法解析的字体均阻止保存，不误报成功', async () => {
  for (const url of ['not-a-url', 'https://fonts.example/404', 'https://fonts.example/webpage', 'https://fonts.example/broken']) {
    const f = fixture({ fontUrl: 'https://fonts.example/valid' });
    await f.c.applyCustomFont(f.c.state.globalSettings.fontUrl);
    const before = f.c.dynamicFontStyle.textContent;
    f.run(`getFontDraft().fontUrl=${JSON.stringify(url)};getFontDraft().fontSourceMode='url'`);
    assert.equal(await f.c.saveFontSettings(), false, url);
    assert.equal(f.writes.length, 0); assert.equal(f.c.dynamicFontStyle.textContent, before);
    assert.equal(f.c.state.globalSettings.fontUrl, 'https://fonts.example/valid');
    assert.equal(f.get('font-load-status').dataset.kind, 'error');
  }
});

test('保存失败保留正式状态和草稿；成功保存合并最新无关字段，连续保存复用字体', async () => {
  const f = fixture();
  f.run("getFontDraft().fontSourceMode='url';getFontDraft().fontUrl='https://fonts.example/a';getFontDraft().globalFontSize=20");
  f.c.db.globalSettings.put = async () => { throw Error('quota'); };
  assert.equal(await f.c.saveFontSettings(), false);
  assert.equal(f.c.state.globalSettings.fontUrl, undefined); assert.equal(f.run('getFontDraft().globalFontSize'), 20);
  f.c.state.globalSettings.otherChanged = 'latest';
  f.c.db.globalSettings.put = async value => f.writes.push(value);
  assert.equal(await f.c.saveFontSettings(), true);
  assert.equal(f.writes[0].otherChanged, 'latest'); assert.deepEqual(f.writes[0].unrelated, { keep: true });
  assert.equal(f.c.state.globalSettings.globalFontSize, 20); assert.match(f.c.dynamicFontStyle.textContent, /--user-font-scale:1.25/);
  assert.equal(await f.c.saveFontSettings(), true); assert.equal(f.requests.length, 1);
});

test('保存锁阻止重复提交，加载期间继续编辑不会污染保存快照', async () => {
  const f = fixture(), url = 'https://fonts.example/slow'; let release;
  f.delayed.set(url, new Promise(resolve => { release = resolve; }));
  f.run(`getFontDraft().fontSourceMode='url';getFontDraft().fontUrl=${JSON.stringify(url)}`);
  const saving = f.c.saveFontSettings();
  assert.equal(await f.c.saveFontSettings(), false);
  f.get('font-size-slider').value = '23'; await f.get('font-size-slider').emit('input');
  release(); assert.equal(await saving, true);
  assert.equal(f.c.state.globalSettings.globalFontSize, 16); assert.equal(f.run('getFontDraft().globalFontSize'), 23);
  assert.equal(f.writes.length, 1); assert.equal(f.get('save-font-btn').disabled, false);
});

test('快速切换字体只展示最后一次结果，关闭预览后迟到结果不改状态', async () => {
  const f = fixture(), slow = 'https://fonts.example/slow'; let release;
  f.delayed.set(slow, new Promise(resolve => { release = resolve; }));
  f.get('font-preview-toggle').checked = true;
  const older = f.c.applyCustomFont(slow, true);
  await f.c.applyCustomFont('https://fonts.example/new', true);
  const family = f.get('font-preview').style.fontFamily;
  release(); await older; assert.equal(f.get('font-preview').style.fontFamily, family);
  let releaseClosed; const closed = 'https://fonts.example/closed';
  f.delayed.set(closed, new Promise(resolve => { releaseClosed = resolve; }));
  const pending = f.c.applyCustomFont(closed, true);
  f.get('font-preview-toggle').checked = false; await f.get('font-preview-toggle').emit('change');
  const status = f.get('font-load-status').textContent;
  releaseClosed(); await pending; assert.equal(f.get('font-load-status').textContent, status);
});

test('本地上传成功只改变草稿；坏文件和超限文件保留原字体，可切回网络并清除', async () => {
  const f = fixture({ fontUrl: 'https://fonts.example/existing' });
  const input = f.get('font-local-file-input');
  input.files = [{ name: '字体.woff2', size: 1024, data: 'data:font/woff2;base64,AQ==' }];
  await input.emit('change');
  assert.equal(f.c.state.globalSettings.fontLocalData, undefined); assert.equal(f.run('getFontDraft().fontSourceMode'), 'local');
  assert.equal(f.get('font-local-filename').textContent, '字体.woff2'); assert.equal(f.get('font-url-input').disabled, true);
  input.files = [{ name: '坏文件.ttf', size: 12, data: 'data:broken,AQ==' }]; await input.emit('change');
  assert.equal(f.run('getFontDraft().fontLocalName'), '字体.woff2');
  input.files = [{ name: '大字体.ttf', size: 11 * 1024 * 1024 }]; await input.emit('change');
  assert.equal(f.run('getFontDraft().fontLocalName'), '字体.woff2');
  await f.get('font-local-clear-btn').emit('click');
  assert.equal(f.run('getFontDraft().fontSourceMode'), 'url'); assert.equal(f.get('font-url-input').disabled, false);
  assert.equal(f.c.state.globalSettings.fontUrl, 'https://fonts.example/existing');
});

test('部分范围恢复保留未选区域、本地字体和无关配置；全部恢复清理加载资源', async () => {
  const f = fixture({ fontLocalData: 'data:font/ttf;base64,AQ==', globalFontSize: 20, fontScope: { all: true } });
  await f.c.applyCustomFont('');
  const next = f.c.normalizeFontSettings(f.c.state.globalSettings); next.fontScope.all = false; next.fontScope.qq = false;
  assert.equal(await f.c.resetFontSettings(next, 'restored'), true);
  assert.equal(f.c.state.globalSettings.fontLocalData, 'data:font/ttf;base64,AQ==');
  assert.equal(f.c.state.globalSettings.fontScope.homeScreen, true); assert.equal(f.c.state.globalSettings.fontScope.other, true);
  assert.match(f.c.dynamicFontStyle.textContent, /#chat-list-screen[^{}]+\{--user-font-scale:1;/);
  assert.equal(f.requests.length, 1);
  await f.c.resetToDefaultFont();
  assert.equal(f.c.state.globalSettings.globalFontSize, 16); assert.equal(f.c.state.globalSettings.fontLocalData, '');
  assert.equal(f.faces.size, 0); assert.equal(f.c.state.globalSettings.unrelated.keep, true);
  assert.equal(f.run('fontLoadCache.size'), 0); assert.equal(f.get('font-size-value').textContent, '16');
});

test('真实范围恢复入口支持本地字体，必须选择区域，取消不污染共享弹窗', async () => {
  const f = fixture({ fontLocalData: 'data:font/ttf;base64,AQ==', globalFontSize: 16 });
  await f.c.applyCustomFont('');
  let resolve;
  f.c.showCustomConfirm = () => new Promise(done => { resolve = done; });
  const pending = f.c.resetFontByScope();
  const confirm = f.get('custom-modal-confirm');
  assert.equal(confirm.disabled, true);
  const choices = f.get('custom-modal-body').children.at(-1);
  const qq = choices.children[1].children[0]; qq.checked = true;
  await choices.emit('change', { target: qq }); assert.equal(confirm.disabled, false);
  resolve(true); await pending;
  assert.equal(f.c.state.globalSettings.fontScope.qq, false); assert.equal(f.c.state.globalSettings.fontScope.homeScreen, true);
  const canceled = f.c.resetFontByScope(); assert.equal(confirm.disabled, true);
  resolve(false); await canceled; assert.equal(confirm.disabled, false);
  assert.equal(f.c.state.globalSettings.fontScope.homeScreen, true);
});

test('启动加载失败保留配置与字号，可从重新加载入口恢复；迟到字体不能突破全部重置', async () => {
  const url = 'https://fonts.example/offline';
  const f = fixture({ fontUrl: url, globalFontSize: 20 }); f.errors.set(url, 'network');
  await f.c.applyCustomFont(url);
  assert.equal(f.c.state.globalSettings.fontUrl, url); assert.match(f.c.dynamicFontStyle.textContent, /font-size:20px/);
  f.errors.delete(url); await f.get('font-reload-btn').emit('click');
  assert.equal(f.get('font-preview-toggle').checked, true); assert.equal(f.get('font-load-status').dataset.kind, 'success');
  assert.equal(await f.c.saveFontSettings(), true);
  const slow = 'https://fonts.example/late'; let release;
  f.delayed.set(slow, new Promise(done => { release = done; }));
  const loading = f.c.applyCustomFont(slow, true);
  await f.c.resetToDefaultFont(); release(); await loading;
  assert.equal(f.faces.size, 0); assert.equal(f.c.state.globalSettings.fontUrl, '');
  assert.equal(f.get('font-preview').style.fontFamily.includes('ephone-user-font'), false);
});

test('旧链接预设只替换来源；完整预设支持本地数据、大小、范围与默认字体', async () => {
  const f = fixture({ fontLocalData: 'data:font/ttf;base64,AQ==', globalFontSize: 22 });
  f.presets.set(1, { id: 1, name: '旧字体', type: 'font', value: 'https://fonts.example/legacy' });
  f.get('font-preset-select').value = '1'; await f.c.handleFontPresetSelectionChange();
  assert.equal(f.run('getFontDraft().fontSourceMode'), 'url'); assert.equal(f.run('getFontDraft().globalFontSize'), 22);
  assert.equal(f.run('getFontDraft().fontLocalData'), 'data:font/ttf;base64,AQ==');
  f.presets.set(2, { id: 2, name: '本地', type: 'font', value: { fontLocalData: 'data:font/ttf;base64,Ag==', fontLocalName: 'saved.ttf', globalFontSize: 18, fontScope: { all: false, qq: false } } });
  f.get('font-preset-select').value = '2'; await f.c.handleFontPresetSelectionChange();
  assert.equal(f.run('getFontDraft().fontSourceMode'), 'local'); assert.equal(f.run('getFontDraft().fontScope.qq'), false);
  await f.c.saveFontPreset();
  const saved = [...f.presets.values()].at(-1).value;
  assert.equal(saved.fontLocalName, 'saved.ttf'); assert.equal(saved.globalFontSize, 18);
  assert.equal(f.writes.length, 0); assert.equal(f.c.state.globalSettings.globalFontSize, 22);
});

test('过期的预设读取不覆盖新编辑；来源与字号边界兼容旧配置', async () => {
  const f = fixture(); let release;
  f.c.db.appearancePresets.get = async () => { await new Promise(resolve => { release = resolve; }); return { value: 'https://fonts.example/stale' }; };
  f.get('font-preset-select').value = '1'; const pending = f.c.handleFontPresetSelectionChange();
  f.get('font-size-slider').value = '20'; await f.get('font-size-slider').emit('input'); release(); await pending;
  assert.equal(f.run('getFontDraft().fontUrl'), ''); assert.equal(f.run('getFontDraft().globalFontSize'), 20);
  assert.equal(f.c.normalizeFontSettings({ globalFontSize: 'wrong' }).globalFontSize, 16);
  assert.equal(f.c.normalizeFontSettings({ globalFontSize: 99 }).globalFontSize, 28);
  assert.equal(f.c.normalizeFontSettings({ fontScope: { all: false, qq: true } }).fontScope.other, false);
  assert.equal(f.c.normalizeFontSettings({ fontScope: { all: false, qq: true } }).fontScope.homeScreen, false);
});

test('退出可继续编辑、放弃或保存；保存失败留在页面，原有目标入口保留', async () => {
  const f = fixture(); f.get('font-size-slider').value = '20'; await f.get('font-size-slider').emit('input');
  f.c.showChoiceModal = async () => 'stay'; await f.c.leaveFontSettings(); assert.equal(f.c.screen, undefined);
  f.c.showChoiceModal = async () => 'save'; f.c.db.globalSettings.put = async () => { throw Error('quota'); };
  await f.c.leaveFontSettings(); assert.equal(f.c.screen, undefined);
  f.c.showChoiceModal = async () => 'discard'; await f.c.leaveFontSettings('wallpaper-screen');
  assert.equal(f.c.screen, 'wallpaper-screen'); assert.equal(f.c.state.globalSettings.globalFontSize, undefined);
});

test('字号按原比例派生、保留 CSS 优先级、代码字体和独立聊天字号；重置恢复原内联样式', () => {
  const f = fixture();
  const style = { getPropertyValue: key => ({ 'font-size': '14px', 'font-family': 'Arial' })[key] || '', getPropertyPriority: () => 'important' };
  const css = f.c.fontTypographyDeclarations(style);
  assert.match(css, /calc\(14px \* var\(--user-font-scale, 1\)\) !important/);
  assert.match(css, /font-family:var\(--user-font-family, Arial\) !important/);
  assert.equal(f.c.fontTypographyDeclarations({ ...style, getPropertyValue: key => key === 'font-family' ? 'monospace' : '14px' }), '');
  const node = f.element(); node.style.setProperty('font-size', '14px', 'important');
  f.c.updateFontInlineTypography(node); assert.match(node.style.getPropertyValue('font-size'), /--user-font-scale/);
  f.c.clearFontTypography(); assert.equal(node.style.getPropertyValue('font-size'), '14px'); assert.equal(node.style.getPropertyPriority('font-size'), 'important');
  const chat = source('modules/chat/interface-core.js');
  assert.match(chat, /chat\.settings\.fontSize\s*\? `\$\{fontSize\}px` : `calc/);
});

test('原有字体入口和全部控件保留；没有浏览器原生 alert；源码与加载资源关联', () => {
  const html = source('src/html/appearance-and-thoughts.html');
  for (const id of ['font-preview', 'font-preview-toggle', 'reset-font-size-btn', 'font-size-slider', 'font-preset-select', 'save-font-preset-btn', 'delete-font-preset-btn', 'font-url-input', 'font-local-upload-btn', 'font-local-clear-btn', 'font-local-file-input', 'font-scope-all', 'reset-font-scope-btn', 'reset-font-btn']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(html.includes('data-scope="other"'));
  assert.doesNotMatch(source('modules/data/custom-fonts.js') + source('modules/settings/font-presets.js'), /\balert\(/);
  assert.match(source('src/js-bundles/event-bindings-b/chat-settings.jsfrag'), /bindFontSettingsEvents\(\)/);
});

test('字体重新加载绕过 Service Worker 旧缓存，普通字体及图片缓存行为保留', async () => {
  const handlers = {}, cached = { name: 'old' }, fresh = { status: 200, clone: () => fresh };
  let requests = 0, writes = 0;
  const c = { console: { log() {}, warn() {} }, URL,
    self: { registration: { scope: 'https://app.example/' }, addEventListener: (event, fn) => { handlers[event] = fn; } },
    caches: { match: async () => cached, open: async () => ({ put: async () => { writes++; } }) },
    fetch: async () => { requests++; return fresh; } };
  vm.createContext(c); vm.runInContext(source('sw.js'), c);
  async function request(destination, cache, url = 'https://fonts.example/font.woff2') {
    let response;
    handlers.fetch({ request: { method: 'GET', url, mode: 'cors', destination, cache, headers: { has: () => false, get: () => null } }, respondWith: promise => { response = promise; } });
    return response;
  }
  assert.equal(await request('font', 'default'), cached); assert.equal(requests, 0);
  assert.equal(await request('', 'reload'), fresh); assert.equal(requests, 1); assert.equal(writes, 1);
  assert.equal(await request('image', 'default', 'https://images.example/pic.png'), cached); assert.equal(requests, 1);
});

test('旧外观导入按旧字段恢复来源，新外观保留显式默认选择和本地文件信息', () => {
  const s = source('modules/appearance-theme.js');
  const start = s.indexOf('          Object.assign(state.globalSettings, data);');
  const end = s.indexOf('          await db.globalSettings.put(state.globalSettings);', start);
  const block = s.slice(start, end);
  for (const [data, expected] of [
    [{ fontUrl: 'https://fonts.example/legacy', fontLocalData: '' }, 'url'],
    [{ fontUrl: '', fontLocalData: 'data:font/ttf;base64,AQ==' }, 'local'],
    [{ fontUrl: 'https://fonts.example/inactive', fontLocalData: '', fontSourceMode: 'default' }, 'default'],
    [{ fontLocalData: 'data:font/ttf;base64,AQ==', fontLocalName: 'saved.ttf', fontLocalSize: 42, fontSourceMode: 'local' }, 'local']
  ]) {
    const c = { data, state: { globalSettings: { fontSourceMode: 'default', fontLocalData: '', fontLocalName: 'old.ttf', unrelated: true } } };
    vm.createContext(c); vm.runInContext(block, c);
    assert.equal(c.state.globalSettings.fontSourceMode, expected);
    assert.equal(c.state.globalSettings.fontLocalName, data.fontLocalName || '');
    assert.equal(c.state.globalSettings.unrelated, true);
  }
});
