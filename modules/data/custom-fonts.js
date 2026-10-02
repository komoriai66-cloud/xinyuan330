// 自定义字体：保留旧字段和调用入口，编辑草稿与正式设置相互独立。
const FONT_SCOPE_SELECTORS = {
  homeScreen: '#home-screen',
  qq: '#chat-list-screen, #chat-interface-screen, #contact-picker-screen, #member-management-screen, #call-history-screen, #voice-call-screen, #outgoing-call-screen, #video-call-screen',
  cphone: '#character-phone-screen, #character-selection-screen',
  myphone: '#myphone-screen, #myphone-selection-screen',
  worldBook: '#world-book-screen, #world-book-editor-screen',
  douban: '#douban-screen, #douban-post-detail-screen',
  alipay: '#alipay-screen, #fund-screen',
  settings: '#font-settings-screen, #wallpaper-screen, #rendering-rules-screen, #preset-screen, #preset-editor-screen, #chat-settings-screen, #long-term-memory-screen, #api-settings-screen'
};
const FONT_SCOPE_LABELS = {
  homeScreen: '主屏幕', qq: 'QQ (聊天)', cphone: 'Cphone', myphone: 'Myphone',
  worldBook: '世界书', douban: '豆瓣', alipay: '支付宝', settings: '设置页面', other: '其他应用'
};
const FONT_DEFAULT_FAMILY = "'bulangni', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
let fontDraft = null;
let fontSavedDraftKey = '';
let fontPreviewGeneration = 0;
let fontFileGeneration = 0;
let fontPreviewTimer;
let fontBusy = false;
let fontReading = false;
let fontBound = false;
let fontActiveFamily = '';
let fontPreviewFamily = '';
let fontFaceSerial = 0;
let fontDraftGeneration = 0;
let fontLeavingAllowed = false;
let fontTypographyObserver;
const fontLoadCache = new Map();
const fontKnownFaces = new Set();
const fontTypographyStyles = new Map();
const fontInlineOriginals = new Map();

function normalizeFontSettings(settings = {}) {
  const scope = settings.fontScope || { all: true };
  const all = scope.all !== false;
  const fontScope = { all };
  Object.keys(FONT_SCOPE_LABELS).forEach(key => {
    // 旧的部分范围只启用明确选中的区域，不扩大原有应用范围。
    fontScope[key] = all || scope[key] === true;
  });
  const size = Number(settings.globalFontSize);
  return {
    fontUrl: String(settings.fontUrl || '').trim(),
    fontLocalData: String(settings.fontLocalData || ''),
    fontLocalName: String(settings.fontLocalName || ''),
    fontLocalSize: Number(settings.fontLocalSize) || 0,
    fontSourceMode: ['default', 'url', 'local'].includes(settings.fontSourceMode)
      ? settings.fontSourceMode : settings.fontLocalData ? 'local' : settings.fontUrl ? 'url' : 'default',
    globalFontSize: Number.isFinite(size) && size > 0 ? Math.max(10, Math.min(28, Math.round(size))) : 16,
    fontScope
  };
}

function getFontDraft() {
  if (!fontDraft) fontDraft = normalizeFontSettings(state.globalSettings);
  return fontDraft;
}

function fontSource(settings) {
  if (settings.fontSourceMode === 'local') return settings.fontLocalData;
  if (settings.fontSourceMode === 'url') return settings.fontUrl;
  return '';
}

function setFontStatus(message, kind = 'info') {
  const status = document.getElementById('font-load-status');
  if (!status) return;
  status.textContent = message;
  status.dataset.kind = kind;
}

function fontNotice(message, kind = 'info') {
  setFontStatus(message, kind);
  if (typeof showToast === 'function') showToast(message, kind === 'error' ? 'error' : kind === 'success' ? 'success' : 'info');
}

function clearFontPreview() {
  fontPreviewGeneration++;
  clearTimeout(fontPreviewTimer);
  fontPreviewFamily = '';
  document.getElementById('preview-font-style')?.remove();
  const preview = document.getElementById('font-preview');
  if (preview) {
    preview.style.fontFamily = FONT_DEFAULT_FAMILY;
    preview.style.removeProperty('--user-font-family');
    preview.style.setProperty('--user-font-scale', '1');
  }
  pruneFontLoads();
}

