// ============================================================
// 通话记录/分享转发选择器 (原 script.js 第 31019~31282 行)
// ============================================================

  async function renderCallHistoryScreen() {
    showScreen('call-history-screen');

    const listEl = document.getElementById('call-history-list');
    const titleEl = document.getElementById('call-history-title');
    listEl.innerHTML = '';
    titleEl.textContent = '所有通话记录';

    const records = await db.callRecords.orderBy('timestamp').reverse().toArray();

    if (records.length === 0) {
      listEl.innerHTML = '<p style="text-align:center; color: var(--text-secondary); padding: 50px 0;">这里还没有通话记录哦~</p>';
      return;
    }

    records.forEach(record => {
      const card = createCallRecordCard(record);

      addLongPressListener(card, async () => {

        const newName = await showCustomPrompt(
          "自定义通话名称",
          "请输入新的名称（留空则恢复默认）",
          record.customName || ''
        );


        if (newName === null) return;


        await db.callRecords.update(record.id, {
          customName: newName.trim()
        });


        await renderCallHistoryScreen();


        await showCustomAlert('成功', '通话名称已更新！');
      });
      listEl.appendChild(card);
    });
  }



  function createCallRecordCard(record) {
    const card = document.createElement('div');
    card.className = 'call-record-card';
    card.dataset.recordId = record.id;

    const chatInfo = state.chats[record.chatId];
    const chatName = chatInfo ? chatInfo.name : '未知会话';

    const timestamp = Number.isFinite(new Date(record.timestamp).getTime()) ? new Date(record.timestamp).getTime() : Date.now();
    const callDate = new Date(timestamp);
    const dateString = `${callDate.getFullYear()}-${String(callDate.getMonth() + 1).padStart(2, '0')}-${String(callDate.getDate()).padStart(2, '0')} ${String(callDate.getHours()).padStart(2, '0')}:${String(callDate.getMinutes()).padStart(2, '0')}`;
    const duration = Math.max(0, Number(record.duration) || 0);
    const durationText = `${Math.floor(duration / 60)}分${Math.floor(duration % 60)}秒`;

    // 判断通话类型
    const callTypeIcon = record.callType === 'voice' ? '📞' : '📹';
    const callTypeText = record.callType === 'voice' ? '语音通话' : '视频通话';

    const avatarsHtml = (Array.isArray(record.participants) ? record.participants : []).map(p =>
      `<img src="${escapeHTML(String(p.avatar || ''))}" alt="${escapeHTML(String(p.name || ''))}" class="participant-avatar" title="${escapeHTML(String(p.name || ''))}">`
    ).join('');
    const statusText = record.status === 'interrupted'
      ? ' · 意外中断'
      : (record.status === 'active' ? ' · 进行中' : '');

    card.innerHTML = `
                <div class="card-header">
                    <span class="date">${callTypeIcon} ${dateString}</span>
                    <span class="duration">${durationText}</span>
                </div>
                <div class="card-body">
                    ${record.customName ? `<div class="custom-title">${escapeHTML(String(record.customName))}</div>` : ''}
                    
                    <div class="participants-info">
                        <div class="participants-avatars">${avatarsHtml}</div>
                        <span class="participants-names">与 ${escapeHTML(chatName)} 的${callTypeText}${statusText}</span>
                    </div>
                </div>
            `;
    return card;
  }



  async function showCallTranscript(recordId) {
    const record = await db.callRecords.get(recordId);
    if (!record) return;

    const modal = document.getElementById('call-transcript-modal');
    const titleEl = document.getElementById('transcript-modal-title');
    const bodyEl = document.getElementById('call-transcript-modal-body');

    const callTypeText = record.callType === 'voice' ? '语音通话' : '视频通话';
    const recordDate = Number.isFinite(new Date(record.timestamp).getTime()) ? new Date(record.timestamp) : new Date();
    const duration = Math.max(0, Number(record.duration) || 0);
    const statusText = record.status === 'interrupted'
      ? '，意外中断'
      : (record.status === 'active' ? '，进行中' : '');
    titleEl.textContent = `${callTypeText}于 ${recordDate.toLocaleString()} (时长: ${Math.floor(duration / 60)}分${Math.floor(duration % 60)}秒${statusText})`;
    bodyEl.innerHTML = '';

    const deleteBtn = document.getElementById('delete-transcript-btn');
    const summarizeBtn = document.getElementById('manual-summarize-btn');

    if (!record.transcript || record.transcript.length === 0) {
      bodyEl.innerHTML = '<p style="text-align:center; color: #8a8a8a;">这次通话没有留下文字记录。</p>';
      summarizeBtn.style.display = 'none';
    } else {
      summarizeBtn.style.display = 'block';
      record.transcript.forEach(entry => {
        const bubble = document.createElement('div');
        bubble.className = `transcript-entry ${entry.role}`;
        bubble.textContent = entry.content;
        bodyEl.appendChild(bubble);
      });
    }

    const newDeleteBtn = deleteBtn.cloneNode(true);
    deleteBtn.parentNode.replaceChild(newDeleteBtn, deleteBtn);
    const newSummarizeBtn = summarizeBtn.cloneNode(true);
    summarizeBtn.parentNode.replaceChild(newSummarizeBtn, summarizeBtn);

    newDeleteBtn.addEventListener('click', async () => {
      const confirmed = await showCustomConfirm(
        "确认删除", "确定要永久删除这条通话记录吗？此操作不可恢复。", {
        confirmButtonClass: 'btn-danger'
      }
      );
      if (confirmed) {
        modal.classList.remove('visible');
        await db.callRecords.delete(recordId);
        await renderCallHistoryScreen();
        alert('通话记录已删除。');
      }
    });



    newSummarizeBtn.addEventListener('click', async () => {

      const confirmed = await showCustomConfirm(
        '确认操作',
        '这将提取当前通话记录发送给AI进行总结，会消耗API额度。确定要继续吗？', {
        confirmText: '确认总结'
      }
      );


      if (!confirmed) return;

      modal.classList.remove('visible');
      const chat = state.chats[record.chatId];
      if (!chat) {
        alert('错误：找不到该通话记录所属的聊天对象。');
        return;
      }

      await showCustomAlert("请稍候...", "正在请求AI进行手动总结...");

      try {
        const transcriptText = record.transcript.map(h => {
          const sender = h.role === 'user' ? (chat.settings.myNickname || '我') : (h.senderName || chat.name);
          return `${sender}: ${h.content}`;
        }).join('\n');

        await summarizeCallTranscript(record.chatId, transcriptText);

        await showCustomAlert("总结成功", `手动总结已完成！新的记忆已添加到"${chat.name}"的长期记忆中。`);

      } catch (error) {
        await showCustomAlert("总结失败", `操作失败，未能生成长期记忆。\n\n错误详情: ${error.message}`);
      }
    });





    const closeBtn = document.getElementById('close-transcript-modal-btn');
    const newCloseBtn = closeBtn.cloneNode(true);
    closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);

    newCloseBtn.addEventListener('click', () => {
      modal.classList.remove('visible');
    });


    modal.classList.add('visible');
  }


  async function handleEditStatusClick() {

    if (!state.activeChatId || state.chats[state.activeChatId].isGroup) {
      return;
    }
    const chat = state.chats[state.activeChatId];


    const newStatusText = await showCustomPrompt(
      '编辑对方状态',
      '请输入对方现在的新状态：',
      chat.status.text
    );


    if (newStatusText !== null) {

      chat.status.text = newStatusText.trim() || '在线';
      chat.status.isBusy = false;
      chat.status.lastUpdate = Date.now();
      await db.chats.put(chat);


      renderChatInterface(state.activeChatId);
      renderChatList();


      await showCustomAlert('状态已更新', `"${chat.name}"的当前状态已更新为：${chat.status.text}`);
    }
  }


  async function openShareTargetPicker() {
    const modal = document.getElementById('share-target-modal');
    const listEl = document.getElementById('share-target-list');
    listEl.innerHTML = '';


    const chats = Object.values(state.chats);

    chats.forEach(chat => {

      const item = document.createElement('div');
      item.className = 'contact-picker-item';
      item.innerHTML = `
                    <input type="checkbox" class="share-target-checkbox" data-chat-id="${chat.id}" style="margin-right: 15px;">
                    <img src="${chat.isGroup ? chat.settings.groupAvatar : chat.settings.aiAvatar || defaultAvatar}" class="avatar">
                    <span class="name">${chat.name}</span>
                `;
      listEl.appendChild(item);
    });

    modal.classList.add('visible');
  }

  // ==================== 转发模块：状态管理与高级功能 ====================
  const getForwardingState = () => (typeof state !== 'undefined' && state) ? state : (window.state || {});

  // 选中的转发目标 ChatId 集合
  window.forwardSelectedTargetIds = window.forwardSelectedTargetIds || new Set();
  // 待转发的消息列表（支持微调勾选）
  window.forwardStagedMessages = window.forwardStagedMessages || [];
  // 选中的待转发消息时间戳集合
  window.forwardSelectedMsgTimestamps = window.forwardSelectedMsgTimestamps || new Set();
  // 转发自定义执行回调（例如豆瓣转发）
  window.forwardCustomHandler = null;

  // 获取与存储角色屏蔽名单 (LocalStorage 持久化)
  function getForwardBlockedChatIds() {
    try {
      const stored = localStorage.getItem('forward_blocked_chats');
      return stored ? JSON.parse(stored) : [];
    } catch (_) {
      return [];
    }
  }

  function setForwardBlockedChatIds(ids) {
    try {
      localStorage.setItem('forward_blocked_chats', JSON.stringify(ids));
    } catch (_) {}
  }

  // 获取排序方式
  function getForwardSortPreference() {
    return localStorage.getItem('forward_sort_preference') || 'recent';
  }

  function setForwardSortPreference(val) {
    localStorage.setItem('forward_sort_preference', val);
  }

  // 渲染联系人列表（带iOS滑动开关）
  function renderForwardContactList() {
    const listEl = document.getElementById('forward-target-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    const blockedIds = new Set(getForwardBlockedChatIds());
    const sortMode = getForwardSortPreference();
    const searchKeyword = (document.getElementById('forward-target-search-input')?.value || '').trim().toLowerCase();

    // 过滤掉被屏蔽的角色
    const appState = getForwardingState();
    let chats = Object.values(appState.chats || {}).filter(chat => !blockedIds.has(chat.id));

    // 排序逻辑
    if (sortMode === 'recent') {
      chats.sort((a, b) => {
        const lastTimeA = a.history && a.history.length > 0 ? (a.history[a.history.length - 1].timestamp || 0) : (a.createdAt || 0);
        const lastTimeB = b.history && b.history.length > 0 ? (b.history[b.history.length - 1].timestamp || 0) : (b.createdAt || 0);
        return lastTimeB - lastTimeA;
      });
    } else if (sortMode === 'name') {
      chats.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-CN'));
    } else if (sortMode === 'name-desc') {
      chats.sort((a, b) => (b.name || '').localeCompare(a.name || '', 'zh-CN'));
    } else if (sortMode === 'created') {
      chats.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }

    let visibleCount = 0;
    chats.forEach(chat => {
      const name = chat.name || '未命名角色';
      const searchName = name.toLowerCase();
      const isMatch = !searchKeyword || searchName.includes(searchKeyword);
      const isChecked = window.forwardSelectedTargetIds.has(chat.id);

      const avatar = chat.isGroup ? (chat.settings.groupAvatar || defaultAvatar) : (chat.settings.aiAvatar || defaultAvatar);
      const lastMsg = chat.history && chat.history.length > 0 ? chat.history[chat.history.length - 1] : null;
      let descText = chat.isGroup ? `群聊 · ${chat.members ? chat.members.length : 0}位成员` : (chat.settings.aiPersona ? chat.settings.aiPersona.substring(0, 20) + '...' : '单聊角色');
      if (lastMsg && lastMsg.content) {
        const snippet = typeof lastMsg.content === 'string' ? lastMsg.content : '[多媒体消息]';
        descText = snippet.replace(/<[^>]+>/g, '').substring(0, 24);
      }

      const row = document.createElement('div');
      row.className = `forward-contact-row ${isChecked ? 'is-active' : ''}`;
      row.dataset.chatId = chat.id;
      row.dataset.searchName = searchName;
      if (!isMatch) row.style.display = 'none';
      else visibleCount++;

      row.innerHTML = `
        <div class="forward-contact-left">
          <div class="forward-avatar-wrap">
            <img src="${escapeHTML(avatar)}" class="forward-contact-avatar" onerror="this.onerror=null; this.src=defaultAvatar;" alt="">
            ${chat.isGroup ? '<span class="forward-group-badge">群</span>' : ''}
          </div>
          <div class="forward-contact-meta">
            <div class="forward-contact-name">${escapeHTML(name)}</div>
            <div class="forward-contact-desc">${escapeHTML(descText)}</div>
          </div>
        </div>
        <label class="forward-switch">
          <input type="checkbox" class="forward-target-checkbox" data-chat-id="${chat.id}" ${isChecked ? 'checked' : ''}>
          <span class="forward-slider"></span>
        </label>
      `;

      const checkbox = row.querySelector('.forward-target-checkbox');
      const syncSelection = () => {
        if (checkbox.checked) {
          window.forwardSelectedTargetIds.add(chat.id);
          row.classList.add('is-active');
        } else {
          window.forwardSelectedTargetIds.delete(chat.id);
          row.classList.remove('is-active');
        }
        updateForwardSelectedCountBadge();
      };
      checkbox.addEventListener('change', syncSelection);
      row.addEventListener('click', (e) => {
        // label 会自行切换 input；只由 change 同步，避免点击滑块时切换两次。
        if (e.target.closest('.forward-switch')) return;
        checkbox.checked = !checkbox.checked;
        syncSelection();
      });

      listEl.appendChild(row);
    });

    if (visibleCount === 0) {
      listEl.innerHTML = `<div style="text-align: center; color: #94a3b8; padding: 40px 15px; font-size: 13px;">${blockedIds.size > 0 && chats.length === 0 ? '所有角色均已被屏蔽，请在右上角设置中管理' : '没有找到匹配的联系人'}</div>`;
    }

    updateForwardSelectedCountBadge();
  }

  function updateForwardSelectedCountBadge() {
    const badge = document.getElementById('forward-selected-count-badge');
    if (badge) {
      badge.textContent = `已选 ${window.forwardSelectedTargetIds.size}`;
    }
  }

  // 渲染屏蔽管理名单
  function renderForwardBlocklistModal() {
    const itemsEl = document.getElementById('forward-blocklist-items');
    if (!itemsEl) return;
    itemsEl.innerHTML = '';

    const blockedIds = window._tempBlockedIds || new Set(getForwardBlockedChatIds());
    const searchVal = (document.getElementById('forward-blocklist-search-input')?.value || '').trim().toLowerCase();
    const appState = getForwardingState();
    const chats = Object.values(appState.chats || {});

    chats.forEach(chat => {
      const name = chat.name || '未命名角色';
      if (searchVal && !name.toLowerCase().includes(searchVal)) return;

      const avatar = chat.isGroup ? (chat.settings.groupAvatar || defaultAvatar) : (chat.settings.aiAvatar || defaultAvatar);
      const isBlocked = blockedIds.has(chat.id);

      const item = document.createElement('div');
      item.className = 'forward-blocklist-item';
      item.innerHTML = `
        <div class="forward-blocklist-left">
          <img src="${escapeHTML(avatar)}" onerror="this.onerror=null; this.src=defaultAvatar;" alt="">
          <span class="forward-blocklist-name">${escapeHTML(name)}${chat.isGroup ? ' (群聊)' : ''}</span>
        </div>
        <label class="forward-switch">
          <input type="checkbox" class="forward-blocklist-toggle" data-chat-id="${chat.id}" ${isBlocked ? 'checked' : ''}>
          <span class="forward-slider" style="background-color: ${isBlocked ? '#e11d48' : '#e2e8f0'};"></span>
        </label>
      `;

      const toggle = item.querySelector('.forward-blocklist-toggle');
      const syncBlocked = () => {
        if (toggle.checked) {
          blockedIds.add(chat.id);
          // 如果已被选，自动移出转发选择
          window.forwardSelectedTargetIds.delete(chat.id);
        } else {
          blockedIds.delete(chat.id);
        }
        const slider = item.querySelector('.forward-slider');
        if (slider) slider.style.backgroundColor = toggle.checked ? '#e11d48' : '#e2e8f0';
      };
      toggle.addEventListener('change', syncBlocked);
      item.addEventListener('click', (e) => {
        if (e.target.closest('.forward-switch')) return;
        toggle.checked = !toggle.checked;
        syncBlocked();
      });

      itemsEl.appendChild(item);
    });

    window._tempBlockedIds = blockedIds;
  }

  // 进入二次确认步骤
  function showForwardConfirmStep() {
    if (window.forwardSelectedTargetIds.size === 0) {
      alert("请至少选择一个转发目标！");
      return;
    }

    const stepSelect = document.getElementById('forward-step-select');
    const stepConfirm = document.getElementById('forward-step-confirm');
    if (!stepSelect || !stepConfirm) return;

    stepSelect.style.display = 'none';
    stepConfirm.style.display = 'flex';

    // 1. 渲染接收目标胶囊
    renderConfirmTargets();

    // 2. 渲染转发消息勾选微调列表
    renderConfirmMessages();
  }

  function renderConfirmTargets() {
    const wrap = document.getElementById('forward-confirm-targets-wrap');
    const countEl = document.getElementById('forward-confirm-target-count');
    if (!wrap) return;
    wrap.innerHTML = '';

    countEl.textContent = window.forwardSelectedTargetIds.size;

    const appState = getForwardingState();
    window.forwardSelectedTargetIds.forEach(targetId => {
      const chat = appState.chats ? appState.chats[targetId] : null;
      if (!chat) return;

      const avatar = chat.isGroup ? (chat.settings.groupAvatar || defaultAvatar) : (chat.settings.aiAvatar || defaultAvatar);
      const chip = document.createElement('div');
      chip.className = 'forward-target-chip';
      chip.dataset.targetId = chat.id;
      chip.innerHTML = `
        <img src="${escapeHTML(avatar)}" onerror="this.onerror=null; this.src=defaultAvatar;" alt="">
        <span class="forward-target-chip-name" title="${escapeHTML(chat.name)}">${escapeHTML(chat.name)}</span>
        <button type="button" class="forward-target-chip-remove" title="移除此目标">×</button>
      `;

      chip.querySelector('.forward-target-chip-remove').addEventListener('click', (e) => {
        e.stopPropagation();
        window.forwardSelectedTargetIds.delete(chat.id);
        chip.remove();
        countEl.textContent = window.forwardSelectedTargetIds.size;
        updateForwardSelectedCountBadge();
        if (window.forwardSelectedTargetIds.size === 0) {
          alert("已移除全部目标，请返回重新选择！");
          backToStepSelect();
        }
      });

      wrap.appendChild(chip);
    });
  }

  function renderConfirmMessages() {
    const listEl = document.getElementById('forward-confirm-messages-list');
    const countEl = document.getElementById('forward-confirm-msg-count');
    if (!listEl) return;
    listEl.innerHTML = '';

    const appState = getForwardingState();
    const sourceChat = (appState.chats && appState.activeChatId) ? appState.chats[appState.activeChatId] : null;
    
    // 如果是自定义转发（如豆瓣），显示特殊单条或多条卡片
    if (window.forwardCustomHandler) {
      countEl.textContent = '1';
      listEl.innerHTML = `
        <div class="forward-confirm-msg-item selected">
          <input type="checkbox" class="forward-confirm-msg-cb" checked disabled>
          <div class="forward-confirm-msg-content">
            <div class="forward-confirm-msg-author">外部内容</div>
            <div class="forward-confirm-msg-text">豆瓣帖子 / 讨论内容已打包准备就绪</div>
          </div>
        </div>
      `;
      return;
    }

    // 默认聊天记录多选
    if (window.forwardStagedMessages.length === 0) {
      if (typeof selectedMessages !== 'undefined' && selectedMessages.size > 0 && sourceChat) {
        const sorted = [...selectedMessages].sort((a, b) => a - b);
        window.forwardStagedMessages = sorted.map(ts => sourceChat.history.find(m => m.timestamp === ts)).filter(Boolean);
        window.forwardSelectedMsgTimestamps = new Set(sorted);
      }
    }

    countEl.textContent = window.forwardSelectedMsgTimestamps.size;

    if (window.forwardStagedMessages.length === 0) {
      listEl.innerHTML = `<div style="text-align:center; color:#94a3b8; padding: 20px;">没有待转发的消息记录</div>`;
      return;
    }

    window.forwardStagedMessages.forEach((msg, idx) => {
      const isChecked = window.forwardSelectedMsgTimestamps.has(msg.timestamp);
      let sender = msg.role === 'user' ? '我' : (msg.senderName || sourceChat?.name || '对方');
      let previewText = '';
      if (typeof msg.content === 'string') {
        previewText = msg.content;
      } else if (Array.isArray(msg.content)) {
        previewText = '[多媒体消息]';
      } else if (msg.type) {
        previewText = `[${msg.type}]`;
      }
      previewText = previewText.replace(/<[^>]+>/g, '').trim() || '(内容为空)';

      const item = document.createElement('div');
      item.className = `forward-confirm-msg-item ${isChecked ? 'selected' : ''}`;
      item.innerHTML = `
        <input type="checkbox" class="forward-confirm-msg-cb" data-ts="${msg.timestamp}" ${isChecked ? 'checked' : ''}>
        <div class="forward-confirm-msg-content">
          <div class="forward-confirm-msg-author">#${idx + 1} · ${escapeHTML(sender)}</div>
          <div class="forward-confirm-msg-text">${escapeHTML(previewText)}</div>
        </div>
      `;

      item.addEventListener('click', (e) => {
        const cb = item.querySelector('.forward-confirm-msg-cb');
        if (e.target !== cb) {
          cb.checked = !cb.checked;
        }
        if (cb.checked) {
          window.forwardSelectedMsgTimestamps.add(msg.timestamp);
          item.classList.add('selected');
        } else {
          window.forwardSelectedMsgTimestamps.delete(msg.timestamp);
          item.classList.remove('selected');
        }
        countEl.textContent = window.forwardSelectedMsgTimestamps.size;
      });

      listEl.appendChild(item);
    });
  }

  function backToStepSelect() {
    const stepSelect = document.getElementById('forward-step-select');
    const stepConfirm = document.getElementById('forward-step-confirm');
    if (!stepSelect || !stepConfirm) return;
    stepConfirm.style.display = 'none';
    stepSelect.style.display = 'flex';
    renderForwardContactList();
  }

  // 最终执行转发
  async function executeFinalForward() {
    const blockedIds = new Set(getForwardBlockedChatIds());
    const selectedTargetIds = Array.from(window.forwardSelectedTargetIds).filter(id => !blockedIds.has(id));
    if (selectedTargetIds.length === 0) {
      alert("请至少选择一个未屏蔽的接收目标！");
      return;
    }

    // 自定义转发钩子（豆瓣）
    if (window.forwardCustomHandler) {
      const handler = window.forwardCustomHandler;
      window.forwardCustomHandler = null;
      await handler(selectedTargetIds);
      closeForwardModal();
      return;
    }

    if (window.forwardSelectedMsgTimestamps.size === 0) {
      alert("请至少勾选一条要转发的消息！");
      return;
    }

    const appState = getForwardingState();
    const sourceChat = (appState.chats && appState.activeChatId) ? appState.chats[appState.activeChatId] : null;
    if (!sourceChat) return;

    const sortedTimestamps = Array.from(window.forwardSelectedMsgTimestamps).sort((a, b) => a - b);

    for (const targetId of selectedTargetIds) {
      const targetChat = appState.chats ? appState.chats[targetId] : null;
      if (!targetChat) continue;

      for (const timestamp of sortedTimestamps) {
        const msg = sourceChat.history.find(m => m.timestamp === timestamp);
        if (!msg) continue;

        const forwardedMessage = {
          role: 'user',
          senderName: targetChat.isGroup ? (targetChat.settings.myNickname || '我') : '我',
          content: msg.content,
          timestamp: Date.now() + sortedTimestamps.indexOf(timestamp),
        };

        if (msg.type) {
          forwardedMessage.type = msg.type;
          if (msg.type === 'voice_message') {
            forwardedMessage.content = msg.content;
          } else if (msg.type === 'ai_image') {
            forwardedMessage.content = msg.content;
          } else if (msg.type === 'naiimag' || msg.type === 'googleimag' || msg.type === 'openaiimag') {
            forwardedMessage.imageUrl = msg.imageUrl;
            forwardedMessage.prompt = msg.prompt;
            forwardedMessage.fullPrompt = msg.fullPrompt;
            if (msg.model) forwardedMessage.model = msg.model;
            if (msg.mimeType) forwardedMessage.mimeType = msg.mimeType;
          } else if (msg.type === 'transfer') {
            forwardedMessage.amount = msg.amount;
            forwardedMessage.note = msg.note;
          } else if (msg.type === 'share_link') {
            forwardedMessage.title = msg.title;
            forwardedMessage.description = msg.description;
            forwardedMessage.source_name = msg.source_name;
            forwardedMessage.content = msg.content;
          } else if (msg.type === 'red_packet') {
            forwardedMessage.totalAmount = msg.totalAmount;
            forwardedMessage.count = msg.count;
            forwardedMessage.message = msg.message;
            forwardedMessage.claimed = [];
          } else if (msg.type === 'location_share') {
            forwardedMessage.latitude = msg.latitude;
            forwardedMessage.longitude = msg.longitude;
            forwardedMessage.locationName = msg.locationName;
          }
        }

        targetChat.history.push(forwardedMessage);
      }

      await db.chats.put(targetChat);
    }

    closeForwardModal();
    if (typeof exitSelectionMode === 'function') {
      exitSelectionMode();
    }
    await showCustomAlert("转发成功", `已成功将 ${sortedTimestamps.length} 条消息转发到 ${selectedTargetIds.length} 个会话中。`);
    renderChatList();
  }

  function closeForwardModal() {
    const modal = document.getElementById('forward-target-modal');
    if (modal) modal.classList.remove('visible');
    window.forwardSelectedTargetIds.clear();
    window.forwardStagedMessages = [];
    window.forwardSelectedMsgTimestamps.clear();
    window.forwardCustomHandler = null;
  }

  // 初始化转发弹窗一次性绑定
  function initForwardPickerEventsOnce() {
    if (window._forwardPickerEventsBound) return;
    window._forwardPickerEventsBound = true;

    // 搜索输入过滤
    const searchInput = document.getElementById('forward-target-search-input');
    const searchClear = document.getElementById('forward-search-clear-btn');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        const val = e.target.value.trim();
        if (searchClear) searchClear.style.display = val ? 'flex' : 'none';
        renderForwardContactList();
      });
    }
    if (searchClear && searchInput) {
      searchClear.addEventListener('click', () => {
        searchInput.value = '';
        searchClear.style.display = 'none';
        renderForwardContactList();
        searchInput.focus();
      });
    }

    // 排序切换
    const sortSelect = document.getElementById('forward-sort-select');
    if (sortSelect) {
      sortSelect.value = getForwardSortPreference();
      sortSelect.addEventListener('change', (e) => {
        setForwardSortPreference(e.target.value);
        renderForwardContactList();
      });
    }

    // 全选/清空
    document.getElementById('forward-select-all-btn')?.addEventListener('click', () => {
      const blockedIds = new Set(getForwardBlockedChatIds());
      const appState = getForwardingState();
      const searchKeyword = (document.getElementById('forward-target-search-input')?.value || '').trim().toLowerCase();
      Object.values(appState.chats || {}).forEach(chat => {
        if (!blockedIds.has(chat.id) && (!searchKeyword || (chat.name || '未命名角色').toLowerCase().includes(searchKeyword))) {
          window.forwardSelectedTargetIds.add(chat.id);
        }
      });
      renderForwardContactList();
    });

    document.getElementById('forward-clear-all-btn')?.addEventListener('click', () => {
      window.forwardSelectedTargetIds.clear();
      renderForwardContactList();
    });

    // 步骤1：下一步
    document.getElementById('confirm-forward-target-btn')?.addEventListener('click', () => {
      showForwardConfirmStep();
    });

    // 步骤2：返回上一步
    document.getElementById('forward-back-step1-btn')?.addEventListener('click', backToStepSelect);
    document.getElementById('forward-confirm-back-btn')?.addEventListener('click', backToStepSelect);

    // 步骤2：全选/反选消息
    document.getElementById('forward-msg-select-all-btn')?.addEventListener('click', () => {
      window.forwardStagedMessages.forEach(m => window.forwardSelectedMsgTimestamps.add(m.timestamp));
      renderConfirmMessages();
    });

    document.getElementById('forward-msg-reverse-btn')?.addEventListener('click', () => {
      window.forwardStagedMessages.forEach(m => {
        if (window.forwardSelectedMsgTimestamps.has(m.timestamp)) {
          window.forwardSelectedMsgTimestamps.delete(m.timestamp);
        } else {
          window.forwardSelectedMsgTimestamps.add(m.timestamp);
        }
      });
      renderConfirmMessages();
    });

    // 步骤2：确认最终发送
    document.getElementById('forward-final-send-btn')?.addEventListener('click', executeFinalForward);

    // 关闭弹窗
    document.getElementById('cancel-forward-target-btn')?.addEventListener('click', closeForwardModal);
    document.getElementById('forward-modal-close-x')?.addEventListener('click', closeForwardModal);

    // 屏蔽管理弹窗
    const blockModal = document.getElementById('forward-blocklist-modal');
    document.getElementById('forward-open-blocklist-btn')?.addEventListener('click', () => {
      if (blockModal) {
        window._tempBlockedIds = new Set(getForwardBlockedChatIds());
        renderForwardBlocklistModal();
        blockModal.classList.add('visible');
      }
    });

    document.getElementById('forward-blocklist-close-x')?.addEventListener('click', () => {
      if (blockModal) blockModal.classList.remove('visible');
    });

    document.getElementById('forward-blocklist-search-input')?.addEventListener('input', () => {
      renderForwardBlocklistModal();
    });

    document.getElementById('forward-blocklist-save-btn')?.addEventListener('click', () => {
      if (window._tempBlockedIds) {
        setForwardBlockedChatIds(Array.from(window._tempBlockedIds));
        window._tempBlockedIds = null;
        showToast('防手滑屏蔽名单已保存！', 'success');
      }
      if (blockModal) blockModal.classList.remove('visible');
      renderForwardContactList();
    });
  }

  // 打开转发选择器主入口
  async function openForwardTargetPicker(options = {}) {
    const modal = document.getElementById('forward-target-modal');
    if (!modal) return;

    // 重置步骤到步骤1
    const stepSelect = document.getElementById('forward-step-select');
    const stepConfirm = document.getElementById('forward-step-confirm');
    if (stepSelect && stepConfirm) {
      stepSelect.style.display = 'flex';
      stepConfirm.style.display = 'none';
    }

    // 重置状态
    window.forwardSelectedTargetIds = new Set();
    window.forwardStagedMessages = [];
    window.forwardSelectedMsgTimestamps = new Set();
    window.forwardCustomHandler = options.customHandler || null;

    // 清空搜索框
    const searchInput = document.getElementById('forward-target-search-input');
    if (searchInput) searchInput.value = '';
    const searchClear = document.getElementById('forward-search-clear-btn');
    if (searchClear) searchClear.style.display = 'none';

    // 预填选中的消息
    const appState = getForwardingState();
    if (options.messages && Array.isArray(options.messages)) {
      window.forwardStagedMessages = [...options.messages];
      window.forwardSelectedMsgTimestamps = new Set(options.messages.map(m => m.timestamp));
    } else if (typeof selectedMessages !== 'undefined' && selectedMessages.size > 0 && appState.activeChatId) {
      const sourceChat = appState.chats ? appState.chats[appState.activeChatId] : null;
      if (sourceChat) {
        const sorted = [...selectedMessages].sort((a, b) => a - b);
        window.forwardStagedMessages = sorted.map(ts => sourceChat.history.find(m => m.timestamp === ts)).filter(Boolean);
        window.forwardSelectedMsgTimestamps = new Set(sorted);
      }
    }

    initForwardPickerEventsOnce();
    renderForwardContactList();

    modal.classList.add('visible');
  }

  window.openForwardTargetPicker = openForwardTargetPicker;
