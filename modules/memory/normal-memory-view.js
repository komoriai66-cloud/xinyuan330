(function () {
  'use strict';
  const manager = window.normalMemoryManager;
  if (!manager) return;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const statusText = { running: '正在梳理', paused: '已暂停，可继续', failed: '处理失败，可继续', ready: '结果待选择', applied: '已应用，可查看剩余建议' };
  let panel = null;
  function privateChats(chat) {
    if (!chat.isGroup) return [chat];
    return (chat.members || []).map(m => state.chats[m.id]).filter(Boolean);
  }
  manager.renderEntry = function (chat) {
    const container = document.getElementById('original-memory-container');
    if (!container || !chat) return;
    let entry = container.querySelector('#normal-memory-tools');
    if (!entry) {
      entry = document.createElement('div'); entry.id = 'normal-memory-tools'; entry.className = 'nm-entry';
      container.insertBefore(entry, container.firstChild);
      entry.addEventListener('click', event => { if (event.target.closest('button')) open(state.chats[state.activeChatId]); });
    }
    const roles = privateChats(chat);
    roles.forEach(role => manager.ensure(role));
    const pending = roles.reduce((sum, c) => sum + manager.proposals(c).length, 0);
    const count = roles.reduce((sum, c) => sum + manager.active(c).length, 0);
    const running = roles.some(c => manager.locks.has(c));
    const queued = roles.reduce((sum, c) => sum + (c.normalMemory?.pendingIds?.length || 0), 0);
    entry.innerHTML = `<span class="nm-entry-label">记忆概况 <span class="nm-muted">${count}项${running ? ' · 梳理中' : pending ? ` · ${pending}项待选` : queued ? ` · ${queued}条待整理` : ''}</span></span><button type="button" class="nm-button">记忆梳理</button>`;
  };
  function current() { return state.chats[panel.chatId]; }
  function close() {
    if (!panel) return;
    const entry = document.querySelector('#normal-memory-tools button');
    panel.element.remove(); panel.unsubscribe(); panel = null;
    entry?.focus();
  }
  function open(chat) {
    if (!chat) return;
    close();
    const targets = privateChats(chat);
    const selected = targets[0] || chat;
    manager.ensure(selected);
    const element = document.createElement('div'); element.className = 'nm-overlay';
    element.innerHTML = `<section class="nm-window" role="dialog" aria-modal="true" aria-label="普通记忆梳理" tabindex="-1"><div class="nm-header"><h2>普通记忆梳理</h2><button type="button" class="nm-button" data-action="close">关闭</button></div><div class="nm-role-row"><label for="nm-role">角色</label><select id="nm-role"></select><button type="button" class="nm-button" data-action="roles">多角色</button></div><nav class="nm-tabs" aria-label="记忆梳理区域"><button type="button" data-tab="overview">概况</button><button type="button" data-tab="history">旧记忆</button><button type="button" data-tab="proposals">建议</button><button type="button" data-tab="settings">设置</button><button type="button" data-tab="journal">记录</button></nav><div class="nm-progress" role="status" aria-live="polite"></div><div class="nm-body"></div><div class="nm-feedback" role="status" aria-live="polite"></div></section>`;
    (document.getElementById('phone-screen') || document.body).appendChild(element);
    panel = { element, chatId: selected.id, tab: 'overview', selectedSources: new Set(), selectedProposals: new Set(), search: '', instructions: '', editor: null, settingsDraft: null, roleIds: new Set(targets.map(c => c.id)), multiStop: false, multiRunning: false, feedback: '' };
    panel.unsubscribe = manager.subscribe(changed => {
      if (!panel) return;
      if (changed.id === panel.chatId) {
        progress();
        if (['overview', 'proposals', 'journal'].includes(panel.tab)) render();
      }
      const activeChat = state.chats[state.activeChatId];
      manager.renderEntry(activeChat);
    });
    const select = element.querySelector('#nm-role');
    select.innerHTML = Object.values(state.chats).filter(c => !c.isGroup).map(c => `<option value="${escape(c.id)}" ${c.id === selected.id ? 'selected' : ''}>${escape(c.name || c.originalName)}</option>`).join('');
    element.addEventListener('click', click);
    element.addEventListener('change', change);
    element.addEventListener('input', input);
    element.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.stopPropagation(); close(); return; }
      if (event.key !== 'Tab') return;
      const items = [...element.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary')];
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
    render(); element.querySelector('[data-action="close"]').focus();
  }
  function feedback(text, error = false) {
    if (!panel) return;
    panel.feedback = text;
    const node = panel.element.querySelector('.nm-feedback'); node.textContent = text; node.classList.toggle('nm-error', error);
  }
  function progress() {
    if (!panel) return;
    const chat = current(), task = chat.normalMemory?.task;
    const node = panel.element.querySelector('.nm-progress');
    node.textContent = task ? `${statusText[task.status] || '任务'} · ${task.cursor}/${task.queue.length}片段 · 已请求${task.requests}次${task.error ? ` · ${task.error}` : ''}` : '原始记忆完整保留，概况与建议均可自行选择。';
  }
  function refs(entry, chat) {
    const map = manager.sources(chat);
    return `<details class="nm-sources"><summary>查看依据 · ${entry.sourceRefs.length}条${entry.note ? ` · ${escape(entry.note)}` : ''}</summary>${entry.sourceRefs.map(ref => {
      const source = map.get(ref.id);
      return `<div class="nm-source"><span class="nm-muted">保存于 ${escape(manager.date(source?.timestamp))}${!source || manager.fingerprint(source) !== ref.signature ? ' · 来源已失效' : ''}</span><p>${escape(source?.content || '来源已删除')}</p>${(entry.evidence || []).filter(e => e.sourceId === ref.id).map(e => `<blockquote>${escape(e.quote)}<span class="nm-muted">${e.kind === 'message' ? '原聊天引用' : '总结原文'}</span></blockquote>`).join('')}</div>`;
    }).join('')}</details>`;
  }
  function entryCard(entry, chat, proposal) {
    const invalid = !manager.valid(entry, chat);
    return `<article class="nm-card" data-entry="${escape(entry.id)}"><div class="nm-card-top">${proposal ? `<label class="nm-choice"><input type="checkbox" data-proposal="${escape(entry.id)}" ${panel.selectedProposals.has(entry.id) ? 'checked' : ''} ${invalid ? 'disabled' : ''}><span>选择</span></label>` : ''}<span class="nm-tag">${escape(manager.labels[entry.status])}</span><span class="nm-muted">${invalid ? '来源失效，未参与读取' : entry.certainty === 'uncertain' ? '存在不确定性，待核对' : proposal && !entry.autoEligible ? '需手动确认' : '有来源依据'}</span></div><p class="nm-text">${escape(entry.text)}</p>${entry.eventTime ? `<div class="nm-muted">事件时间：${escape(entry.eventTime)}</div>` : ''}${refs(entry, chat)}<div class="nm-actions"><button type="button" class="nm-button" data-action="${proposal ? 'edit-proposal' : 'edit'}" data-id="${escape(entry.id)}">编辑</button>${!proposal ? `<button type="button" class="nm-button" data-action="remove" data-id="${escape(entry.id)}">移除概况</button>` : ''}</div></article>`;
  }
  function sourceChoices(chat, selected, attr = 'source') {
    const memories = chat.longTermMemory || [];
    return memories.map((m, index) => `<label class="nm-source-choice"><input type="checkbox" data-${attr}="${escape(m.normalMemoryId)}" ${selected.has(m.normalMemoryId) ? 'checked' : ''}><span><span class="nm-muted">${index + 1} · 保存于 ${escape(manager.date(m.timestamp))}</span><span class="nm-text">${escape(m.content)}</span></span></label>`).join('') || '<p class="nm-muted">没有历史记忆。</p>';
  }
  function render() {
    if (!panel) return;
    const chat = current(), data = manager.ensure(chat), body = panel.element.querySelector('.nm-body');
    panel.element.querySelectorAll('[data-tab]').forEach(b => { b.classList.toggle('active', b.dataset.tab === panel.tab); b.setAttribute('aria-current', b.dataset.tab === panel.tab ? 'page' : 'false'); });
    progress();
    if (panel.tab === 'overview') {
      body.innerHTML = `<p class="nm-muted">普通文字概况用于解释历史变化。原有添加、编辑、精炼、还原与导入导出仍在原入口。</p>${manager.mode(chat) !== 'diary' ? '<p class="nm-muted">这个角色当前使用其他记忆模式；这里管理原始记忆，不改变当前模式。</p>' : ''}<div class="nm-actions"><button type="button" class="nm-button" data-action="manual">手动添加概况</button><button type="button" class="nm-button" data-action="read-preview">查看实际读取内容</button></div>${data.entries.map(e => entryCard(e, chat, false)).join('') || '<p class="nm-empty">尚无概况。可以梳理旧记忆，或手动关联原文。</p>'}`;
    } else if (panel.tab === 'history') {
      const list = (chat.longTermMemory || []).filter(m => !panel.search || String(m.content || '').toLowerCase().includes(panel.search.toLowerCase()));
      body.innerHTML = `<p class="nm-muted">选择要核对的历史。约定与完成记录都选上，才能建立关联。不会改写或删除原文，也不会改变聊天总结进度。</p><input id="nm-search" type="search" placeholder="搜索历史正文" value="${escape(panel.search)}"><div class="nm-actions"><button type="button" class="nm-button" data-action="select-sources">选择搜索结果</button><button type="button" class="nm-button" data-action="clear-sources">清空选择</button><span class="nm-muted" id="nm-source-count">已选${panel.selectedSources.size}条</span></div><div class="nm-source-list">${sourceChoices({ ...chat, longTermMemory: list }, panel.selectedSources)}</div><label class="nm-field">整理要求<textarea id="nm-instructions" rows="3" placeholder="例如：核对旅行约定是否履行，保留重要经历">${escape(panel.instructions)}</textarea></label><p class="nm-muted" id="nm-estimate"></p><div class="nm-actions"><button type="button" class="nm-button nm-primary" data-action="start" ${manager.locks.has(chat) ? 'disabled' : ''}>梳理已选记忆</button><button type="button" class="nm-button" data-action="resume">继续任务</button><button type="button" class="nm-button" data-action="pause">暂停</button><button type="button" class="nm-button" data-action="discard">放弃草稿</button></div><p class="nm-muted">使用现有总结接口，会消耗 API 额度。请求次数是估算；已有概况与返回结果会影响实际次数。</p>`;
      estimate();
    } else if (panel.tab === 'proposals') {
      const proposals = manager.proposals(chat);
      body.innerHTML = `<p class="nm-muted">自动应用只处理有明确依据的建议。不确定内容和缺少原聊天依据的状态变化留在这里，可查看、编辑并自主应用。</p><div class="nm-actions"><button type="button" class="nm-button" data-action="select-proposals">全选建议</button><button type="button" class="nm-button" data-action="clear-proposals">取消全选</button><button type="button" class="nm-button nm-primary" data-action="apply">应用所选</button></div>${proposals.map(e => entryCard(e, chat, true)).join('') || '<p class="nm-empty">没有待选择的建议。</p>'}<div class="nm-actions"><button type="button" class="nm-button" data-action="resume">继续任务</button><button type="button" class="nm-button" data-action="pause">暂停</button><button type="button" class="nm-button" data-action="discard">结束 / 放弃草稿</button></div>`;
    } else if (panel.tab === 'settings') {
      const config = panel.settingsDraft || manager.settings(chat); panel.settingsDraft = { ...config };
      body.innerHTML = `<label class="nm-choice"><input type="checkbox" id="nm-interpretation" ${config.interpretation ? 'checked' : ''}><span>解释历史时间与事件状态</span></label><p class="nm-muted">避免把历史计划当作当前未完成事项。关闭后仍可独立选择读取方式。</p><label class="nm-field">聊天读取方式<select id="nm-read-mode"><option value="annotated" ${config.readMode === 'annotated' ? 'selected' : ''}>概况 + 带关联说明的历史</option><option value="overview" ${config.readMode === 'overview' ? 'selected' : ''}>概况优先 + 未关联历史</option><option value="history" ${config.readMode === 'history' ? 'selected' : ''}>只读历史正文</option></select></label><p class="nm-muted">概况优先会省略已关联的历史正文，细节以概况为准；仍可在原始记忆中查看。关闭解释并选择只读历史，可恢复原来的读取方式。现有历史条数限制继续生效。</p><label class="nm-field">新总结后的自动整理<select id="nm-automatic"><option value="apply" ${config.automatic === 'apply' ? 'selected' : ''}>自动整理并应用有依据的结果</option><option value="preview" ${config.automatic === 'preview' ? 'selected' : ''}>自动生成建议，手动选择应用</option><option value="off" ${config.automatic === 'off' ? 'selected' : ''}>关闭自动整理，按需手动操作</option></select></label><label class="nm-choice"><input type="checkbox" id="nm-messages" ${config.includeMessages ? 'checked' : ''}><span>核对可找到的原聊天依据</span></label><p class="nm-muted">仅核对记忆已关联的原消息，不上传整段无关历史。旧记录没有可靠关联时，不假装恢复了原聊天。</p><label class="nm-field">自动核对的相关旧记忆数量<input id="nm-auto-history" type="number" min="0" step="1" value="${config.autoHistoryLimit}"></label><p class="nm-muted">自动整理会从全部历史中寻找相关候选，默认最多20条；0表示不限相关候选。已有关联概况同时参与核对。大量旧数据可在旧记忆区域自行选择梳理范围。</p><label class="nm-field">每批输入字符预算<input id="nm-batch-chars" type="number" min="2000" step="1000" value="${config.batchChars}"></label><p class="nm-muted">较小预算请求更多；较大预算需接口支持。超过预算会明确停止，不悄悄截断。继续任务沿用创建时的预算；调整预算后可放弃并重新整理。</p><button type="button" class="nm-button nm-primary" data-action="save-settings">保存当前角色设置</button>`;
    } else if (panel.tab === 'journal') {
      body.innerHTML = `<p class="nm-muted">撤销只影响对应操作，不删除后来新增的历史。有关联的概况后来发生变化时，会阻止覆盖。</p>${[...data.journal].reverse().map(j => `<article class="nm-card"><div class="nm-card-top"><span>${escape(j.note)}</span><span class="nm-muted">${escape(manager.date(j.date))}</span></div><details class="nm-sources"><summary>查看改动</summary><p class="nm-muted">新增${j.addedIds.length}项；替换 / 移除${j.removedEntries.length}项</p>${j.removedEntries.map(e => `<p class="nm-text">原概况：${escape(e.text)}</p>`).join('')}</details><button type="button" class="nm-button" data-action="undo" data-id="${escape(j.id)}" ${j.undone ? 'disabled' : ''}>${j.undone ? '已撤销' : '撤销此操作'}</button></article>`).join('') || '<p class="nm-empty">还没有应用或手动修改记录。</p>'}`;
    } else if (panel.tab === 'editor') {
      const value = panel.editor;
      body.innerHTML = `<p class="nm-muted">${value.kind === 'proposal' ? '编辑后仍需选择应用。' : '手动确认后立即参与所选读取方式。'}请关联依据，避免概况成为无来源的猜测。</p><label class="nm-field">概况正文<textarea id="nm-editor-text" rows="5">${escape(value.text)}</textarea></label><label class="nm-field">事件状态<select id="nm-editor-status">${Object.entries(manager.labels).map(([key, label]) => `<option value="${key}" ${value.status === key ? 'selected' : ''}>${escape(label)}</option>`).join('')}</select></label><label class="nm-field">确定性<select id="nm-editor-certainty"><option value="clear" ${value.certainty === 'clear' ? 'selected' : ''}>明确</option><option value="uncertain" ${value.certainty === 'uncertain' ? 'selected' : ''}>存在不确定性</option></select></label><label class="nm-field">事件时间<input id="nm-editor-time" type="text" placeholder="明确日期，或时间不明" value="${escape(value.eventTime)}"></label><div class="nm-field">选择依据</div><div class="nm-source-list">${sourceChoices(chat, new Set(value.sourceIds), 'editor-source')}</div><div class="nm-actions"><button type="button" class="nm-button nm-primary" data-action="save-editor">保存</button><button type="button" class="nm-button" data-action="cancel-editor">取消</button></div>`;
    } else if (panel.tab === 'read-preview') {
      body.innerHTML = `<p class="nm-muted">以下为普通记忆读取内容；其他记忆模式仍使用原模式读取。</p><pre class="nm-preview">${escape(manager.serialize(chat))}</pre><button type="button" class="nm-button" data-tab="overview">返回概况</button>`;
    } else if (panel.tab === 'roles') {
      body.innerHTML = `<p class="nm-muted">各角色独立处理，不合并记忆或设置。使用每个角色自己的预算与原聊天核对设置。</p><div class="nm-source-list">${Object.values(state.chats).filter(c => !c.isGroup).map(c => `<label class="nm-source-choice"><input type="checkbox" data-role="${escape(c.id)}" ${panel.roleIds.has(c.id) ? 'checked' : ''}><span>${escape(c.name || c.originalName)}<span class="nm-muted">${c.longTermMemory?.length || 0}条原始记忆</span></span></label>`).join('')}</div><div class="nm-actions"><button type="button" class="nm-button nm-primary" data-action="run-roles" ${panel.multiRunning ? 'disabled' : ''}>为所选角色生成建议</button><button type="button" class="nm-button" data-action="pause-roles">暂停多角色处理</button></div><p class="nm-muted">会分别读取所选角色全部原始记忆并调用总结接口。结果可切换角色查看与选择应用；不会自动切换任何角色的记忆模式。</p>`;
    }
    if (panel.feedback) feedback(panel.feedback);
  }
  function estimate() {
    if (!panel) return;
    const chat = current();
    const result = manager.estimate(chat, [...panel.selectedSources]);
    const node = panel.element.querySelector('#nm-estimate');
    if (node) node.textContent = `所选${result.count}条 · 来源约${result.chars.toLocaleString()}字符 · 至少约${result.requests}次请求（含概况后可能增加）`;
    const count = panel.element.querySelector('#nm-source-count'); if (count) count.textContent = `已选${panel.selectedSources.size}条`;
  }
  function input(event) {
    if (!panel) return;
    const node = event.target;
    if (node.id === 'nm-search') {
      panel.search = node.value;
      // Update only results: keep the search input focused and allow clearing a search to restore all records.
      const chat = current();
      const list = (chat.longTermMemory || []).filter(m => !panel.search || String(m.content || '').toLowerCase().includes(panel.search.toLowerCase()));
      panel.element.querySelector('.nm-source-list').innerHTML = sourceChoices({ ...chat, longTermMemory: list }, panel.selectedSources);
    }
    if (node.id === 'nm-instructions') panel.instructions = node.value;
    if (panel.editor) {
      if (node.id === 'nm-editor-text') panel.editor.text = node.value;
      if (node.id === 'nm-editor-time') panel.editor.eventTime = node.value;
    }
    if (node.id === 'nm-batch-chars' && panel.settingsDraft) panel.settingsDraft.batchChars = node.value;
    if (node.id === 'nm-auto-history' && panel.settingsDraft) panel.settingsDraft.autoHistoryLimit = node.value;
  }
  function change(event) {
    if (!panel) return;
    const node = event.target;
    if (node.id === 'nm-role') {
      panel.chatId = node.value; panel.selectedSources.clear(); panel.selectedProposals.clear(); panel.search = ''; panel.settingsDraft = null; panel.editor = null; panel.tab = 'overview'; render(); return;
    }
    for (const [attr, set] of [['source', panel.selectedSources], ['proposal', panel.selectedProposals], ['role', panel.roleIds]]) if (node.dataset[attr]) { if (node.checked) set.add(node.dataset[attr]); else set.delete(node.dataset[attr]); }
    if (node.dataset.source) estimate();
    if (panel.editor) {
      if (node.id === 'nm-editor-status') panel.editor.status = node.value;
      if (node.id === 'nm-editor-certainty') panel.editor.certainty = node.value;
      if (node.dataset.editorSource) panel.editor.sourceIds = [...panel.element.querySelectorAll('[data-editor-source]:checked')].map(c => c.dataset.editorSource);
    }
    if (panel.settingsDraft) {
      if (node.id === 'nm-read-mode') panel.settingsDraft.readMode = node.value;
      if (node.id === 'nm-automatic') panel.settingsDraft.automatic = node.value;
      if (node.id === 'nm-interpretation') panel.settingsDraft.interpretation = node.checked;
      if (node.id === 'nm-messages') panel.settingsDraft.includeMessages = node.checked;
    }
  }
  async function click(event) {
    const button = event.target.closest('button');
    if (!button || !panel) return;
    if (button.dataset.tab) { panel.tab = button.dataset.tab; panel.feedback = ''; render(); return; }
    const action = button.dataset.action, chat = current(), session = panel;
    if (action === 'close') { close(); return; }
    if (action === 'pause') { manager.pause(chat); feedback('正在暂停；已处理的批次会保留'); return; }
    if (action === 'pause-roles') { panel.multiStop = true; for (const chat of Object.values(state.chats)) if (panel.roleIds.has(chat.id)) manager.pause(chat); feedback('已请求暂停多角色处理'); return; }
    const lockButton = ['start', 'resume', 'apply', 'save-editor', 'save-settings', 'run-roles'].includes(action);
    if (lockButton) button.disabled = true;
    try {
      if (action === 'select-sources') { (chat.longTermMemory || []).filter(m => !panel.search || String(m.content || '').toLowerCase().includes(panel.search.toLowerCase())).forEach(m => panel.selectedSources.add(m.normalMemoryId)); render(); }
      if (action === 'clear-sources') { panel.selectedSources.clear(); render(); }
      if (action === 'select-proposals') { manager.proposals(chat).filter(e => manager.valid(e, chat)).forEach(e => panel.selectedProposals.add(e.id)); render(); }
      if (action === 'clear-proposals') { panel.selectedProposals.clear(); render(); }
      if (action === 'start') {
        feedback('正在梳理，可以暂停或关闭面板；关闭不会丢失任务');
        const task = await manager.start(chat, [...panel.selectedSources], panel.instructions);
        if (panel === session && panel.chatId === chat.id) { panel.tab = task.status === 'ready' ? 'proposals' : 'history'; render(); feedback(task.status === 'ready' ? '梳理完成。原文未改动，请选择需要应用的结果' : '任务已暂停，已完成的批次保留，可继续'); }
      }
      if (action === 'resume') { const task = await manager.resume(chat); if (panel === session && panel.chatId === chat.id) { panel.tab = task.status === 'ready' ? 'proposals' : 'history'; render(); feedback(task.status === 'ready' ? '处理已保存，请选择结果' : '任务已暂停，可继续'); } }
      if (action === 'apply') { const count = await manager.apply(chat, [...panel.selectedProposals]); if (panel === session) { panel.selectedProposals.clear(); render(); feedback(`已应用${count}项，其余建议保留，可继续选择`); } }
      if (action === 'discard') { if (await showCustomConfirm('结束记忆草稿', '未应用的建议将被放弃；历史原文与已应用的概况保留。')) { await manager.discard(chat); if (panel === session) { render(); feedback('草稿已结束'); } } }
      if (action === 'roles' || action === 'read-preview') { panel.tab = action; render(); }
      if (action === 'manual' || action === 'edit' || action === 'edit-proposal') {
        const proposal = action === 'edit-proposal';
        const entry = action === 'manual' ? null : (proposal ? manager.proposals(chat) : chat.normalMemory.entries).find(e => e.id === button.dataset.id);
        if (action !== 'manual' && !entry) throw new Error('内容已经变化，请刷新查看');
        panel.editor = { kind: proposal ? 'proposal' : 'entry', id: entry?.id || null, text: entry?.text || '', status: entry?.status || 'fact', certainty: entry?.certainty || 'clear', eventTime: entry?.eventTime || '', sourceIds: entry?.sourceRefs.map(ref => ref.id) || [] };
        panel.tab = 'editor'; render();
      }
      if (action === 'save-editor') {
        const value = panel.editor;
        if (value.kind === 'proposal') await manager.editProposal(chat, value.id, value);
        else await manager.manual(chat, value, value.id);
        if (panel === session) { panel.tab = value.kind === 'proposal' ? 'proposals' : 'overview'; panel.editor = null; render(); feedback('已保存'); }
      }
      if (action === 'cancel-editor') { panel.tab = panel.editor?.kind === 'proposal' ? 'proposals' : 'overview'; panel.editor = null; render(); }
      if (action === 'remove') { if (await showCustomConfirm('移除概况', '仅移除这条概况，历史原文保留，可在记录中撤销。')) await manager.removeEntry(chat, button.dataset.id); }
      if (action === 'undo') { if (await showCustomConfirm('撤销记忆操作', '仅撤销本次概况变更，不回滚后来新增的历史。')) { await manager.undo(chat, button.dataset.id); if (panel === session) feedback('已撤销'); } }
      if (action === 'save-settings') { await manager.saveSettings(chat, panel.settingsDraft); if (panel === session) feedback('当前角色设置已保存'); }
      if (action === 'run-roles') {
        const ids = [...panel.roleIds];
        if (!ids.length) throw new Error('请选择角色');
        const count = ids.reduce((sum, key) => sum + (state.chats[key]?.longTermMemory?.length || 0), 0);
        if (!await showCustomConfirm('多角色记忆梳理', `将为${ids.length}个角色分别梳理共${count}条原始记忆，会调用总结接口。原文保留，结果由你选择应用。`)) return;
        panel.multiStop = false; panel.multiRunning = true;
        const failures = []; let done = 0;
        for (const key of ids) {
          if (session.multiStop || panel !== session) break;
          const target = state.chats[key]; if (!target) continue;
          feedback(`正在处理 ${target.name || target.originalName}（${done + 1}/${ids.length}）`);
          try { const task = await manager.start(target, null, session.instructions); if (task.status !== 'ready') break; done++; } catch (error) { failures.push(`${target.name}：${error.message}`); }
        }
        session.multiRunning = false;
        if (panel === session) { render(); feedback(`完成${done}个角色${failures.length ? `；${failures.join('；')}` : ''}`); }
      }
    } catch (error) { if (panel === session) feedback(error.message, true); }
    finally { if (lockButton && button.isConnected) button.disabled = false; }
  }
  manager.subscribe(chat => {
    const activeChat = typeof state !== 'undefined' ? state.chats[state.activeChatId] : null;
    if (activeChat && (activeChat.id === chat.id || activeChat.members?.some(m => m.id === chat.id))) manager.renderEntry(activeChat);
  });
  manager.open = open;
})();