function pruneFontLoads() {
  for (const [source, entry] of fontLoadCache) {
    if (fontLoadCache.size <= 3) break;
    if (!entry.face || entry.family === fontActiveFamily || entry.family === fontPreviewFamily) continue;
    document.fonts?.delete(entry.face);
    fontLoadCache.delete(source);
  }
  for (const face of fontKnownFaces) {
    if (face.family === fontActiveFamily || face.family === fontPreviewFamily) continue;
    if (Array.from(fontLoadCache.values()).some(entry => entry.face === face)) continue;
    document.fonts?.delete(face);
    fontKnownFaces.delete(face);
  }
}

async function loadUserFont(settings, reload = false) {
  const source = fontSource(settings);
  if (!source) {
    if (settings.fontSourceMode !== 'default') throw new Error(settings.fontSourceMode === 'local' ? '请先选择本地字体文件。' : '请先填写字体文件链接。');
    return null;
  }
  if (typeof FontFace !== 'function' || !document.fonts) throw new Error('当前浏览器无法验证字体，请更新浏览器后重试。');
  if (settings.fontSourceMode === 'url') {
    let url;
    try { url = new URL(source); } catch (_) { throw new Error('字体链接无效，请填写完整的 http 或 https 链接。'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('网络字体只支持 http 或 https 链接。');
  }
  if (!reload && fontLoadCache.has(source)) return fontLoadCache.get(source).promise;
  const entry = { family: `ephone-user-font-${++fontFaceSerial}`, face: null, promise: null };
  const controller = new AbortController();
  let timer;
  const loading = (async () => {
    let response;
    try { response = await fetch(source, { signal: controller.signal, cache: reload ? 'reload' : 'default' }); }
    catch (error) {
      if (controller.signal.aborted) throw new Error('字体加载超时，请检查网络后重试。');
      throw new Error('字体下载失败，可能是网络或跨域限制；可下载文件后上传本地字体。');
    }
    if (!response.ok) throw new Error(`字体下载失败（HTTP ${response.status}），请检查链接。`);
    const type = response.headers.get('content-type') || '';
    if (/text\/html|application\/json/i.test(type)) throw new Error('链接返回的是网页或数据，请使用字体文件的直接链接。');
    const bytes = await response.arrayBuffer();
    if (!bytes.byteLength) throw new Error('字体文件为空，请重新选择。');
    let face;
    try { face = await new FontFace(entry.family, bytes).load(); }
    catch (_) { throw new Error('文件无法解析为字体，可能已损坏或格式不受当前浏览器支持。'); }
    return face;
  })();
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('字体加载超时，请检查网络后重试。')); }, 15000);
  });
  entry.promise = Promise.race([loading, timeout]).then(face => {
    if (fontLoadCache.get(source) !== entry) throw new Error('字体加载已取消，请重试。');
    entry.face = face;
    document.fonts.add(face);
    fontKnownFaces.add(face);
    pruneFontLoads();
    return entry;
  }).catch(error => {
    if (fontLoadCache.get(source) === entry) fontLoadCache.delete(source);
    throw error;
  }).finally(() => clearTimeout(timer));
  const old = fontLoadCache.get(source);
  if (old?.face && old.family !== fontActiveFamily && old.family !== fontPreviewFamily) document.fonts.delete(old.face);
  fontLoadCache.set(source, entry);
  return entry.promise;
}

async function updateFontPreview(reload = false) {
  const preview = document.getElementById('font-preview');
  if (!preview) return;
  const draft = normalizeFontSettings(getFontDraft());
  preview.style.fontSize = `${draft.globalFontSize}px`;
  preview.style.setProperty('--user-font-scale', '1');
  const generation = ++fontPreviewGeneration;
  if (!document.getElementById('font-preview-toggle')?.checked) return;
  preview.style.fontFamily = FONT_DEFAULT_FAMILY;
  preview.style.removeProperty('--user-font-family');
  fontPreviewFamily = '';
  setFontStatus(fontSource(draft) ? '正在加载字体…' : '默认字体预览；保存后应用。');
  try {
    const entry = await loadUserFont(draft, reload);
    if (generation !== fontPreviewGeneration) return;
    if (entry) {
      fontPreviewFamily = entry.family;
      const family = `'${entry.family}', ${FONT_DEFAULT_FAMILY}`;
      preview.style.fontFamily = family;
      preview.style.setProperty('--user-font-family', family);
    }
    setFontStatus(entry ? '字体已加载，可预览中文、英文和数字；保存后应用。' : '默认字体预览；保存后应用。', 'success');
  } catch (error) {
    if (generation === fontPreviewGeneration) setFontStatus(`${error.message} 预览暂用默认字体。`, 'error');
  }
}

