(function () {
  'use strict';

  const STORAGE_KEY = 'ephone_feedback_threads_v1';
  const DRAFT_KEY = 'ephone_feedback_draft_v1';
  const NOTICE_SUPPRESS_KEY = 'ephone_feedback_notice_ver';
  const NOTICE_VERSION = 'v1';
  const MAX_IMAGE_BYTES = 1024 * 1024;
  const config = window.EPHONE_FEEDBACK_CONFIG || {};
  const apiUrl = String(config.apiUrl || '').replace(/\/+$/, '');
  const siteKey = String(config.turnstileSiteKey || '');
  const state = { mode: 'private', page: 'list', thread: null, publicItems: [], publicNextCursor: null, owned: [], busy: false };
  let root;
  let turnstilePromise;
  let challengeWidgetId;
  let refreshTimer;
  let noticeCountdownTimer;
  let viewSequence = 0;
  let lastIndicatorCheck = 0;
  let confirmResolve;

  // 精致的守护甜心与古典信箱矢量线框图标 (无渐变、纯黑白、无默认 Emoji)
  const ICONS = {
    back: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" stroke-width="0.8" stroke-dasharray="2 2"/><path d="M13.5 8.5L10 12l3.5 3.5"/><path d="M10 12h5" stroke-dasharray="1 1.5"/></svg>`,
    close: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" stroke-width="0.8" stroke-dasharray="2 2"/><circle cx="12" cy="12" r="8.2" stroke-width="0.5"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/></svg>`,
    star: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M12 2 L13.5 9.5 L21 12 L13.5 14.5 L12 22 L10.5 14.5 L3 12 L10.5 9.5 Z"/></svg>`,
    lock: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M12 2C9.2 2 7 4.2 7 7v3H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-1V7c0-2.8-2.2-5-5-5zm-3 5c0-1.7 1.3-3 3-3s3 1.3 3 3v3H9V7zm3 7a1.5 1.5 0 0 1 1 2.6V18a1 1 0 0 1-2 0v-1.4A1.5 1.5 0 0 1 12 14z"/></svg>`,
    heartLock: `<svg viewBox="0 0 32 32" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M16 4C13.5 1.5 9 1.5 6.5 4.5C4 7.5 4.5 12 7.5 15.5L16 24L24.5 15.5C27.5 12 28 7.5 25.5 4.5C23 1.5 18.5 1.5 16 4Z"/><circle cx="16" cy="11" r="2.5"/><path d="M15 13.5L17 13.5L17.5 18.5L14.5 18.5Z"/><path d="M16 2L16 0M16 32L16 28M2 16L0 16M32 16L28 16" stroke-linecap="round"/></svg>`,
    letter: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="3" y="5" width="18" height="14" rx="1"/><polyline points="3 7 12 13 21 7"/></svg>`,
    quill: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M20 2c-3 1-8 4-10 11l-3 3 4 4 3-3c7-2 10-7 11-10-1 0-3-3-5-5z"/><path d="M7 16l-4 4"/></svg>`,
    seal: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="6" stroke-dasharray="2 2"/><path d="M12 8v8M8 12h8"/></svg>`,
    postmark: `<svg viewBox="0 0 40 40" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.1"><circle cx="20" cy="20" r="18" stroke-dasharray="3 2"/><circle cx="20" cy="20" r="15"/><line x1="7" y1="17" x2="33" y2="17"/><line x1="7" y1="23" x2="33" y2="23"/></svg>`,
    photo: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="3" y="3" width="18" height="18" rx="1"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
    burn: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M12 2C8 7 6 10 6 14a6 6 0 0 0 12 0c0-4-2-7-6-12z"/><path d="M12 18a2 2 0 0 0 2-2c0-2-1-3-2-4-1 1-2 2-2 4a2 2 0 0 0 2 2z"/></svg>`
  };

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
  function dateText(value) {
    if (!value) return '';
    const d = new Date(value);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function status(message, error) {
    const el = root.querySelector('.mailbox-status');
    if (!el) return;
    el.innerHTML = message ? `<span class="mailbox-status-inner">${escapeHtml(message)}</span>` : '';
    el.classList.toggle('error', !!error);
  }
  async function request(path, options = {}, token) {
    if (!apiUrl) throw new Error('信箱服务尚未联通，请联系掌柜。');
    const headers = new Headers(options.headers || {});
    headers.set('X-EPhone-Feedback', '1');
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(`${apiUrl}${path}`, { ...options, headers, cache: 'no-store' });
    let data;
    try { data = await response.json(); } catch (_) { data = {}; }
    if (!response.ok) throw new Error(data.error || `投递受阻（${response.status}）`);
    return data;
  }
  async function loadTurnstile() {
    if (!siteKey) throw new Error('契约封印尚未配置，请联系掌柜。');
    if (window.turnstile) return window.turnstile;
    if (!turnstilePromise) {
      turnstilePromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        script.onload = () => resolve(window.turnstile);
        script.onerror = () => reject(new Error('封印载入失败，请确认网络连接。'));
        document.head.appendChild(script);
      });
    }
    return turnstilePromise;
  }
  async function renderChallenge() {
    const host = root.querySelector('.mailbox-challenge');
    if (!host) return;
    try {
      const turnstile = await loadTurnstile();
      if (!host.isConnected) return;
      challengeWidgetId = turnstile.render(host, {
        sitekey: siteKey,
        theme: 'light',
        callback: token => { host.dataset.token = token; },
        'expired-callback': () => { host.dataset.token = ''; },
        'error-callback': () => { host.dataset.token = ''; status('验印未通过，请重试。', true); }
      });
    } catch (error) { status(error.message, true); }
  }
  function clearChallenge() {
    if (challengeWidgetId !== undefined && window.turnstile) {
      try { window.turnstile.remove(challengeWidgetId); } catch (_) { /* 页面已关闭 */ }
    }
    challengeWidgetId = undefined;
  }

  function clearNoticeCountdown() {
    if (noticeCountdownTimer) clearInterval(noticeCountdownTimer);
    noticeCountdownTimer = null;
  }

  function showNoticeModal() {
    if (!root) return;
    const backdrop = root.querySelector('.mailbox-notice-backdrop');
    if (!backdrop) return;
    const privacyTitle = backdrop.querySelector('.mailbox-notice-privacy-title');
    const privacyText = backdrop.querySelector('.mailbox-notice-privacy-text');
    if (privacyTitle) privacyTitle.textContent = state.mode === 'private' ? '私密信件' : '公开信件';
    if (privacyText) privacyText.textContent = state.mode === 'private'
      ? '此信仅你与作者可见。'
      : '审核通过后，信件与往来内容可供其他用户查看。';

    clearNoticeCountdown();
    const ackBtn = backdrop.querySelector('[data-action="notice-ack"]');
    const countdownEl = ackBtn?.querySelector('.ack-countdown');
    if (ackBtn) ackBtn.disabled = true;

    let seconds = 5;
    if (countdownEl) countdownEl.textContent = `(${seconds}s)`;

    backdrop.hidden = false;
    backdrop.classList.add('is-open');

    noticeCountdownTimer = setInterval(() => {
      seconds--;
      if (seconds > 0) {
        if (countdownEl) countdownEl.textContent = `(${seconds}s)`;
      } else {
        clearNoticeCountdown();
        if (countdownEl) countdownEl.textContent = '';
        if (ackBtn) ackBtn.disabled = false;
      }
    }, 1000);
  }

  function closeNoticeModal() {
    clearNoticeCountdown();
    const backdrop = root?.querySelector('.mailbox-notice-backdrop');
    if (backdrop) {
      backdrop.hidden = true;
      backdrop.classList.remove('is-open');
    }
  }
  function formDataFrom(form) {
    const data = new FormData(form);
    const image = data.get('image');
    if (image && image.size > MAX_IMAGE_BYTES) throw new Error('附信物件不能超过 1 MB。');
    if (!image || !image.size) data.delete('image');
    const challenge = form.querySelector('.mailbox-challenge');
    if (!challenge?.dataset.token) throw new Error('请先触碰契约封印完成验证。');
    data.set('turnstileToken', challenge.dataset.token);
    return data;
  }
  function clearRefresh() { if (refreshTimer) clearInterval(refreshTimer); refreshTimer = null; }

  function shell() {
    if (root) return;
    root = document.createElement('section');
    root.id = 'ephone-feedback';
    root.className = 'mailbox-overlay';
    root.setAttribute('aria-label', '心之信箱');
    root.innerHTML = `
      <div class="mailbox-envelope">
        <!-- 装饰性古典四角星芒 -->
        <span class="mailbox-corner corner-tl"></span>
        <span class="mailbox-corner corner-tr"></span>
        <span class="mailbox-corner corner-bl"></span>
        <span class="mailbox-corner corner-br"></span>

        <header class="mailbox-header">
          <button type="button" class="mailbox-btn-icon" data-action="back" aria-label="返回">${ICONS.back}</button>
          <div class="mailbox-title-block">
            <span class="mailbox-sub-emblem">${ICONS.star} HUMPTY LOCK · HEART'S POST ${ICONS.star}</span>
            <h2 class="mailbox-title"></h2>
          </div>
          <button type="button" class="mailbox-btn-icon" data-action="close" aria-label="关闭">${ICONS.close}</button>
        </header>

        <div class="mailbox-status" role="status"></div>
        <main class="mailbox-viewport"></main>

        <!-- 作者寄语 · 投稿须知 弹窗 -->
        <div class="mailbox-notice-backdrop" hidden>
          <div class="mailbox-notice-modal" role="dialog" aria-modal="true" aria-labelledby="noticeModalTitle">
            <div class="mailbox-notice-decor">
              <span class="mailbox-corner corner-tl"></span>
              <span class="mailbox-corner corner-tr"></span>
              <span class="mailbox-corner corner-bl"></span>
              <span class="mailbox-corner corner-br"></span>
            </div>
            <header class="mailbox-notice-header">
              <div class="mailbox-notice-badge">
                <span class="notice-badge-star">${ICONS.star}</span>
                <span class="notice-badge-text">SUBMISSION GUIDE</span>
                <span class="notice-badge-star">${ICONS.star}</span>
              </div>
              <h3 class="mailbox-notice-title" id="noticeModalTitle">作者寄语 · 投稿须知</h3>
            </header>

            <div class="mailbox-notice-body">
              <div class="mailbox-notice-item">
                <div class="notice-item-head">
                  <span class="notice-item-icon">✦</span>
                  <strong class="notice-item-title">尊重原创 · 勿投他人灵感</strong>
                </div>
                <p class="notice-item-desc">请写下属于你自己的真实心声与原创构想。严禁搬运、投稿其他作者的专属创意与设定，请共同尊重并守护每一位创作者的心血。</p>
              </div>

              <div class="mailbox-notice-item">
                <div class="notice-item-head">
                  <span class="notice-item-icon">⚑</span>
                  <strong class="notice-item-title">异常报错 · 最好附带示例图</strong>
                </div>
                <p class="notice-item-desc">反馈 BUG 或报错时，请尽量附带相关示例截图，并简述触发步骤或提示信息。</p>
              </div>

              <div class="mailbox-notice-item">
                <div class="notice-item-head">
                  <span class="notice-item-icon">◈</span>
                  <strong class="notice-item-title mailbox-notice-privacy-title">私密信件</strong>
                </div>
                <p class="notice-item-desc mailbox-notice-privacy-text">此信仅你与作者可见。</p>
              </div>
            </div>

            <footer class="mailbox-notice-footer">
              <button type="button" class="mailbox-btn-notice-suppress" data-action="notice-suppress">不再提示</button>
              <button type="button" class="mailbox-btn-notice-ack" data-action="notice-ack" disabled>
                <span class="ack-text">我已知悉</span>
                <span class="ack-countdown">(5s)</span>
              </button>
            </footer>
          </div>
        </div>
        <div class="mailbox-confirm-backdrop" hidden>
          <div class="mailbox-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="mailboxConfirmTitle">
            <h3 id="mailboxConfirmTitle">请确认操作</h3>
            <p class="mailbox-confirm-message"></p>
            <div class="mailbox-confirm-actions">
              <button type="button" data-action="confirm-cancel">取消</button>
              <button type="button" data-action="confirm-accept">确认</button>
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(root);

    root.addEventListener('click', handleClick);
    root.addEventListener('keydown', event => {
      const dialog = root.querySelector('.mailbox-confirm-backdrop');
      if (dialog?.hidden) return;
      if (event.key === 'Escape') { event.preventDefault(); settleConfirm(false); }
      if (event.key === 'Tab') {
        const buttons = [...dialog.querySelectorAll('button')];
        const next = event.shiftKey ? buttons[0] : buttons[1];
        if (document.activeElement === next) {
          event.preventDefault();
          (event.shiftKey ? buttons[1] : buttons[0]).focus();
        }
      }
    });
    root.addEventListener('submit', handleSubmit);
    root.addEventListener('input', event => {
      if (!event.target.closest('.mailbox-form')) return;
      const form = event.target.form;
      if (!form) return;
      const draft = Object.fromEntries(new FormData(form).entries());
      delete draft.image;
      delete draft.turnstileToken;
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ mode: state.mode, ...draft }));
    });
    root.addEventListener('change', event => {
      // 附件文件选中预览提示
      if (event.target.matches('input[type="file"][name="image"]')) {
        const file = event.target.files[0];
        const previewEl = event.target.closest('.mailbox-file-label')?.querySelector('.mailbox-file-tip');
        if (previewEl) {
          previewEl.textContent = file ? `已随信夹入: ${file.name}` : '可随信附上一张画卷截图（1MB内）';
        }
      }
      // 分类 Stamp 单选外观联动
      if (event.target.matches('input[name="category"]')) {
        root.querySelectorAll('.mailbox-stamp-pill').forEach(el => el.classList.remove('is-active'));
        const activeLabel = event.target.closest('.mailbox-stamp-pill');
        if (activeLabel) activeLabel.classList.add('is-active');
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (!root.classList.contains('open')) return;
      if (document.hidden) clearRefresh();
      else { refresh(); startRefresh(); }
    });
  }

  function heading() {
    const titleEl = root.querySelector('.mailbox-title');
    if (!titleEl) return;
    if (state.page === 'thread') {
      titleEl.textContent = state.thread?.title || '展开的往来信札';
    } else if (state.page === 'new') {
      titleEl.textContent = state.mode === 'private' ? '撰写心愿秘密信' : '撰写公开回声集';
    } else {
      titleEl.textContent = state.mode === 'private' ? '心之信箱 · 秘语录' : '心之信箱 · 见证集';
    }
  }

  // 1. 首页：心之信箱展厅
  function renderList() {
    viewSequence++;
    clearChallenge();
    state.page = 'list';
    state.thread = null;
    heading();

    const owned = state.owned.filter(item => item.kind === state.mode);
    const isPrivate = state.mode === 'private';

    root.querySelector('.mailbox-viewport').innerHTML = `
      <div class="mailbox-hub">
        <!-- 顶部心之锁与信箱徽印说明卷轴 -->
        <section class="mailbox-parchment">
          <div class="mailbox-crest">
            <span class="mailbox-crest-icon">${ICONS.heartLock}</span>
            <div class="mailbox-crest-divider"><span class="gem"></span></div>
          </div>
          <p class="mailbox-parchment-text">
            ${isPrivate
              ? '「心灵锁孔只向你与作者开启。」<br>投递的每一封心愿信件，皆在此浏览器静候回音。请勿清除站点记忆，以免信箱密钥遗失。'
              : '「公开展阅的每一抹思绪，经审阅后将化作星辉向所有人展示。」'}
          </p>
        </section>

        <!-- 核心投递入口：信件插槽卡 -->
        <section class="mailbox-slot-section">
          <button type="button" class="mailbox-post-slot" data-action="new">
            <div class="mailbox-slot-decor">
              <span class="mailbox-slot-star">${ICONS.star}</span>
              <span class="mailbox-slot-letter">${ICONS.letter}</span>
              <span class="mailbox-slot-star">${ICONS.star}</span>
            </div>
            <div class="mailbox-slot-content">
              <strong class="mailbox-slot-label">${isPrivate ? '投递一封新的心愿' : '提笔写下公开反馈'}</strong>
              <span class="mailbox-slot-hint">CLICK TO COMPOSE · 寄往心之信箱</span>
            </div>
            <span class="mailbox-slot-arrow">${ICONS.quill}</span>
          </button>
        </section>

        <!-- 我的信札往来档案 -->
        <section class="mailbox-section">
          <div class="mailbox-section-header">
            <span class="mailbox-section-glyph">${ICONS.seal}</span>
            <h3 class="mailbox-section-title">我的信札留档 · ARCHIVE</h3>
            <span class="mailbox-count">${owned.length}</span>
          </div>

          <div class="mailbox-letter-stack">
            ${owned.length ? owned.map(item => `
              <button type="button" class="mailbox-letter-card" data-action="own" data-id="${item.id}">
                <div class="mailbox-card-stamp">${ICONS.postmark}</div>
                <div class="mailbox-card-body">
                  <div class="mailbox-card-meta">
                    <span class="mailbox-letter-code">NO. ${item.id.slice(0, 8).toUpperCase()}</span>
                    <span class="mailbox-status-tag" data-bind-status="${item.id}">封缄待验</span>
                  </div>
                  <strong class="mailbox-card-title">${escapeHtml(item.title || '无题信札')}</strong>
                </div>
                <div class="mailbox-card-unseal-tag">展读 →</div>
              </button>
            `).join('') : `
              <div class="mailbox-empty-state">
                <div class="mailbox-empty-icon">${ICONS.star}</div>
                <p class="mailbox-empty-text">邮筒尚空，未曾投递任何心愿信件</p>
              </div>
            `}
          </div>
        </section>

        ${!isPrivate ? `
          <!-- 公开回声展台 -->
          <section class="mailbox-section">
            <div class="mailbox-section-header">
              <span class="mailbox-section-glyph">${ICONS.star}</span>
              <h3 class="mailbox-section-title">公开展览信札 · PUBLIC ECHOES</h3>
            </div>
            <div class="mailbox-public-board">
              <div class="mailbox-public-list">
                <div class="mailbox-empty-state"><p class="mailbox-empty-text">正在翻阅公开信笺…</p></div>
              </div>
              <button type="button" data-action="more" class="mailbox-btn-secondary" hidden>翻阅更多信笺</button>
            </div>
          </section>
        ` : ''}
      </div>
    `;

    refreshOwned();
    if (!isPrivate) loadPublic(true);
  }

  function paintEntryIndicators(threads, owned) {
    const byId = new Map(threads.map(thread => [thread.id, thread]));
    for (const mode of ['private', 'public']) {
      const button = document.querySelector(`[data-feedback-entry="${mode}"]`);
      if (!button) continue;
      const mine = owned.filter(item => item.kind === mode).map(item => ({ local: item, remote: byId.get(item.id) })).filter(item => item.remote);
      const replied = mine.some(({ local, remote }) => remote.last_admin_at > (local.seenAt || 0));
      const published = mode === 'public' && mine.some(({ remote }) => remote.status === 'visible');
      const label = replied && published ? '回信·公开' : replied ? '有回信' : published ? '已公开' : '前往';
      button.innerHTML = replied || published ? `${ICONS.letter}<span>${label}</span>` : label;
      button.classList.toggle('has-feedback-notice', replied || published);
      button.setAttribute('aria-label', mode === 'private'
        ? (replied ? '匿名许愿有新回信，前往查看' : '前往匿名许愿')
        : (replied && published ? '公开反馈有新回信，信件已公开，前往查看' : replied ? '公开反馈有新回信，前往查看' : published ? '信件已公开，前往查看' : '前往公开反馈'));
    }
  }
  function confirmAction(message) {
    const backdrop = root.querySelector('.mailbox-confirm-backdrop');
    backdrop.querySelector('.mailbox-confirm-message').textContent = message;
    backdrop.hidden = false;
    backdrop.querySelector('[data-action="confirm-cancel"]').focus();
    return new Promise(resolve => { confirmResolve = resolve; });
  }
  function settleConfirm(approved) {
    const backdrop = root?.querySelector('.mailbox-confirm-backdrop');
    if (backdrop) backdrop.hidden = true;
    if (confirmResolve) { confirmResolve(approved); confirmResolve = null; }
  }

  async function fetchOwnedStatuses() {
    const owned = ownedThreads();
    if (!apiUrl || !owned.length) { paintEntryIndicators([], owned); return []; }
    const threads = [];
    for (let start = 0; start < owned.length; start += 30) {
      const data = await request('/inbox', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threads: owned.slice(start, start + 30).map(({ id, token }) => ({ id, token })) })
      });
      threads.push(...data.threads);
    }
    paintEntryIndicators(threads, owned);
    return threads;
  }

  async function refreshOwned() {
    try {
      const threads = await fetchOwnedStatuses();
      for (const thread of threads) {
        const local = state.owned.find(item => item.id === thread.id);
        if (!local) continue;
        const tag = root.querySelector(`[data-bind-status="${thread.id}"]`);
        if (tag) {
          const hasNew = thread.last_admin_at > (local.seenAt || 0);
          tag.classList.toggle('has-reply', hasNew);
          const letter = hasNew || thread.status === 'visible';
          const label = hasNew && thread.status === 'visible' ? '新回信 · 已公开' :
            hasNew ? '有新回信' :
            thread.status === 'visible' ? '信件已公开' :
            thread.visitor_closed || thread.status === 'closed' ? '对话已关闭' :
            thread.status === 'pending' ? '静候启封' : '封缄留档';
          tag.innerHTML = letter ? `${ICONS.letter}<span>${label}</span>` : label;
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
      const host = root.querySelector('.mailbox-public-list');
      if (!host) return;
      host.innerHTML = state.publicItems.length ? state.publicItems.map(item => `
        <button type="button" class="mailbox-public-card" data-action="public" data-id="${item.id}">
          <div class="mailbox-public-top">
            <span class="mailbox-signature">寄信人：${escapeHtml(item.nickname || '未署名心愿者')}</span>
            <span class="mailbox-timestamp">${dateText(item.created_at)}</span>
          </div>
          <strong class="mailbox-public-heading">${escapeHtml(item.title)}</strong>
        </button>`).join('') : '<div class="mailbox-empty-state"><p class="mailbox-empty-text">信台清澈，暂无公开展出信札</p></div>';
      const moreBtn = root.querySelector('[data-action="more"]');
      if (moreBtn) moreBtn.hidden = !data.nextCursor;
    } catch (error) { status(error.message, true); }
  }

  // 2. 写信页：心愿信笺撰写
  function renderNew() {
    viewSequence++;
    clearChallenge();
    state.page = 'new';
    heading();

    const draft = readLocal(DRAFT_KEY, {});
    const isPrivate = state.mode === 'private';
    const activeCat = (draft.mode === state.mode && draft.category) || 'wish';

    root.querySelector('.mailbox-viewport').innerHTML = `
      <div class="mailbox-parchment-sheet">
        <form class="mailbox-form mailbox-new-form">
          <!-- 信笺页眉与纹印 -->
          <div class="mailbox-sheet-header">
            <div class="mailbox-stamp-box">
              <span class="stamp-border">
                <span class="stamp-icon">${ICONS.star}</span>
                <span class="stamp-text">ROYAL MAIL</span>
              </span>
            </div>
            <div class="mailbox-sheet-motto">
              <div class="mailbox-sheet-motto-row">
                <span class="motto-line">DEAR GUARDIAN · 心之所向</span>
                <button type="button" class="mailbox-btn-guide-tag" data-action="open-notice">
                  <span>✦ 作者寄语</span>
                </button>
              </div>
              <p class="motto-note">${isPrivate ? '把最真实的心声折进信笺，此信仅你与掌柜可见。' : '公开的回声在审阅后将向所有心愿同伴展出。'}</p>
            </div>
          </div>

          <!-- 分类邮戳印章选择器 (完全取代丑陋的下拉框) -->
          <div class="mailbox-field">
            <label class="mailbox-field-label">
              <span class="label-star">${ICONS.star}</span>
              <span>信件品类 · POSTAL CATEGORY</span>
            </label>
            <div class="mailbox-stamp-group">
              <label class="mailbox-stamp-pill ${activeCat === 'wish' ? 'is-active' : ''}">
                <input type="radio" name="category" value="wish" ${activeCat === 'wish' ? 'checked' : ''}>
                <span class="pill-symbol">✦</span>
                <span class="pill-title">心愿许愿</span>
              </label>
              <label class="mailbox-stamp-pill ${activeCat === 'feedback' ? 'is-active' : ''}">
                <input type="radio" name="category" value="feedback" ${activeCat === 'feedback' ? 'checked' : ''}>
                <span class="pill-symbol">✧</span>
                <span class="pill-title">功能建议</span>
              </label>
              <label class="mailbox-stamp-pill ${activeCat === 'bug' ? 'is-active' : ''}">
                <input type="radio" name="category" value="bug" ${activeCat === 'bug' ? 'checked' : ''}>
                <span class="pill-symbol">⚑</span>
                <span class="pill-title">异常报错</span>
              </label>
              <label class="mailbox-stamp-pill ${activeCat === 'other' ? 'is-active' : ''}">
                <input type="radio" name="category" value="other" ${activeCat === 'other' ? 'checked' : ''}>
                <span class="pill-symbol">◈</span>
                <span class="pill-title">其他随笔</span>
              </label>
            </div>
          </div>

          ${!isPrivate ? `
            <!-- 公开署名 -->
            <div class="mailbox-field">
              <label class="mailbox-field-label">
                <span class="label-star">${ICONS.star}</span>
                <span>署名 · SENDER NICKNAME（可选）</span>
              </label>
              <div class="mailbox-input-wrap">
                <input type="text" name="nickname" maxlength="24" placeholder="留下你的专属代号或匿名…" value="${escapeHtml(draft.mode === state.mode ? draft.nickname || '' : '')}">
              </div>
            </div>
          ` : ''}

          <!-- 正文书写信笺纸 -->
          <div class="mailbox-field">
            <label class="mailbox-field-label">
              <span class="label-star">${ICONS.star}</span>
              <span>信札正文 · LETTER CONTENTS</span>
            </label>
            <div class="mailbox-textarea-wrap">
              <textarea name="body" maxlength="5000" rows="8" required placeholder="提笔写下你想传达的心语或所遇之难题…">${escapeHtml(draft.mode === state.mode ? draft.body || '' : '')}</textarea>
              <div class="mailbox-lined-bg" aria-hidden="true"></div>
            </div>
          </div>

          <!-- 随信附图附件卡 -->
          <div class="mailbox-field">
            <label class="mailbox-file-label">
              <input type="file" name="image" accept="image/png,image/jpeg,image/webp">
              <span class="mailbox-file-card">
                <span class="mailbox-file-icon">${ICONS.photo}</span>
                <span class="mailbox-file-tip">随信夹入截图附件（可不选，1MB以内）</span>
              </span>
            </label>
          </div>

          <!-- 人机验证契约 -->
          <div class="mailbox-challenge-section">
            <div class="mailbox-challenge-title">加盖封信防伪印鉴</div>
            <div class="mailbox-challenge"></div>
          </div>

          <!-- 寄信封缄操作栏 -->
          <div class="mailbox-actions-bar">
            <button type="submit" class="mailbox-btn-seal">
              <span class="seal-icon">${ICONS.seal}</span>
              <span class="seal-text">${isPrivate ? '封缄并投入心之信箱' : '封缄并呈递公开审阅'}</span>
            </button>
          </div>
        </form>
      </div>
    `;

    renderChallenge();

    // 每次进入写信页面检查是否触发弹窗
    const suppressedVer = localStorage.getItem(state.mode === 'private' ? NOTICE_SUPPRESS_KEY : `${NOTICE_SUPPRESS_KEY}_public`);
    if (suppressedVer !== NOTICE_VERSION) {
      showNoticeModal();
    }
  }

  // 3. 详情与往来回信页
  async function openThread(id, publicView) {
    const currentView = ++viewSequence;
    try {
      status('正在启封往来信札…');
      const credential = getCredential(id);
      const data = await request(`/threads/${id}`, {}, publicView ? null : credential?.token);
      if (state.page === 'closed' || currentView !== viewSequence) return;
      const scrollTop = root.querySelector('.mailbox-viewport').scrollTop;
      clearChallenge();
      state.thread = data.thread;
      state.page = 'thread';
      heading();

      const canReply = !!credential && !data.thread.visitor_closed && data.thread.status !== 'closed' && data.thread.status !== 'hidden';

      root.querySelector('.mailbox-viewport').innerHTML = `
        <div class="mailbox-thread-view">
          <!-- 信封拆启信头铭牌 -->
          <header class="mailbox-thread-meta-bar">
            <div class="mailbox-thread-info">
              <span class="meta-tag">LETTER NO. ${id.slice(0, 8).toUpperCase()}</span>
              <span class="meta-kind">${data.thread.kind === 'public' ? '公开见证集' : '心愿秘密信'}</span>
              <span class="meta-date">${dateText(data.thread.created_at)}</span>
            </div>
            <div class="mailbox-thread-postmark">${ICONS.postmark}</div>
          </header>

          <!-- 往来信笺流 (继承功能：对话流展示) -->
          <div class="mailbox-thread-scroll">
            <div class="mailbox-scroll-inner">
              ${data.messages.map((message, idx) => {
                const isAdmin = message.sender === 'admin';
                return `
                  <article class="mailbox-missive ${isAdmin ? 'missive-guardian' : 'missive-seeker'}">
                    <div class="missive-frame">
                      <div class="missive-head">
                        <span class="missive-author">
                          <span class="missive-star">${isAdmin ? '✦' : '✧'}</span>
                          ${isAdmin ? '心之守护者 · 掌柜' : escapeHtml(data.thread.nickname || '投信者')}
                        </span>
                        <time class="missive-time">${dateText(message.created_at)}</time>
                      </div>
                      <div class="missive-body">${escapeHtml(message.body).replace(/\n/g, '<br>')}</div>
                      ${message.attachment_key ? `
                        <div class="missive-attachment">
                          <button type="button" class="mailbox-attachment-btn" data-action="image" data-key="${message.attachment_key}" data-id="${id}">
                            <span class="btn-ic">${ICONS.photo}</span>
                            <span>启封随信画卷</span>
                          </button>
                        </div>
                      ` : ''}
                    </div>
                  </article>
                `;
              }).join('')}
            </div>
          </div>

          <!-- 续写回信栏 -->
          ${canReply ? `
            <section class="mailbox-reply-drawer">
              <form class="mailbox-form mailbox-reply-form">
                <div class="mailbox-reply-prompt">
                  <span class="reply-star">${ICONS.quill}</span>
                  <strong>续写你的心语回信</strong>
                </div>
                <div class="mailbox-textarea-wrap mini">
                  <textarea name="body" maxlength="5000" rows="3" required placeholder="提笔续写…"></textarea>
                </div>
                <label class="mailbox-file-label mini">
                  <input type="file" name="image" accept="image/png,image/jpeg,image/webp">
                  <span class="mailbox-file-card mini">
                    <span class="mailbox-file-icon">${ICONS.photo}</span>
                    <span class="mailbox-file-tip">随信夹入附图（可选，1MB内）</span>
                  </span>
                </label>
                <div class="mailbox-challenge-section mini">
                  <div class="mailbox-challenge"></div>
                </div>
                <button type="submit" class="mailbox-btn-seal mini">
                  <span class="seal-icon">${ICONS.seal}</span>
                  <span class="seal-text">封缄并发出回信</span>
                </button>
              </form>
            </section>
          ` : data.thread.visitor_closed || data.thread.status === 'closed' ? `
            <p class="mailbox-thread-closed">对话已关闭，往来记录仍可查看。</p>
          ` : ''}

          <!-- 信札销毁归档选项 -->
          ${credential ? `
            <div class="mailbox-danger-zone">
              ${!data.thread.visitor_closed && data.thread.status !== 'closed' ? `
                <button type="button" class="mailbox-burn-btn" data-action="close-thread" data-id="${id}">
                  <span>关闭对话</span>
                </button>
              ` : ''}
              <button type="button" class="mailbox-burn-btn" data-action="delete" data-id="${id}">
                <span class="burn-icon">${ICONS.burn}</span>
                <span>删除对话</span>
              </button>
            </div>
          ` : ''}
        </div>
      `;

      root.querySelector('.mailbox-viewport').scrollTop = scrollTop;
      if (credential) {
        const items = ownedThreads();
        const item = items.find(row => row.id === id);
        if (item) {
          item.seenAt = Math.max(item.seenAt || 0, data.thread.last_admin_at || 0);
          saveOwned(items);
          state.owned = items;
        }
        fetchOwnedStatuses().catch(() => {});
      }
      status('');
      if (canReply) renderChallenge();
    } catch (error) { status(error.message, true); }
  }

  async function viewImage(id, key) {
    try {
      const credential = getCredential(id);
      const response = await fetch(`${apiUrl}/attachments/${key}`, {
        headers: { 'X-EPhone-Feedback': '1', ...(credential ? { Authorization: `Bearer ${credential.token}` } : {}) },
        cache: 'no-store'
      });
      if (!response.ok) throw new Error('画卷读取受阻。');
      const url = URL.createObjectURL(await response.blob());
      const container = document.createElement('div');
      container.className = 'mailbox-image-viewer';
      const image = new Image();
      image.src = url;
      image.alt = '信札附随画卷';
      image.className = 'mailbox-framed-photo';
      image.onload = () => URL.revokeObjectURL(url);
      container.appendChild(image);
      root.querySelector(`[data-key="${key}"]`)?.replaceWith(container);
    } catch (error) { status(error.message, true); }
  }

  async function handleClick(event) {
    const button = event.target.closest('[data-action]');
    if (!button || !root.contains(button)) return;
    const { action, id, key } = button.dataset;
    if (action === 'confirm-cancel') return settleConfirm(false);
    if (action === 'confirm-accept') return settleConfirm(true);
    if (action === 'close') return close();
    if (action === 'back') { status(''); if (state.page === 'list') close(); else renderList(); return; }
    if (action === 'new') return renderNew();
    if (action === 'own') return openThread(id, false);
    if (action === 'public') return openThread(id, true);
    if (action === 'more') return loadPublic(false);
    if (action === 'image') return viewImage(id, key);
    if (action === 'open-notice') {
      showNoticeModal();
      return;
    }
    if (action === 'notice-ack') {
      // 仅关闭当前弹窗，下次进入依然会弹出
      closeNoticeModal();
      return;
    }
    if (action === 'notice-suppress') {
      // 记录已抑制的版本，下次不再弹，除非版本升级
      localStorage.setItem(state.mode === 'private' ? NOTICE_SUPPRESS_KEY : `${NOTICE_SUPPRESS_KEY}_public`, NOTICE_VERSION);
      closeNoticeModal();
      return;
    }
    if (action === 'close-thread') {
      if (!await confirmAction(state.thread?.kind === 'public'
        ? '关闭后无法继续回信，已有记录会保留，已公开的信件仍会展示。'
        : '关闭后无法继续回信，已有记录会保留。')) return;
      try {
        await request(`/threads/${id}`, { method: 'PATCH' }, getCredential(id)?.token);
        await openThread(id, false);
        status('对话已关闭。');
      } catch (error) { status(error.message, true); }
    }
    if (action === 'delete') {
      if (!await confirmAction(state.thread?.kind === 'public'
        ? '确认永久删除此对话吗？已公开的信件也会从公开列表移除，此举无法挽回。'
        : '确认永久删除此对话及附件吗？此举无法挽回。')) return;
      try {
        await request(`/threads/${id}`, { method: 'DELETE' }, getCredential(id)?.token);
        const items = ownedThreads().filter(item => item.id !== id);
        saveOwned(items);
        state.owned = items;
        renderList();
        status('信札已化作尘烟。');
      } catch (error) { status(error.message, true); }
    }
  }

  async function handleSubmit(event) {
    const form = event.target;
    if (!form.matches('.mailbox-new-form, .mailbox-reply-form')) return;
    event.preventDefault();
    if (state.busy) return;
    try {
      const data = formDataFrom(form);
      state.busy = true;
      form.querySelector('[type="submit"]').disabled = true;
      status('正在投递心意…');
      if (form.classList.contains('mailbox-new-form')) {
        const summary = String(data.get('body') || '').trim().replace(/\s+/g, ' ');
        data.set('title', summary.length > 32 ? `${summary.slice(0, 32)}…` : summary);
        const oldDraft = readLocal(DRAFT_KEY, {});
        const pending = oldDraft.mode === state.mode && oldDraft.pending;
        const id = pending?.id || randomUUID();
        const token = pending?.token || [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
        localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...oldDraft, mode: state.mode, pending: { id, token } }));
        data.set('id', id);
        data.set('token', token);
        data.set('kind', state.mode);
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
      status('投递达成。');
    } catch (error) { status(error.message, true); }
    finally {
      state.busy = false;
      if (form.isConnected) {
        form.querySelector('[type="submit"]').disabled = false;
        const challenge = form.querySelector('.mailbox-challenge');
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
      if (root.querySelector('.mailbox-reply-form textarea')?.value.trim()) return;
      const id = state.thread.id;
      await openThread(id, !getCredential(id));
    }
  }

  function startRefresh() { clearRefresh(); refreshTimer = setInterval(refresh, 60000); }

  function open(mode) {
    shell();
    state.mode = mode === 'public' ? 'public' : 'private';
    state.owned = ownedThreads();
    state.publicItems = [];
    state.publicNextCursor = null;
    root.classList.add('open');
    document.body.classList.add('feedback-open');
    status(apiUrl && siteKey ? '' : '信箱未启，掌柜尚未联通结界。', true);
    renderList();
    startRefresh();
  }

  function close() {
    settleConfirm(false);
    viewSequence++;
    clearRefresh();
    clearChallenge();
    clearNoticeCountdown();
    closeNoticeModal();
    state.page = 'closed';
    state.thread = null;
    root.classList.remove('open');
    document.body.classList.remove('feedback-open');
  }

  window.EPhoneFeedback = { open, close };
  async function refreshEntryIndicators(force = false) {
    const settings = document.getElementById('api-settings-screen');
    if (!settings?.classList.contains('active') || document.hidden || root?.classList.contains('open')) return;
    if (!force && Date.now() - lastIndicatorCheck < 15000) return;
    lastIndicatorCheck = Date.now();
    try { await fetchOwnedStatuses(); } catch (_) { /* 保留上一次已知状态 */ }
  }
  document.addEventListener('click', () => setTimeout(refreshEntryIndicators, 0), true);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshEntryIndicators(true); });
  window.addEventListener('pageshow', () => refreshEntryIndicators(true));
  setInterval(() => refreshEntryIndicators(true), 60000);
})();
