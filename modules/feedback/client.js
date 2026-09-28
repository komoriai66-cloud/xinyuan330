(function () {
  'use strict';

  const STORAGE_KEY = 'ephone_feedback_threads_v1';
  const DRAFT_KEY = 'ephone_feedback_draft_v1';
  const MAX_IMAGE_BYTES = 1024 * 1024;
  const config = window.EPHONE_FEEDBACK_CONFIG || {};
  const apiUrl = String(config.apiUrl || '').replace(/\/+$/, '');
  const siteKey = String(config.turnstileSiteKey || '');
  const state = { mode: 'private', page: 'list', thread: null, publicItems: [], publicNextCursor: null, owned: [], busy: false };
  let root;
  let turnstilePromise;
  let challengeWidgetId;
  let refreshTimer;
  let viewSequence = 0;

  function randomUUID() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function readLocal(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (_) { return fallback; }
  }
  function ownedThreads() {
    return readLocal(STORAGE_KEY, []).filter(item =>
      item && /^[0-9a-f-]{36}$/i.test(item.id) && typeof item.token === 'string' &&
      /^[0-9a-f]{64}$/i.test(item.token) && ['private', 'public'].includes(item.kind));
  }
  function saveOwned(items) { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); }
  function storeThread(thread, token) {
    const items = ownedThreads().filter(item => item.id !== thread.id);
    items.unshift({ id: thread.id, token, kind: thread.kind, title: thread.title, seenAt: thread.last_admin_at || 0 });
    saveOwned(items);
    state.owned = items;
  }
  function getCredential(id) { return ownedThreads().find(item => item.id === id); }
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }
  function dateText(value) { return new Date(value).toLocaleString('zh-CN'); }
  function status(message, error) {
    const el = root.querySelector('.feedback-status');
    el.textContent = message || '';
    el.classList.toggle('error', !!error);
  }
  async function request(path, options = {}, token) {
    if (!apiUrl) throw new Error('反馈服务尚未配置，请联系作者。');
    const headers = new Headers(options.headers || {});
    headers.set('X-EPhone-Feedback', '1');
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(`${apiUrl}${path}`, { ...options, headers, cache: 'no-store' });
    let data;
    try { data = await response.json(); } catch (_) { data = {}; }
    if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
    return data;
  }
  async function loadTurnstile() {
    if (!siteKey) throw new Error('人机验证尚未配置，请联系作者。');
    if (window.turnstile) return window.turnstile;
    if (!turnstilePromise) {
      turnstilePromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        script.onload = () => resolve(window.turnstile);
        script.onerror = () => reject(new Error('人机验证加载失败，请检查网络。'));
        document.head.appendChild(script);
      });
    }
    return turnstilePromise;
  }
  async function renderChallenge() {
    const host = root.querySelector('.feedback-challenge');
    if (!host) return;
    try {
      const turnstile = await loadTurnstile();
      if (!host.isConnected) return;
      challengeWidgetId = turnstile.render(host, {
        sitekey: siteKey,
        callback: token => { host.dataset.token = token; },
        'expired-callback': () => { host.dataset.token = ''; },
        'error-callback': () => { host.dataset.token = ''; status('验证失败，请刷新后重试。', true); }
      });
    } catch (error) { status(error.message, true); }
  }
  function clearChallenge() {
    if (challengeWidgetId !== undefined && window.turnstile) {
      try { window.turnstile.remove(challengeWidgetId); } catch (_) { /* 页面已关闭 */ }
    }
    challengeWidgetId = undefined;
  }
  function formDataFrom(form) {
    const data = new FormData(form);
    const image = data.get('image');
    if (image && image.size > MAX_IMAGE_BYTES) throw new Error('截图不能超过 1 MB。');
    if (!image || !image.size) data.delete('image');
    const challenge = form.querySelector('.feedback-challenge');
    if (!challenge?.dataset.token) throw new Error('请先完成人机验证。');
    data.set('turnstileToken', challenge.dataset.token);
    return data;
  }
  function clearRefresh() { if (refreshTimer) clearInterval(refreshTimer); refreshTimer = null; }
  function shell() {
    if (root) return;
    root = document.createElement('section');
    root.id = 'ephone-feedback';
    root.className = 'feedback-overlay';
    root.setAttribute('aria-label', '许愿与反馈');
    root.innerHTML = `<div class="feedback-panel">
      <header class="feedback-header"><button type="button" data-action="back" aria-label="返回">‹</button><strong class="feedback-heading"></strong><button type="button" data-action="close" aria-label="关闭">×</button></header>
      <div class="feedback-status" role="status"></div><main class="feedback-main"></main></div>`;
    document.body.appendChild(root);
    root.addEventListener('click', handleClick);
    root.addEventListener('submit', handleSubmit);
    root.addEventListener('input', event => {
      if (!event.target.closest('.feedback-new-form')) return;
      const form = event.target.form;
      if (!form) return;
      const draft = Object.fromEntries(new FormData(form).entries());
      delete draft.image;
      delete draft.turnstileToken;
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ mode: state.mode, ...draft }));
    });
    document.addEventListener('visibilitychange', () => {
      if (!root.classList.contains('open')) return;
      if (document.hidden) clearRefresh();
      else { refresh(); startRefresh(); }
    });
  }
  function heading() {
    root.querySelector('.feedback-heading').textContent =
      state.page === 'thread' ? (state.thread?.title || '对话') :
      state.mode === 'private' ? '匿名许愿 / 反馈' : '公开反馈';
  }
  function renderList() {
    viewSequence++;
    clearChallenge();
    state.page = 'list'; state.thread = null; heading();
    const owned = state.owned.filter(item => item.kind === state.mode);
    const lead = state.mode === 'private'
      ? '只有你和作者能看到对话。作者回复后，回到这里即可查看。'
      : '公开内容经作者审核后，其他用户可以看到正文、截图及回复。';
    root.querySelector('.feedback-main').innerHTML = `
      <div class="feedback-welcome"><span class="feedback-avatar" aria-hidden="true">E</span><p class="feedback-note">${lead}<br>对话只认当前浏览器。清除网站数据或切换浏览器后无法找回。</p></div>
      <button type="button" class="feedback-primary" data-action="new">＋ ${state.mode === 'private' ? '发起匿名对话' : '提交公开反馈'}</button>
      <h3>我提交的</h3><div class="feedback-owned">${owned.length ? owned.map(item => `
        <button type="button" class="feedback-list-item" data-action="own" data-id="${item.id}"><b>${escapeHtml(item.title)}</b><span class="feedback-list-meta">${item.id.slice(0, 8)}</span></button>`).join('') : '<p class="feedback-empty">还没有提交内容</p>'}</div>
      ${state.mode === 'public' ? '<h3>公开反馈</h3><div class="feedback-public-list"><p class="feedback-empty">正在加载…</p></div><button type="button" data-action="more" class="feedback-secondary">加载更多</button>' : ''}`;
    refreshOwned();
    if (state.mode === 'public') loadPublic(true);
  }
  async function refreshOwned() {
    if (!apiUrl || !state.owned.length) return;
    try {
      for (let start = 0; start < state.owned.length; start += 30) {
        const data = await request('/inbox', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threads: state.owned.slice(start, start + 30).map(({ id, token }) => ({ id, token })) })
        });
        for (const thread of data.threads) {
          const local = state.owned.find(item => item.id === thread.id);
          if (!local) continue;
          const button = root.querySelector(`[data-action="own"][data-id="${thread.id}"] .feedback-list-meta`);
          if (button) button.textContent = `${thread.last_admin_at > (local.seenAt || 0) ? '● 新回复 · ' : ''}${thread.status === 'pending' ? '等待审核' : thread.status === 'visible' ? '已公开' : thread.status === 'closed' ? '已关闭' : ''}`;
        }
      }
    } catch (error) { status(error.message, true); }
  }
  async function loadPublic(reset) {
    try {
      const cursor = reset ? '' : state.publicNextCursor || '';
      const data = await request(`/public/threads${cursor ? `?before=${encodeURIComponent(cursor)}` : ''}`);
      state.publicItems = reset ? data.threads : [...state.publicItems, ...data.threads];
      state.publicNextCursor = data.nextCursor;
      const host = root.querySelector('.feedback-public-list');
      if (!host) return;
      host.innerHTML = state.publicItems.length ? state.publicItems.map(item => `
        <button type="button" class="feedback-list-item" data-action="public" data-id="${item.id}">
          <b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.nickname || '匿名用户')} · ${dateText(item.created_at)}</span></button>`).join('') : '<p class="feedback-empty">暂无公开反馈</p>';
      root.querySelector('[data-action="more"]').hidden = !data.nextCursor;
    } catch (error) { status(error.message, true); }
  }
  function renderNew() {
    viewSequence++;
    clearChallenge();
    state.page = 'new'; heading();
    const draft = readLocal(DRAFT_KEY, {});
    root.querySelector('.feedback-main').innerHTML = `<form class="feedback-new-form">
      <div class="feedback-welcome"><span class="feedback-avatar" aria-hidden="true">E</span><p class="feedback-note">${state.mode === 'private' ? '把想法写给我吧，内容只有你和我能看见。' : '把想法写在这里。审核公开后，大家可以看到内容和回复。'}已发送内容保存在服务器，草稿只留在本设备。</p></div>
      <label>分类<select name="category"><option value="wish">许愿</option><option value="feedback">反馈</option><option value="bug">报错</option><option value="other">其他</option></select></label>
      ${state.mode === 'public' ? '<label>公开昵称（可不填）<input name="nickname" maxlength="24" placeholder="匿名用户"></label>' : ''}
      <label>写一条消息<textarea name="body" maxlength="5000" rows="7" required placeholder="写下你的想法…"></textarea></label>
      <label>截图（可选，1 MB 以内）<input name="image" type="file" accept="image/png,image/jpeg,image/webp"></label>
      <div class="feedback-challenge"></div>
      <button class="feedback-primary" type="submit">${state.mode === 'private' ? '发送给作者' : '提交审核'}</button></form>`;
    const form = root.querySelector('form');
    if (draft.mode === state.mode) ['category', 'nickname', 'body'].forEach(key => {
      if (form.elements[key] && typeof draft[key] === 'string') form.elements[key].value = draft[key];
    });
    renderChallenge();
  }
  async function openThread(id, publicView) {
    const currentView = ++viewSequence;
    try {
      status('正在加载…');
      const credential = getCredential(id);
      const data = await request(`/threads/${id}`, {}, publicView ? null : credential?.token);
      if (state.page === 'closed' || currentView !== viewSequence) return;
      const scrollTop = root.querySelector('.feedback-main').scrollTop;
      clearChallenge();
      state.thread = data.thread;
      state.page = 'thread'; heading();
      const canReply = !!credential && data.thread.status !== 'closed' && data.thread.status !== 'hidden';
      root.querySelector('.feedback-main').innerHTML = `
        <div class="feedback-welcome"><span class="feedback-avatar" aria-hidden="true">E</span><p class="feedback-note">${data.thread.kind === 'public' ? `公开反馈 · ${escapeHtml(data.thread.status === 'pending' ? '等待审核' : data.thread.status === 'visible' ? '已公开' : '已隐藏')}` : '匿名对话 · 仅你和作者可见'}<br>${dateText(data.thread.created_at)}</p></div>
        <div class="feedback-messages">${data.messages.map(message => `
          <article class="feedback-message ${message.sender === 'admin' ? 'author' : 'visitor'}"><span>${message.sender === 'admin' ? '作者' : escapeHtml(data.thread.nickname || '我')} · ${dateText(message.created_at)}</span>
            <p>${escapeHtml(message.body).replace(/\n/g, '<br>')}</p>
            ${message.attachment_key ? `<button type="button" data-action="image" data-key="${message.attachment_key}" data-id="${id}">查看截图</button>` : ''}</article>`).join('')}</div>
        ${canReply ? `<form class="feedback-reply-form"><label>继续回复<textarea name="body" maxlength="5000" rows="3" required placeholder="继续说…"></textarea></label>
          <label>截图（可选，1 MB 以内）<input name="image" type="file" accept="image/png,image/jpeg,image/webp"></label>
          <div class="feedback-challenge"></div><button type="submit" class="feedback-primary">发送</button></form>
          <button type="button" class="feedback-danger" data-action="delete" data-id="${id}">删除这段对话及已提交内容</button>` : ''}`;
      root.querySelector('.feedback-main').scrollTop = scrollTop;
      if (credential) {
        const items = ownedThreads();
        const item = items.find(row => row.id === id);
        if (item) { item.seenAt = Math.max(item.seenAt || 0, data.thread.last_admin_at || 0); saveOwned(items); state.owned = items; }
      }
      status('');
      if (canReply) renderChallenge();
    } catch (error) { status(error.message, true); }
  }
  async function viewImage(id, key) {
    try {
      const credential = getCredential(id);
      const response = await fetch(`${apiUrl}/attachments/${key}`, {
        headers: { 'X-EPhone-Feedback': '1', ...(credential ? { Authorization: `Bearer ${credential.token}` } : {}) }, cache: 'no-store'
      });
      if (!response.ok) throw new Error('截图读取失败。');
      const url = URL.createObjectURL(await response.blob());
      const image = new Image();
      image.src = url; image.alt = '反馈截图'; image.className = 'feedback-image';
      image.onload = () => URL.revokeObjectURL(url);
      root.querySelector(`[data-key="${key}"]`)?.replaceWith(image);
    } catch (error) { status(error.message, true); }
  }
  async function handleClick(event) {
    const button = event.target.closest('[data-action]');
    if (!button || !root.contains(button)) return;
    const { action, id, key } = button.dataset;
    if (action === 'close') return close();
    if (action === 'back') { status(''); if (state.page === 'list') close(); else renderList(); return; }
    if (action === 'new') return renderNew();
    if (action === 'own') return openThread(id, false);
    if (action === 'public') return openThread(id, true);
    if (action === 'more') return loadPublic(false);
    if (action === 'image') return viewImage(id, key);
    if (action === 'delete') {
      if (!window.confirm('确定删除服务器上的这段对话及消息吗？此操作无法撤销。')) return;
      try {
        await request(`/threads/${id}`, { method: 'DELETE' }, getCredential(id)?.token);
        const items = ownedThreads().filter(item => item.id !== id);
        saveOwned(items); state.owned = items; renderList(); status('已删除。');
      } catch (error) { status(error.message, true); }
    }
  }
  async function handleSubmit(event) {
    const form = event.target;
    if (!form.matches('.feedback-new-form, .feedback-reply-form')) return;
    event.preventDefault();
    if (state.busy) return;
    try {
      const data = formDataFrom(form);
      state.busy = true;
      form.querySelector('[type="submit"]').disabled = true;
      status('正在发送…');
      if (form.classList.contains('feedback-new-form')) {
        const summary = String(data.get('body') || '').trim().replace(/\s+/g, ' ');
        data.set('title', summary.length > 32 ? `${summary.slice(0, 32)}…` : summary);
        const oldDraft = readLocal(DRAFT_KEY, {});
        const pending = oldDraft.mode === state.mode && oldDraft.pending;
        const id = pending?.id || randomUUID();
        const token = pending?.token || [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
        localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...oldDraft, mode: state.mode, pending: { id, token } }));
        data.set('id', id); data.set('token', token); data.set('kind', state.mode);
        const result = await request('/threads', { method: 'POST', body: data });
        storeThread(result.thread, token);
        localStorage.removeItem(DRAFT_KEY);
        await openThread(id, false);
      } else {
        const id = state.thread.id;
        form.dataset.messageId ||= randomUUID();
        data.set('messageId', form.dataset.messageId);
        await request(`/threads/${id}/messages`, { method: 'POST', body: data }, getCredential(id)?.token);
        await openThread(id, false);
      }
      status('已发送。');
    } catch (error) { status(error.message, true); }
    finally {
      state.busy = false;
      if (form.isConnected) {
        form.querySelector('[type="submit"]').disabled = false;
        const challenge = form.querySelector('.feedback-challenge');
        if (challenge) challenge.dataset.token = '';
        if (challengeWidgetId !== undefined && window.turnstile) window.turnstile.reset(challengeWidgetId);
      }
    }
  }
  async function refresh() {
    if (state.busy || document.hidden) return;
    if (state.page === 'list') {
      await refreshOwned();
      if (state.mode === 'public') await loadPublic(true);
      return;
    }
    if (state.page === 'thread' && state.thread) {
      if (root.querySelector('.feedback-reply-form textarea')?.value.trim()) return;
      const id = state.thread.id;
      await openThread(id, !getCredential(id));
    }
  }
  function startRefresh() { clearRefresh(); refreshTimer = setInterval(refresh, 60000); }
  function open(mode) {
    shell();
    state.mode = mode === 'public' ? 'public' : 'private';
    state.owned = ownedThreads();
    state.publicItems = []; state.publicNextCursor = null;
    root.classList.add('open');
    document.body.classList.add('feedback-open');
    status(apiUrl && siteKey ? '' : '反馈服务尚未配置，作者部署后即可使用。', true);
    renderList(); startRefresh();
  }
  function close() {
    viewSequence++;
    clearRefresh(); clearChallenge(); state.page = 'closed'; state.thread = null;
    root.classList.remove('open'); document.body.classList.remove('feedback-open');
  }
  window.EPhoneFeedback = { open, close };
})();