function syncFontDraftUI() {
  const draft = getFontDraft();
  const set = (id, property, value) => { const node = document.getElementById(id); if (node) node[property] = value; };
  set('font-source-select', 'value', draft.fontSourceMode);
  set('font-url-input', 'value', draft.fontUrl);
  set('font-url-input', 'disabled', draft.fontSourceMode === 'local');
  set('font-url-input', 'placeholder', draft.fontSourceMode === 'local' ? '已选本地字体，可切换来源使用链接' : 'https://..../font.ttf');
  set('font-local-filename', 'textContent', draft.fontLocalName || (draft.fontLocalData ? '已加载本地字体' : '未选择本地字体'));
  const clear = document.getElementById('font-local-clear-btn');
  if (clear) clear.style.display = draft.fontLocalData ? 'inline-block' : 'none';
  const warning = document.getElementById('font-local-warning');
  if (warning) warning.style.display = draft.fontLocalSize > 5 * 1024 * 1024 ? 'block' : 'none';
  set('font-size-slider', 'value', draft.globalFontSize);
  set('font-size-value', 'textContent', String(draft.globalFontSize));
  set('font-scope-all', 'checked', draft.fontScope.all);
  const list = document.getElementById('font-scope-list');
  if (list) list.style.display = draft.fontScope.all ? 'none' : 'flex';
  document.querySelectorAll('#font-scope-list input[data-scope]').forEach(cb => { cb.checked = draft.fontScope[cb.dataset.scope]; });
  const preview = document.getElementById('font-preview');
  if (preview) preview.style.fontSize = `${draft.globalFontSize}px`;
}

function openFontSettings() {
  clearFontPreview();
  fontFileGeneration++;
  fontDraftGeneration++;
  fontReading = false;
  fontDraft = normalizeFontSettings(state.globalSettings);
  fontSavedDraftKey = JSON.stringify(fontDraft);
  syncFontDraftUI();
  const toggle = document.getElementById('font-preview-toggle');
  if (toggle) toggle.checked = false;
  const container = document.getElementById('font-preview-container');
  if (container) container.style.display = 'none';
  setFontStatus('修改后点击保存并应用；预览不影响已保存设置。');
  loadFontPresetsDropdown().catch(() => setFontStatus('字体预设读取失败，请重新打开页面。', 'error'));
}

// 只派生项目原生排版规则；原规则、用户 CSS 和独立聊天字号均保留。
function fontTypographyDeclarations(style) {
  const size = style.getPropertyValue('font-size');
  const family = style.getPropertyValue('font-family');
  const protectedFamily = /monospace|courier|menlo|consolas|sf mono|material|fontawesome|icon/i.test(family);
  let result = '';
  if (!protectedFamily && /^\d+(?:\.\d+)?px$/.test(size)) result += `font-size:calc(${size} * var(--user-font-scale, 1))${style.getPropertyPriority('font-size') ? ' !important' : ''};`;
  if (family && !protectedFamily && family !== 'inherit') result += `font-family:var(--user-font-family, ${family})${style.getPropertyPriority('font-family') ? ' !important' : ''};`;
  return result;
}

