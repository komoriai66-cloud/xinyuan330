// ==================== 向量记忆 - 旧记忆转换 (支持多选及结构化记忆) ====================

async function doSmartConvertWithAI(chat, allItems, selectedIndices, keepOriginal) {
  const manager = window.vectorMemoryManager;
  if (manager._extractionLocks.get(chat)) { showToast('这个聊天正在提取或转换，请等待当前任务结束', 'info'); return; }
  manager._extractionLocks.set(chat, { type: 'conversion' });
  try { return await performSmartMemoryConversion(chat, allItems, selectedIndices, keepOriginal); }
  finally { manager._extractionLocks.delete(chat); }
}

async function performSmartMemoryConversion(chat, allItems, selectedIndices, keepOriginal) {
  const totalItems = selectedIndices.length;
  const extractionSettings = window.vectorMemoryManager.getVariableMemory(chat).settings;
  const BATCH_SIZE = extractionSettings.extractionBatchEnabled === true ? extractionSettings.extractionBatchSize : Math.max(1, totalItems);
  if (!Number.isSafeInteger(BATCH_SIZE) || BATCH_SIZE < 1 || BATCH_SIZE > 9999 && extractionSettings.extractionBatchEnabled) throw new Error('每批消息数量请输入1～9999之间的整数');
  const totalBatches = Math.ceil(totalItems / BATCH_SIZE);
  
  const userNickname = chat.settings.myNickname || '用户';
  const apiConfig = window.state.apiConfig;
  const useSecondary = apiConfig.secondaryProxyUrl && apiConfig.secondaryApiKey && apiConfig.secondaryModel;
  const proxyUrl = useSecondary ? apiConfig.secondaryProxyUrl : apiConfig.proxyUrl;
  const apiKey = useSecondary ? apiConfig.secondaryApiKey : apiConfig.apiKey;
  const model = useSecondary ? apiConfig.secondaryModel : apiConfig.model;
  
  if (!proxyUrl || !apiKey || !model) {
    showToast('API未配置，无法进行智能转换', 'error');
    return;
  }

  let progressToast = showToast(`智能转换中... 0/${totalBatches}批`, 'info', 0);
  let successCount = 0;
  let failCount = 0;
  let structuredToDelete = {};
  let longTermToDelete = [];

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const startIdx = batchIdx * BATCH_SIZE;
    const endIdx = Math.min(startIdx + BATCH_SIZE, totalItems);
    const batchIndices = selectedIndices.slice(startIdx, endIdx);
    const currentVm = window.vectorMemoryManager.getVariableMemory(chat);
    const fragmentCheckpoint = JSON.parse(JSON.stringify(currentVm.fragments));
    const savedSuccessCount = successCount;
    
    // 构造当前批次的文本
    const formattedMemories = batchIndices.map((idx, i) => {
      const item = allItems[idx];
      const timeStr = item.timestamp ? new Date(item.timestamp).toLocaleString('zh-CN') : '过去';
      return `[消息${i + 1}] (${timeStr}) ${item.content}`;
    }).join('\n');

    const prompt = `
你是一个专业的记忆整理专家。请将以下来自用户和AI角色"${chat.originalName || chat.name}"的【杂乱旧记忆】，重新精炼、合并重复项，并分配到最合适的分类中。

# 输出格式（严格遵守JSON数组）
\`\`\`json
[
  {
    "content": "记忆内容（第一人称，简短清晰，如：我发现用户讨厌吃香菜）",
    "sourceLanguage": "zh/en/mixed/unknown",
    "conversationLanguages": ["语言代码"],
    "localizedContent": {"zh": "忠实中文表达", "en": "faithful English rendering"},
    "retrievalText": "原文词、中英同义词、英文词形和实体别名",
    "tags": ["原文关键词", "English keyword", "中文关键词"],
    "entities": [{"type": "person/place/item/event/work/organization/other", "canonical": "原文规范名", "aliases": ["可靠别名"]}],
    "polarity": "positive/negative",
    "status": "fact/plan/wish/ongoing/completed/cancelled",
    "category": "U/A/R/E/I/L/P/T/M/C",
    "importance": 1-10,
    "emotionalWeight": 1-10,
    "memoryTime": null,
    "sourceMessageIds": [1],
    "timeBasis": "explicit/unknown"
  }
]
\`\`\`

# 10大精细分类说明
- U = 用户设定 (用户的外貌/性格/喜好/身份等)
- A = 角色设定 (你自己发生的改变)
- R = 关系发展 (表白/吵架/亲密举动等里程碑)
- E = 经历/事件 (共同经历的事情)
- I = 物品/礼物 (送礼/买东西)
- L = 地点/场景 (去过的重要地方)
- P = 承诺/计划 (约定的未来事项)
- T = 禁忌/规则 (雷区/规矩)
- M = 情绪/心理 (强烈的情感流露/阴影)
- C = 核心灵魂 (极其罕见，必须永远铭记的生死攸关的事/绝对底线)

# 评分规则 (1-10)
- importance: 8-10(极其重要)，5-7(值得记住)，1-4(日常琐碎)
- emotionalWeight: 情感的强烈程度。

# 多语言规则
- content 跟随原记忆主要语言；英文记忆使用英文正文，中文记忆使用中文正文。
- retrievalText 与 tags 同时保留原文词及中英检索词。
- 人名、昵称、地点、作品、品牌、组织等专有名词保留原文。
- localizedContent 只能忠实翻译原事实，不能补充新信息。
- 明确区分否定、愿望、计划、进行中和已完成事实。

# 待处理的旧记忆
${formattedMemories}

每条输出sourceMessageIds（对应消息编号）、timeBasis（explicit/unknown）。原文中的[YYMMDD]、(YYMMDD)或[YYMM][DD]才是事件日期；外层时间可能是总结写入时间，不能当作发生日期。没有依据时memoryTime为null，不猜今天。

注意：你可以将意思重复的几条记忆合并为一条更精炼的记忆。如果没有意义的内容可以直接丢弃。请直接输出JSON数组。`;

    try {
      const isGemini = proxyUrl === window.GEMINI_API_URL;
      let data;
      if (isGemini && typeof toGeminiRequestData === 'function') {
        const geminiConfig = toGeminiRequestData(model, apiKey, prompt, [{ role: 'user', content: '请开始智能转换。' }]);
        data = await window.MemoryExtractionSupport.requestData(geminiConfig.url, geminiConfig.data);
      } else {
        data = await window.MemoryExtractionSupport.requestData(`${proxyUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({ model, messages: [{ role: 'system', content: prompt }, { role: 'user', content: '请开始智能转换。' }], temperature: 0.3 })
        });
      }

      if (['length', 'MAX_TOKENS', 'SAFETY', 'content_filter'].includes(data.choices?.[0]?.finish_reason || data.candidates?.[0]?.finishReason)) throw new Error('转换输出不完整，未保存本批结果');
      const rawText = typeof getGeminiResponseText === 'function' ? getGeminiResponseText(data) : (data.choices?.[0]?.message?.content || '');

      const sourceItems = batchIndices.map(index => ({ timestamp: allItems[index].timestamp, content: allItems[index].content }));
      const extracted = window.vectorMemoryManager.parseExtractionResult(rawText).map(item => ({
        ...item, ...window.MemoryExtractionSupport.resolveTime(item, sourceItems)
      }));
      
      for (const item of extracted) {
        const vm = window.vectorMemoryManager.getVariableMemory(chat);
        const duplicate = vm.fragments.some(fragment => window.vectorMemoryManager._isLikelyDuplicate(chat, item, fragment));
        if (duplicate) continue;
        const embeddingText = window.vectorMemoryManager._embeddingTextFor(chat, item);
        const embedding = await window.vectorMemoryManager.getEmbedding(embeddingText, chat);
        window.vectorMemoryManager.createFragment(chat, {
          ...item,
          embedding,
          embeddingSignature: embedding ? window.vectorMemoryManager._embeddingSignature(chat) : '',
          embeddingTextHash: embedding ? window.vectorMemoryManager._hashEmbeddingText(embeddingText) : '',
          memoryTime: item.memoryTime,
          source: 'smart_convert'
        });
        successCount++;
      }
      await db.chats.put(chat);

      // 记录要删除的原条目
      if (!keepOriginal && extracted.length > 0) {
        const referenced = new Set(extracted.flatMap(item => item.sourceMessageIds || []));
        batchIndices.filter((_, index) => referenced.has(index + 1)).forEach(idx => {
          const item = allItems[idx];
          if (item.type === 'longTerm') {
            longTermToDelete.push({ authorId: item.authorId, id: item.id });
          } else if (item.type === 'structured') {
            if (!structuredToDelete[item.categoryCode]) structuredToDelete[item.categoryCode] = [];
            structuredToDelete[item.categoryCode].push(item.id);
          }
        });
      }

    } catch (e) {
      console.error(`智能转换批次 ${batchIdx+1} 失败:`, e);
      currentVm.fragments = fragmentCheckpoint;
      currentVm.stats.totalFragments = fragmentCheckpoint.length;
      successCount = savedSuccessCount;
      failCount = totalItems - startIdx;
      showToast(`转换停止：${e.message}。已成功保存的部分保留，未完成部分没有自动重试。`, 'error', 5000);
      break;
    }
    
    if (progressToast) {
      const el = document.querySelector('.toast:last-child');
      if (el) el.textContent = `智能转换中... ${batchIdx+1}/${totalBatches}批 (精炼出: ${successCount}条)`;
    }
  }

  // 删除逻辑
  if (!keepOriginal) {
    if (longTermToDelete.length > 0) {
      const delByAuthor = {};
      longTermToDelete.forEach(info => {
        if (!delByAuthor[info.authorId]) delByAuthor[info.authorId] = [];
        delByAuthor[info.authorId].push(info.id);
      });
      for (const authorId in delByAuthor) {
        const authorChat = state.chats[authorId];
        if (authorChat && authorChat.longTermMemory) {
          delByAuthor[authorId].sort((a, b) => b - a);
          delByAuthor[authorId].forEach(idx => authorChat.longTermMemory.splice(idx, 1));
          if (authorId !== chat.id) {
            db.chats.put(authorChat);
          }
        }
      }
    }
    if (Object.keys(structuredToDelete).length > 0 && window.structuredMemoryManager) {
      const mem = window.structuredMemoryManager.getStructuredMemory(chat);
      if (structuredToDelete['F']) {
         structuredToDelete['F'].forEach(strId => { const k = strId.substring(2); delete mem.facts[k]; });
      }
      if (structuredToDelete['R']) mem.relationship = '';
      if (structuredToDelete['E']) {
         let eventMap = {}; 
         for (const ym of Object.keys(mem.events)) {
           eventMap[ym] = mem.events[ym].split('|');
         }
         const eIds = structuredToDelete['E'].map(id => id.split('_'));
         eIds.sort((a, b) => parseInt(b[2]) - parseInt(a[2]));
         eIds.forEach(parts => {
           const ym = parts[1];
           const idx = parseInt(parts[2]);
           if (eventMap[ym]) eventMap[ym].splice(idx, 1);
         });
         mem.events = {};
         for (const ym of Object.keys(eventMap)) {
           if (eventMap[ym].length > 0) mem.events[ym] = eventMap[ym].join('|');
         }
      }
      if (structuredToDelete['P']) {
         const pIds = structuredToDelete['P'].map(id => parseInt(id.substring(2))).sort((a, b) => b - a);
         pIds.forEach(idx => mem.plans.splice(idx, 1));
      }
      if (structuredToDelete['D']) {
         const dIds = structuredToDelete['D'].map(id => parseInt(id.substring(2))).sort((a, b) => b - a);
         dIds.forEach(idx => mem.decisions.splice(idx, 1));
      }
      if (structuredToDelete['M']) {
         const mIds = structuredToDelete['M'].map(id => parseInt(id.substring(2))).sort((a, b) => b - a);
         mIds.forEach(idx => mem.emotions.splice(idx, 1));
      }
      for (const [code, cat] of Object.entries(mem._customCategories || {})) {
        if (structuredToDelete[code]) {
          const cIds = structuredToDelete[code].map(id => parseInt(id.split('_')[2])).sort((a, b) => b - a);
          cIds.forEach(idx => {
            if (mem._custom[code]) mem._custom[code].splice(idx, 1);
          });
        }
      }
    }
  }

  await db.chats.put(chat);
  if (progressToast) document.querySelectorAll('.toast').forEach(el => el.remove());
  showToast(failCount ? `转换未完成：已保存${successCount}条，剩余${failCount}条旧记忆保留` : `智能转换完成：保存${successCount}条记忆`, failCount ? 'info' : 'success', 5000);
  
  if (document.getElementById('vector-memory-container')?.style.display !== 'none') {
    if (typeof renderVectorMemoryView === 'function') renderVectorMemoryView();
  }
}

async function convertLongTermMemoryToVector(chatId) {
  const chat = state.chats[chatId];
  if (!chat || !window.vectorMemoryManager) {
    showToast('模块未加载', 'warning');
    return;
  }

  let items = [];
  const formatDate = (ts) => {
    if (!ts) return '未知时间';
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  };
  const monthTimestamp = (yearMonth) => {
    const compact = String(yearMonth || '').match(/^(\d{2})(\d{2})$/);
    if (compact) return new Date(2000 + Number(compact[1]), Number(compact[2]) - 1, 1, 12).getTime();
    const match = String(yearMonth || '').match(/(\d{4})[-/.年](\d{1,2})/);
    return match ? new Date(Number(match[1]), Number(match[2]) - 1, 1, 12).getTime() : undefined;
  };

  // 1. 提取旧的长期记忆
  if (chat.isGroup) {
    chat.members.forEach(member => {
      const memberChat = state.chats[member.id];
      if (memberChat && memberChat.longTermMemory && memberChat.longTermMemory.length > 0) {
        memberChat.longTermMemory.forEach((mem, idx) => {
          items.push({
            type: 'longTerm',
            authorId: member.id,
            content: mem.content,
            timestamp: mem.timestamp || Date.now(),
            categoryCode: 'E',
            mappedCategory: 'E',
            id: idx,
            displayLabel: `[${formatDate(mem.timestamp)}] [长期记忆] (${member.groupNickname}) ` + mem.content
          });
        });
      }
    });
  }
  if (chat.longTermMemory && chat.longTermMemory.length > 0) {
    chat.longTermMemory.forEach((mem, idx) => {
      items.push({
        type: 'longTerm',
        authorId: chat.id,
        content: mem.content,
        timestamp: mem.timestamp || Date.now(),
        categoryCode: 'E',
        mappedCategory: 'E',
        id: idx,
        displayLabel: `[${formatDate(mem.timestamp)}] [长期记忆] ` + mem.content
      });
    });
  }

  // 2. 提取结构化记忆
  if (window.structuredMemoryManager && chat.structuredMemory) {
    const mem = window.structuredMemoryManager.getStructuredMemory(chat);
    
    for (const [k, v] of Object.entries(mem.facts)) {
      items.push({ type: 'structured', categoryCode: 'F', mappedCategory: 'U', content: `${k} = ${v}`, id: `F_${k}`, displayLabel: '[偏好/事实] ' + `${k} = ${v}` });
    }
    if (mem.relationship) {
      items.push({ type: 'structured', categoryCode: 'R', mappedCategory: 'R', content: mem.relationship, id: 'R_relationship', displayLabel: '[关系] ' + mem.relationship });
    }
    for (const ym of Object.keys(mem.events)) {
      const evts = mem.events[ym].split('|');
      evts.forEach((evt, idx) => {
        items.push({ type: 'structured', categoryCode: 'E', mappedCategory: 'E', content: `[${ym}] ${evt}`, timestamp: monthTimestamp(ym), id: `E_${ym}_${idx}`, displayLabel: '[事件] ' + `[${ym}] ${evt}` });
      });
    }
    mem.plans.forEach((p, idx) => {
      items.push({ type: 'structured', categoryCode: 'P', mappedCategory: 'P', content: p, id: `P_${idx}`, displayLabel: '[计划] ' + p });
    });
    mem.decisions.forEach((d, idx) => {
      items.push({ type: 'structured', categoryCode: 'D', mappedCategory: 'E', content: d, id: `D_${idx}`, displayLabel: '[决定] ' + d });
    });
    mem.emotions.forEach((e, idx) => {
      items.push({ type: 'structured', categoryCode: 'M', mappedCategory: 'M', content: e, id: `M_${idx}`, displayLabel: '[情绪] ' + e });
    });
    for (const [code, cat] of Object.entries(mem._customCategories || {})) {
      const list = mem._custom[code] || [];
      list.forEach((item, idx) => {
        items.push({ type: 'structured', categoryCode: code, mappedCategory: 'E', content: item, id: `C_${code}_${idx}`, displayLabel: `[${cat.name || code}] ` + item });
      });
    }
  }

  // 按时间降序排序
  items.sort((a, b) => {
    const tA = a.timestamp || 0;
    const tB = b.timestamp || 0;
    return tB - tA;
  });

  if (items.length === 0) {
    showToast('没有可转换的旧版记忆或结构化记忆', 'warning');
    return;
  }

  // 构建多选列表弹窗
  return new Promise(resolve => {
    window._modalResolve = resolve;
    window._modalTitle.textContent = '记忆转换中心 (升级为变量记忆)';
    
    let listHtml = items.map((item, index) => {
      return `
        <div style="margin-bottom: 8px; padding: 10px; background: var(--secondary-bg, #f5f5f5); border-radius: 8px; border: 1px solid var(--border-color, #eee); box-sizing: border-box; width: 100%;">
          <label style="display: flex; align-items: flex-start; cursor: pointer; margin: 0; line-height: 1.5; width: 100%;">
            <input type="checkbox" class="memory-convert-checkbox" data-index="${index}" style="margin-right: 10px; margin-top: 2px; flex-shrink: 0; width: 16px; height: 16px;" checked>
            <div style="flex: 1; min-width: 0; font-size: 13px; color: var(--text-color, #333); text-align: left; word-break: break-word; white-space: pre-wrap;">
              ${window.vectorMemoryManager._escapeHtml(item.displayLabel)}
            </div>
          </label>
        </div>
      `;
    }).join('');

    window._modalBody.innerHTML = `
      <div style="width: 100%; text-align: left; box-sizing: border-box;">
        <div style="margin-bottom: 15px; color: var(--text-secondary, #666); font-size: 13px; line-height: 1.5; padding: 0 5px;">
          检测到 <strong>${items.length}</strong> 条可转换的记忆。将它们转换成变量记忆后，AI 能更智能地在对话中检索它们。<br>
          <span style="color:#ff9500; font-size:12px; display: inline-block; margin-top: 5px;">注：即使没配 Embedding API，也会无缝转为强大的 BM25 本地检索！不消耗额度。</span>
        </div>
        <div style="display: flex; justify-content: flex-start; margin-bottom: 10px; padding: 0 5px;">
          <label style="font-size: 13px; cursor: pointer; display: flex; align-items: center; white-space: nowrap;">
            <input type="checkbox" id="convert-select-all" checked style="margin-right: 8px; flex-shrink: 0; width: 16px; height: 16px;"> <strong>全选</strong>
          </label>
        </div>
        <div style="max-height: 40vh; overflow-y: auto; overflow-x: hidden; margin-bottom: 15px; border-top: 1px solid var(--border-color, #eee); border-bottom: 1px solid var(--border-color, #eee); padding: 10px 5px; box-sizing: border-box;">
          ${listHtml}
        </div>
        <label style="display: flex; align-items: flex-start; cursor: pointer; margin-top: 10px; padding: 12px; background: rgba(255, 149, 0, 0.08); border: 1px solid rgba(255, 149, 0, 0.2); border-radius: 8px; font-size: 13px; color: var(--text-color, #333); line-height: 1.5; box-sizing: border-box; width: 100%;">
          <input type="checkbox" id="keep-original-memory" checked style="margin-right: 8px; margin-top: 2px; flex-shrink: 0; width: 16px; height: 16px;">
          <span style="flex: 1; min-width: 0; word-break: break-word;">
            <strong>转换后保留原记忆 (推荐)</strong><br>
            <span style="font-size: 11px; color: var(--text-secondary, #666);">防止误操作。若取消勾选，则转换后将从原记忆库中删除。</span>
          </span>
        </label>
        <label style="display: flex; align-items: flex-start; cursor: pointer; margin-top: 10px; padding: 12px; background: rgba(0, 122, 255, 0.08); border: 1px solid rgba(0, 122, 255, 0.2); border-radius: 8px; font-size: 13px; color: var(--text-color, #333); line-height: 1.5; box-sizing: border-box; width: 100%;">
          <input type="checkbox" id="ai-smart-convert" style="margin-right: 8px; margin-top: 2px; flex-shrink: 0; width: 16px; height: 16px;">
          <span style="flex: 1; min-width: 0; word-break: break-word;">
            <strong>启用 AI 智能分类与精炼 (消耗 API)</strong><br>
            <span style="font-size: 11px; color: var(--text-secondary, #666);">自动精简长记忆，并精准分类到核心灵魂/情绪等类别，显著提升检索质量！由于需发给AI，大量记忆时可能需要几分钟。</span>
          </span>
        </label>
      </div>
    `;

    const modalFooter = document.querySelector('#custom-modal .custom-modal-footer');
    if (modalFooter) {
      modalFooter.style.flexDirection = 'row';
      modalFooter.style.justifyContent = 'flex-end';
      modalFooter.innerHTML = `
        <button id="custom-modal-cancel">取消</button>
        <button id="custom-modal-confirm" class="confirm-btn">开始转换</button>
      `;
    }

    const selectAllCb = document.getElementById('convert-select-all');
    const allCbs = document.querySelectorAll('.memory-convert-checkbox');
    
    selectAllCb.addEventListener('change', (e) => {
      allCbs.forEach(cb => cb.checked = e.target.checked);
    });
    
    allCbs.forEach(cb => {
      cb.addEventListener('change', () => {
        const total = allCbs.length;
        const checked = document.querySelectorAll('.memory-convert-checkbox:checked').length;
        selectAllCb.checked = (total === checked);
      });
    });

    const confirmBtn = document.getElementById('custom-modal-confirm');
    const cancelBtn = document.getElementById('custom-modal-cancel');
    cancelBtn.style.display = 'block';

    confirmBtn.onclick = async () => {
      if (window.vectorMemoryManager._extractionLocks.get(chat)) { showToast('这个聊天正在提取或转换，请等待当前任务结束', 'info'); return; }
      const selectedIndices = Array.from(document.querySelectorAll('.memory-convert-checkbox:checked')).map(cb => parseInt(cb.dataset.index));
      const keepOriginal = document.getElementById('keep-original-memory').checked;
      const smartConvert = document.getElementById('ai-smart-convert') ? document.getElementById('ai-smart-convert').checked : false;
      
      if (selectedIndices.length === 0) {
        showToast('请至少选择一条记忆', 'info');
        return;
      }
      
      hideCustomModal();

      if (smartConvert) {
        try { await doSmartConvertWithAI(chat, items, selectedIndices, keepOriginal); }
        catch (error) { showToast('转换失败：' + error.message, 'error'); }
        return;
      }
      window.vectorMemoryManager._extractionLocks.set(chat, { type: 'conversion' });
      
      let progressToast = showToast(`转换中... 0/${selectedIndices.length}`, 'info', 0);
      let successCount = 0;
      let failCount = 0;
      
      // 分别记录需要删除的索引
      let structuredToDelete = {}; // { cat: [indices...] }
      let longTermToDelete = [];

      try {
        for (let i = 0; i < selectedIndices.length; i++) {
          const item = items[selectedIndices[i]];
          try {
            const vm = window.vectorMemoryManager.getVariableMemory(chat);
            const memoryTime = window.MemoryExtractionSupport.datedText(item.content);
            const duplicate = vm.fragments.some(fragment => window.vectorMemoryManager._isLikelyDuplicate(chat, { content: item.content, category: item.mappedCategory, memoryTime }, fragment));
            if (duplicate) {
              if (!keepOriginal) {
                if (item.type === 'longTerm') longTermToDelete.push({ authorId: item.authorId, id: item.id });
                else {
                  if (!structuredToDelete[item.categoryCode]) structuredToDelete[item.categoryCode] = [];
                  structuredToDelete[item.categoryCode].push(item.id);
                }
              }
              continue;
            }
            // 尝试获取向量（如果失败返回null，不报错）
            const draft = {
              content: item.content,
              tags: [item.type === 'longTerm' ? '旧长期记忆转换' : '旧结构化转换'],
              sourceLanguage: window.vectorMemoryManager.detectLanguage(item.content)
            };
            const embeddingText = window.vectorMemoryManager._embeddingTextFor(chat, draft);
            const embedding = await window.vectorMemoryManager.getEmbedding(embeddingText, chat);
            
            // 只要到这里，无论 embedding 有无，都保存（有embedding就是向量，没有就是BM25）
            window.vectorMemoryManager.createFragment(chat, {
              ...draft,
              category: item.mappedCategory,
              importance: 5,
              emotionalWeight: 3,
              embedding: embedding || null,
              embeddingSignature: embedding ? window.vectorMemoryManager._embeddingSignature(chat) : '',
              embeddingTextHash: embedding ? window.vectorMemoryManager._hashEmbeddingText(embeddingText) : '',
              memoryTime,
              timeBasis: memoryTime ? 'explicit' : 'unknown',
              source: 'manual'
            });
            successCount++;
            
            // 记录要删除的条目
            if (!keepOriginal) {
              if (item.type === 'longTerm') {
                longTermToDelete.push({ authorId: item.authorId, id: item.id });
              } else if (item.type === 'structured') {
                if (!structuredToDelete[item.categoryCode]) structuredToDelete[item.categoryCode] = [];
                // 这里存放的是字符串形式的 id，解析出它原来的数据索引/key
                structuredToDelete[item.categoryCode].push(item.id);
              }
            }
            
          } catch (err) {
            console.error(`转换第 ${i+1} 条记忆失败:`, err);
            failCount++;
          }
          
          const toastElement = document.querySelector('.toast:last-child');
          if (toastElement) {
            toastElement.textContent = `转换中... ${i+1}/${selectedIndices.length} (成功: ${successCount}, 失败: ${failCount})`;
          }
          
          await new Promise(res => setTimeout(res, 300)); // 避免API被限流
        }
        
        // 如果不需要保留原记忆，执行删除
        if (!keepOriginal) {
          if (longTermToDelete.length > 0) {
            const delByAuthor = {};
            longTermToDelete.forEach(info => {
              if (!delByAuthor[info.authorId]) delByAuthor[info.authorId] = [];
              delByAuthor[info.authorId].push(info.id);
            });
            for (const authorId in delByAuthor) {
              const authorChat = state.chats[authorId];
              if (authorChat && authorChat.longTermMemory) {
                delByAuthor[authorId].sort((a, b) => b - a);
                delByAuthor[authorId].forEach(idx => authorChat.longTermMemory.splice(idx, 1));
                if (authorId !== chat.id) {
                  db.chats.put(authorChat);
                }
              }
            }
          }
          if (Object.keys(structuredToDelete).length > 0 && window.structuredMemoryManager) {
            const mem = window.structuredMemoryManager.getStructuredMemory(chat);
            // 处理默认分类
            if (structuredToDelete['F']) {
               structuredToDelete['F'].forEach(strId => { const k = strId.substring(2); delete mem.facts[k]; });
            }
            if (structuredToDelete['R']) mem.relationship = '';
            
            // 以下数组需降序删除
            if (structuredToDelete['E']) {
               let eventMap = {}; 
               for (const ym of Object.keys(mem.events)) {
                 eventMap[ym] = mem.events[ym].split('|');
               }
               const eIds = structuredToDelete['E'].map(id => id.split('_'));
               eIds.sort((a, b) => parseInt(b[2]) - parseInt(a[2]));
               eIds.forEach(parts => {
                 const ym = parts[1];
                 const idx = parseInt(parts[2]);
                 if (eventMap[ym]) eventMap[ym].splice(idx, 1);
               });
               mem.events = {};
               for (const ym of Object.keys(eventMap)) {
                 if (eventMap[ym].length > 0) mem.events[ym] = eventMap[ym].join('|');
               }
            }
            if (structuredToDelete['P']) {
               const pIds = structuredToDelete['P'].map(id => parseInt(id.substring(2))).sort((a, b) => b - a);
               pIds.forEach(idx => mem.plans.splice(idx, 1));
            }
            if (structuredToDelete['D']) {
               const dIds = structuredToDelete['D'].map(id => parseInt(id.substring(2))).sort((a, b) => b - a);
               dIds.forEach(idx => mem.decisions.splice(idx, 1));
            }
            if (structuredToDelete['M']) {
               const mIds = structuredToDelete['M'].map(id => parseInt(id.substring(2))).sort((a, b) => b - a);
               mIds.forEach(idx => mem.emotions.splice(idx, 1));
            }
            // 自定义分类
            for (const [code, cat] of Object.entries(mem._customCategories || {})) {
              if (structuredToDelete[code]) {
                const cIds = structuredToDelete[code].map(id => {
                  const parts = id.split('_');
                  return parseInt(parts[2]);
                }).sort((a, b) => b - a);
                cIds.forEach(idx => {
                  if (mem._custom[code]) mem._custom[code].splice(idx, 1);
                });
              }
            }
          }
        }

        await db.chats.put(chat);
        
        if (progressToast) document.querySelectorAll('.toast').forEach(el => el.remove());
        showToast(`转换完成！\n- 成功：${successCount} 条\n- 失败：${failCount} 条`, 'success', 5000);
        
        if (document.getElementById('vector-memory-container')?.style.display !== 'none') {
          if (typeof renderVectorMemoryView === 'function') renderVectorMemoryView();
        }
      } catch (error) {
        if (progressToast) document.querySelectorAll('.toast').forEach(el => el.remove());
        console.error('变量记忆转换出错:', error);
        showToast(`转换中断：${error.message}\n已成功转换 ${successCount} 条`, 'error', 5000);
      } finally {
        window.vectorMemoryManager._extractionLocks.delete(chat);
      }
    };

    cancelBtn.onclick = () => { hideCustomModal(); };
    showCustomModal();
  });
}