function fontTypographyRules(rules) {
  let css = '';
  for (const rule of rules || []) {
    if (rule.selectorText && rule.style) {
      // 图标/装饰与字体预览由原样式负责，不改变它们的尺寸。
      if (/::before|::after|#main-time|\.icon-bg|font-preview|\.slider-sym/.test(rule.selectorText)) continue;
      const declarations = fontTypographyDeclarations(rule.style);
      if (declarations) css += `${rule.selectorText}{${declarations}}\n`;
    } else if (rule.styleSheet) {
      try {
        const imported = fontTypographyRules(rule.styleSheet.cssRules);
        css += rule.media?.mediaText ? `@media ${rule.media.mediaText}{${imported}}` : imported;
      } catch (_) { /* 保留无法读取的跨域导入样式。 */ }
    } else if (rule.cssRules && /^@(media|supports|layer|container)\b/.test(rule.cssText)) {
      css += `${rule.cssText.slice(0, rule.cssText.indexOf('{'))}{${fontTypographyRules(rule.cssRules)}}\n`;
    }
  }
  return css;
}

function updateFontInlineTypography(root) {
  if (!root?.querySelectorAll) return;
  const nodes = [root, ...root.querySelectorAll('[style]')];
  for (const node of nodes) {
    if (!node.style || node.closest?.('#font-preview, pre, code, svg, .icon-bg, #chat-messages .message-bubble, #settings-preview-area')) continue;
    for (const property of ['font-size', 'font-family']) {
      const value = node.style.getPropertyValue(property);
      if (!value || value.includes('--user-font-')) continue;
      if (property === 'font-size' && !/^\d+(?:\.\d+)?px$/.test(value)) continue;
      if (property === 'font-family' && /inherit|monospace|courier|menlo|consolas|material|fontawesome|icon/i.test(value)) continue;
      if (!fontInlineOriginals.has(node)) fontInlineOriginals.set(node, {});
      const priority = node.style.getPropertyPriority(property);
      const replacement = property === 'font-size' ? `calc(${value} * var(--user-font-scale, 1))` : `var(--user-font-family, ${value})`;
      node.style.setProperty(property, replacement, priority);
      fontInlineOriginals.get(node)[property] = { value, priority, replacement: node.style.getPropertyValue(property) };
    }
  }
  for (const node of fontInlineOriginals.keys()) if (!node.isConnected) fontInlineOriginals.delete(node);
}

function installFontTypography() {
  for (const sheet of Array.from(document.styleSheets || [])) {
    const owner = sheet.ownerNode;
    if (!owner || owner.closest?.('#chat-messages, #settings-preview-area') || fontTypographyStyles.has(owner) || (owner.tagName !== 'LINK' && (owner.tagName !== 'STYLE' || owner.id))) continue;
    try {
      const derived = document.createElement('style');
      derived.dataset.fontTypography = 'true';
      derived.id = `font-typography-${fontTypographyStyles.size}`;
      derived.textContent = fontTypographyRules(sheet.cssRules);
      owner.after(derived);
      fontTypographyStyles.set(owner, derived);
    } catch (_) { /* 跨域样式表无法读取；保留其原排版。 */ }
  }
  updateFontInlineTypography(document.body || document.getElementById('phone-screen'));
  if (!fontTypographyObserver && typeof MutationObserver === 'function') {
    fontTypographyObserver = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'childList') record.addedNodes.forEach(node => updateFontInlineTypography(node));
        else if (record.attributeName === 'style') updateFontInlineTypography(record.target);
      }
    });
    const root = document.body || document.getElementById('phone-screen');
    if (root) fontTypographyObserver.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
  }
}

function clearFontTypography() {
  fontTypographyObserver?.disconnect();
  fontTypographyObserver = null;
  for (const style of fontTypographyStyles.values()) style.remove();
  fontTypographyStyles.clear();
  for (const [node, properties] of fontInlineOriginals) {
    for (const [property, saved] of Object.entries(properties)) {
      if (node.style.getPropertyValue(property) === saved.replacement) node.style.setProperty(property, saved.value, saved.priority);
    }
  }
  fontInlineOriginals.clear();
}

function applyFontSettings(settings, entry = null) {
  const normalized = normalizeFontSettings(settings);
  const scope = normalized.fontScope;
  const family = entry ? `'${entry.family}', ${FONT_DEFAULT_FAMILY}` : null;
  fontActiveFamily = entry?.family || '';
  const variables = `--user-font-scale:${normalized.globalFontSize / 16};${family ? `--user-font-family:${family};` : ''}`;
  const fallback = '--user-font-scale:1;--user-font-family:initial;';
  let css = '';
  if (scope.all) css = `body{${variables}${normalized.globalFontSize !== 16 ? `font-size:${normalized.globalFontSize}px;` : ''}${family ? `font-family:${family};` : ''}}`;
  else {
    if (scope.other) css += `body{${variables}${normalized.globalFontSize !== 16 ? `font-size:${normalized.globalFontSize}px;` : ''}${family ? `font-family:${family};` : ''}}`;
    for (const [key, selector] of Object.entries(FONT_SCOPE_SELECTORS)) {
      css += `${selector}{${scope[key] ? variables : fallback}font-size:${scope[key] ? normalized.globalFontSize : 16}px;${family ? `font-family:${scope[key] ? family : FONT_DEFAULT_FAMILY};` : ''}}`;
    }
    // 弹窗与所在页面使用相同的设置，嵌套子页面也继承所属应用。
    for (const [key, selectors] of Object.entries(FONT_SCOPE_SELECTORS)) {
      const active = selectors.split(',').map(selector => `${selector.trim()}.active`).join(',');
      css += `body:has(${active}) .modal,body:has(${active}) #custom-modal-overlay{${scope[key] ? variables : fallback}font-size:${scope[key] ? normalized.globalFontSize : 16}px;${family ? `font-family:${scope[key] ? family : FONT_DEFAULT_FAMILY};` : ''}}`;
    }
  }
  if (family) css += ':where(button,input,select,textarea){font-family:var(--user-font-family,inherit);}';
  dynamicFontStyle.textContent = css;
  if (family || normalized.globalFontSize !== 16) installFontTypography();
  else clearFontTypography();
  pruneFontLoads();
}

let fontApplyGeneration = 0;
async function applyCustomFont(fontUrl, isPreviewOnly = false) {
  if (isPreviewOnly) {
    const draft = getFontDraft();
    draft.fontUrl = String(fontUrl || '').trim();
    if (draft.fontSourceMode !== 'local') draft.fontSourceMode = draft.fontUrl ? 'url' : 'default';
    return updateFontPreview();
  }
  const generation = ++fontApplyGeneration;
  const settings = normalizeFontSettings({ ...state.globalSettings, fontUrl: fontUrl || '' });
  try {
    const entry = await loadUserFont(settings);
    if (generation !== fontApplyGeneration) return;
    applyFontSettings(settings, entry);
  } catch (error) {
    if (generation !== fontApplyGeneration) return;
    applyFontSettings(settings);
    setFontStatus(`${error.message} 已保留设置，暂用默认字体。`, 'error');
    if (typeof showToast === 'function') showToast('已保存的字体加载失败，可在字体设置中重试。', 'error');
  }
}

async function commitFontSettings(settings, reload = false) {
  const snapshot = normalizeFontSettings(settings);
  const entry = await loadUserFont(snapshot, reload);
  // 加载期间其他设置仍可操作；写入时合并最新状态，避免覆盖无关配置。
  const next = { ...state.globalSettings, ...snapshot };
  await db.globalSettings.put(next);
  fontApplyGeneration++;
  Object.assign(state.globalSettings, snapshot);
  applyFontSettings(snapshot, entry);
  return snapshot;
}

async function saveFontSettings() {
  if (fontBusy || fontReading) { setFontStatus('请等待当前字体操作完成。'); return false; }
  fontBusy = true;
  const save = document.getElementById('save-font-btn');
  if (save) save.disabled = true;
  const snapshot = normalizeFontSettings(getFontDraft());
  setFontStatus('正在验证并保存字体…');
  try {
    await commitFontSettings(snapshot);
    fontSavedDraftKey = JSON.stringify(snapshot);
    fontNotice(snapshot.fontScope.all || Object.keys(FONT_SCOPE_LABELS).some(key => snapshot.fontScope[key])
      ? '字体设置已保存并应用。' : '字体设置已保存；当前未选择应用区域。', 'success');
    return true;
  } catch (error) {
    fontNotice(`${error.message || '设置保存失败，请重试。'} 原设置已保留。`, 'error');
    return false;
  } finally {
    fontBusy = false;
    if (save) save.disabled = false;
  }
}

async function leaveFontSettings(screenId = 'home-screen') {
  if (fontBusy || fontReading) { setFontStatus('请等待当前字体操作完成。'); return; }
  if (JSON.stringify(normalizeFontSettings(getFontDraft())) !== fontSavedDraftKey) {
    const choice = await showChoiceModal('未保存的字体设置', [
      { text: '保存并返回', value: 'save' }, { text: '放弃修改', value: 'discard' }, { text: '继续编辑', value: 'stay' }
    ]);
    if (!choice || choice === 'stay' || (choice === 'save' && !await saveFontSettings())) return;
  }
  clearFontPreview();
  fontFileGeneration++;
  fontDraft = null;
  fontLeavingAllowed = true;
  try { showScreen(screenId); } finally { fontLeavingAllowed = false; }
}

async function resetFontByScope() {
  if (fontBusy || fontReading) { setFontStatus('请等待当前字体操作完成。'); return; }
  const current = normalizeFontSettings(state.globalSettings);
  const active = Object.keys(FONT_SCOPE_LABELS).filter(key => current.fontScope[key]);
  if ((!fontSource(current) && current.globalFontSize === 16) || !active.length) { fontNotice('当前区域已使用默认字体和字号。'); return; }
  // 复用现有自定义弹窗，不重建或替换共享弹窗按钮。
  const pending = showCustomConfirm('选择恢复默认的区域', '<span>选中区域恢复默认字体与字号，其他区域保持不变。</span>', { confirmText: '恢复选中区域', confirmButtonClass: 'btn-danger' });
  const body = document.getElementById('custom-modal-body');
  const choices = document.createElement('div');
  choices.className = 'font-reset-scope-choices';
  active.forEach(key => {
    const label = document.createElement('label');
    label.className = 'font-reset-scope-choice';
    const input = document.createElement('input');
    input.type = 'checkbox'; input.value = key;
    const pill = document.createElement('span'); pill.className = 'font-reset-scope-check'; pill.textContent = '✓';
    const text = document.createElement('span'); text.textContent = FONT_SCOPE_LABELS[key];
    label.append(input, pill, text); choices.appendChild(label);
  });
  body?.appendChild(choices);
  // 在用户关闭弹窗前读取选项，防止其他弹窗重用正文。
  const selected = new Set();
  choices.addEventListener('change', event => { if (event.target.checked) selected.add(event.target.value); else selected.delete(event.target.value); });
  const confirm = document.getElementById('custom-modal-confirm');
  if (confirm) {
    confirm.disabled = true;
    choices.addEventListener('change', () => { confirm.disabled = selected.size === 0; });
  }
  const confirmed = await pending;
  if (confirm) confirm.disabled = false;
  if (!confirmed) return;
  if (!selected.size) { fontNotice('请至少选择一个区域。', 'error'); return; }
  const next = normalizeFontSettings(current);
  next.fontScope.all = false;
  selected.forEach(key => { next.fontScope[key] = false; });
  await resetFontSettings(next, '所选区域已恢复默认字体与字号。');
}

async function resetFontSettings(settings, message) {
  if (fontBusy || fontReading) return false;
  fontBusy = true;
  try {
    // 重置范围不要求重新下载仍被其他区域使用的字体。
    const next = normalizeFontSettings(settings);
    await db.globalSettings.put({ ...state.globalSettings, ...next });
    fontApplyGeneration++;
    Object.assign(state.globalSettings, next);
    const entry = fontLoadCache.get(fontSource(next));
    applyFontSettings(next, entry?.face ? entry : null);
    clearFontPreview();
    fontFileGeneration++;
    fontDraftGeneration++;
    fontDraft = next;
    fontSavedDraftKey = JSON.stringify(next);
    syncFontDraftUI();
    const toggle = document.getElementById('font-preview-toggle');
    if (toggle?.checked) void updateFontPreview();
    fontNotice(message, 'success');
    return true;
  } catch (_) {
    fontNotice('设置保存失败，原设置已保留，请重试。', 'error');
    return false;
  } finally { fontBusy = false; }
}

async function resetToDefaultFont() {
  if (await resetFontSettings(normalizeFontSettings(), '已恢复默认字体和字号。')) {
    for (const face of fontKnownFaces) document.fonts?.delete(face);
    fontKnownFaces.clear();
    fontLoadCache.clear();
  }
}

function bindFontSettingsEvents() {
  if (fontBound) return;
  const required = ['font-url-input', 'font-preview-toggle', 'font-size-slider', 'reset-font-size-btn', 'save-font-btn'];
  if (required.some(id => !document.getElementById(id))) { console.warn('[FontSettings] 字体控件未就绪'); return; }
  const bind = (id, event, handler) => document.getElementById(id)?.addEventListener(event, handler);
  const changed = () => { fontDraftGeneration++; fontPreviewGeneration++; clearTimeout(fontPreviewTimer); syncFontDraftUI(); void updateFontPreview(); };
  bind('font-preview-toggle', 'change', event => {
    const visible = event.target.checked;
    document.getElementById('font-preview-container').style.display = visible ? 'block' : 'none';
    if (visible) void updateFontPreview(); else { fontPreviewGeneration++; clearTimeout(fontPreviewTimer); }
  });
  bind('font-source-select', 'change', event => { fontFileGeneration++; fontReading = false; getFontDraft().fontSourceMode = event.target.value; changed(); });
  bind('font-url-input', 'input', event => {
    const draft = getFontDraft(); draft.fontUrl = event.target.value.trim(); draft.fontSourceMode = draft.fontUrl ? 'url' : 'default';
    fontDraftGeneration++;
    fontPreviewGeneration++; clearTimeout(fontPreviewTimer);
    const select = document.getElementById('font-source-select'); if (select) select.value = draft.fontSourceMode;
    setFontStatus('链接已修改，保存后应用。');
    fontPreviewTimer = setTimeout(() => void updateFontPreview(), 450);
  });
  bind('font-size-slider', 'input', event => {
    const draft = getFontDraft(); draft.globalFontSize = normalizeFontSettings({ globalFontSize: event.target.value }).globalFontSize;
    fontDraftGeneration++;
    document.getElementById('font-size-value').textContent = String(draft.globalFontSize);
    document.getElementById('font-preview').style.fontSize = `${draft.globalFontSize}px`;
  });
  bind('reset-font-size-btn', 'click', () => {
    fontDraftGeneration++; getFontDraft().globalFontSize = 16; syncFontDraftUI(); setFontStatus('字号已重置为 16；保存后应用。');
  });
  bind('font-scope-all', 'change', event => {
    const scope = getFontDraft().fontScope; scope.all = event.target.checked;
    fontDraftGeneration++;
    if (scope.all) Object.keys(FONT_SCOPE_LABELS).forEach(key => { scope[key] = true; });
    syncFontDraftUI();
  });
  document.querySelectorAll('#font-scope-list input[data-scope]').forEach(cb => cb.addEventListener('change', () => { fontDraftGeneration++; getFontDraft().fontScope[cb.dataset.scope] = cb.checked; }));
  bind('font-local-upload-btn', 'click', () => { if (!fontBusy) document.getElementById('font-local-file-input').click(); });
  bind('font-local-file-input', 'change', async event => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file || fontBusy) return;
    if (file.size > 10 * 1024 * 1024) { fontNotice('字体文件超过 10MB，请选择更小的字体。', 'error'); return; }
    const generation = ++fontFileGeneration;
    fontReading = true; setFontStatus('正在读取并检查字体文件…');
    try {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('文件读取失败，请重新选择。'));
        reader.onabort = () => reject(new Error('文件读取已取消。')); reader.readAsDataURL(file);
      });
      if (generation !== fontFileGeneration) return;
      const candidate = normalizeFontSettings({ ...getFontDraft(), fontSourceMode: 'local', fontLocalData: data, fontLocalName: file.name, fontLocalSize: file.size });
      await loadUserFont(candidate);
      if (generation !== fontFileGeneration) return;
      Object.assign(getFontDraft(), { fontSourceMode: 'local', fontLocalData: data, fontLocalName: file.name, fontLocalSize: file.size });
      changed(); setFontStatus('本地字体已读取；保存后应用。', 'success');
    } catch (error) { if (generation === fontFileGeneration) fontNotice(error.message, 'error'); }
    finally { if (generation === fontFileGeneration) fontReading = false; }
  });
  bind('font-local-clear-btn', 'click', () => {
    fontFileGeneration++; fontReading = false;
    const draft = getFontDraft(); draft.fontLocalData = ''; draft.fontLocalName = ''; draft.fontLocalSize = 0;
    if (draft.fontSourceMode === 'local') draft.fontSourceMode = draft.fontUrl ? 'url' : 'default';
    changed(); setFontStatus('本地字体已从编辑内容清除；保存后应用。');
  });
  bind('font-reload-btn', 'click', async () => {
    if (fontBusy || fontReading) return;
    const toggle = document.getElementById('font-preview-toggle'); toggle.checked = true;
    document.getElementById('font-preview-container').style.display = 'block';
    await updateFontPreview(true);
  });
  bind('save-font-btn', 'click', () => void saveFontSettings());
  bind('reset-font-btn', 'click', () => void resetToDefaultFont());
  bind('reset-font-scope-btn', 'click', () => void resetFontByScope());
  bind('font-back-btn', 'click', () => void leaveFontSettings());
  fontBound = true;
}
