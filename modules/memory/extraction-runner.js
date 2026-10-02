// 共用同一任务锁；任务只按用户选择分批，失败不会自动重发。
function refreshVectorExtraction(chat) {
  if (typeof document !== 'undefined' && document.getElementById('vector-memory-container')?.style.display !== 'none' &&
      window.state?.activeChatId === chat.id && typeof renderVectorMemoryView === 'function') renderVectorMemoryView();
}

async function executeVectorExtraction(chat, messages, updateTimestamp = false, execution = {}) {
  const manager = window.vectorMemoryManager;
  const support = window.MemoryExtractionSupport;
  if (!messages.length) return { added: 0, updated: 0, duplicates: 0 };
  const vm = manager.getVariableMemory(chat);
  const task = execution.task;
  const signal = execution.signal;
  const formattedHistory = messages.map((message, i) => support.formatMessage(message, chat, i + 1)).filter(Boolean).join('\n');
  const rangeTime = message => support.formatTime({ memoryTime: window.MemoryWorldTime ? window.MemoryWorldTime.messageTime(message) : message.timestamp,
    memoryTimeZone: message.memoryClock?.timeZone });
  const timeRange = `${rangeTime(messages[0])} ~ ${rangeTime(messages[messages.length - 1])}`;
  const contextNote = execution.contextCount ? `\n前${execution.contextCount}条为相邻批次的前文，仅供关联事件；不要仅因重复提供而再次生成记忆。` : '';
  const prompt = manager.buildExtractionPrompt(chat, formattedHistory, timeRange, {}) + contextNote;
  const config = window.state.apiConfig;
  const secondary = config.secondaryProxyUrl && config.secondaryApiKey && config.secondaryModel;
  const proxyUrl = secondary ? config.secondaryProxyUrl : config.proxyUrl;
  const apiKey = secondary ? config.secondaryApiKey : config.apiKey;
  const model = secondary ? config.secondaryModel : config.model;
  if (!proxyUrl || !apiKey || !model) throw new Error('API未配置');
  if (task) {
    task.model = model;
    task.inputCharacters = prompt.length;
    // 粗略值仅作参考；未知模型容量不会成为隐藏的拆分条件。
    task.estimatedInputTokens = Math.ceil(prompt.length / 2);
  }
  if (signal?.aborted) throw new Error('提取已取消');
  const knownLimit = Number(config.contextWindowTokens);
  if (knownLimit > 0 && Math.ceil(prompt.length / 2) + 4096 > knownLimit) {
    throw new Error('输入估算超过已配置的模型容量，请缩小范围、换模型或开启分批；尚未提交请求');
  }
  if (task) {
    task.requests++;
    await db.chats.put(chat);
  }
  if (signal?.aborted) throw new Error('提取已取消');
  let data;
  if (String(proxyUrl).includes('generativelanguage') && typeof toGeminiRequestData === 'function') {
    const request = toGeminiRequestData(model, apiKey, prompt, [{ role: 'user', content: '请开始提取。' }]);
    data = await support.requestData(request.url, { ...request.data, signal });
  } else {
    data = await support.requestData(`${String(proxyUrl).replace(/\/+$/, '')}/v1/chat/completions`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: prompt }, { role: 'user', content: '请开始提取。' }], temperature: 0.3 })
    });
  }
  if (task) {
    const input = data.usage?.prompt_tokens ?? data.usageMetadata?.promptTokenCount;
    const output = data.usage?.completion_tokens ?? data.usageMetadata?.candidatesTokenCount;
    task.usageKnown = task.usageKnown !== false && Number.isFinite(input) && Number.isFinite(output);
    if (Number.isFinite(input)) task.inputTokens = (task.inputTokens || 0) + input;
    if (Number.isFinite(output)) task.outputTokens = (task.outputTokens || 0) + output;
  }
  const finish = data.choices?.[0]?.finish_reason || data.candidates?.[0]?.finishReason;
  if (['length', 'MAX_TOKENS', 'content_filter', 'SAFETY', 'RECITATION'].includes(finish)) throw new Error('提取输出不完整，未保存本次结果；请缩小范围或调整模型输出容量');
  const raw = typeof getGeminiResponseText === 'function' ? getGeminiResponseText(data) : (data.choices?.[0]?.message?.content || '');
  const extracted = manager.parseExtractionResult(raw).map(item => ({ ...item, ...support.resolveTime(item, messages) }));
  if (signal?.aborted) throw new Error('提取已取消');
  const checkpoint = {
    fragments: JSON.parse(JSON.stringify(vm.fragments)), stats: { ...vm.stats }, cache: vm._retrievalCache,
    lastIndex: vm.settings.lastExtractedMsgIndex, lastKey: vm.settings.lastExtractedSourceKey,
    offset: task?.offset || 0, added: task?.added || 0, updated: task?.updated || 0, duplicates: task?.duplicates || 0
  };
  try {
    const ids = await manager.mergeExtractedMemories(chat, extracted, null, {
      signal, onRequest: () => { if (task) task.embeddingRequests++; }
    });
    if (signal?.aborted) throw new Error('提取已取消');
    const last = messages[messages.length - 1];
    if (updateTimestamp) {
      let index = (chat.history || []).lastIndexOf(last);
      if (index < 0) index = (chat.history || []).findIndex(message => support.sourceKey(message) === support.sourceKey(last));
      if (index < 0) throw new Error('聊天记录已变化，未推进提取进度，请重新选择范围');
      vm.settings.lastExtractedMsgIndex = index;
      vm.settings.lastExtractedSourceKey = support.sourceKey(last);
      vm.settings.extractionProgressError = '';
    }
    if (task) {
      task.offset += execution.primaryCount || messages.length;
      task.added += ids.length;
      task.updated += ids.updated || 0;
      task.duplicates += ids.duplicates || 0;
    }
    await db.chats.put(chat);
    return { added: ids.length, updated: ids.updated || 0, duplicates: ids.duplicates || 0 };
  } catch (error) {
    vm.fragments = checkpoint.fragments;
    vm.stats = checkpoint.stats;
    vm._retrievalCache = checkpoint.cache;
    vm.settings.lastExtractedMsgIndex = checkpoint.lastIndex;
    vm.settings.lastExtractedSourceKey = checkpoint.lastKey;
    if (task) Object.assign(task, { offset: checkpoint.offset, added: checkpoint.added, updated: checkpoint.updated, duplicates: checkpoint.duplicates });
    throw error;
  }
}

async function executeVectorExtractionInBatches(chat, messages, updateTimestamp = false, resume = false) {
  const manager = window.vectorMemoryManager;
  const support = window.MemoryExtractionSupport;
  const vm = manager.getVariableMemory(chat);
  if (manager._extractionLocks.get(chat)) { showToast('这个聊天正在提取，请等待或取消当前任务', 'info'); return; }
  if (!resume && vm.extractionTask && ['paused', 'failed', 'running'].includes(vm.extractionTask.status)) {
    showToast('请先继续或取消未完成的提取任务', 'info'); return;
  }
  const batchEnabled = vm.settings.extractionBatchEnabled === true;
  const batchSize = Number(vm.settings.extractionBatchSize);
  if (batchEnabled && (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 9999)) throw new Error('每批消息数量请输入1～9999之间的整数');
  const snapshot = JSON.parse(JSON.stringify(messages));
  if (!snapshot.length) { showToast('没有可提取的消息', 'info'); return; }
  const task = resume ? vm.extractionTask : {
    status: 'running', sourceKeys: snapshot.map(support.sourceKey), total: snapshot.length, offset: 0,
    updateTimestamp, batchEnabled, batchSize: batchEnabled ? batchSize : snapshot.length,
    plannedRequests: batchEnabled ? Math.ceil(snapshot.length / batchSize) : 1,
    requests: 0, embeddingRequests: 0, added: 0, updated: 0, duplicates: 0,
    startedAt: Date.now(), rangeStart: window.MemoryWorldTime ? window.MemoryWorldTime.messageTime(snapshot[0]) : snapshot[0].timestamp,
    rangeEnd: window.MemoryWorldTime ? window.MemoryWorldTime.messageTime(snapshot[snapshot.length - 1]) : snapshot[snapshot.length - 1].timestamp,
    rangeTimeZone: snapshot[0].memoryClock?.timeZone
  };
  const runtime = { controller: new AbortController(), pauseRequested: false };
  manager._extractionLocks.set(chat, runtime);
  vm.extractionTask = task;
  task.status = 'running';
  task.error = '';
  vm.settings.autoExtractionPending = false;
  vm.settings.autoExtractionBlocked = false;
  showToast(`提取${task.total}条消息，${task.batchEnabled ? `每批${task.batchSize}条` : '不分批'}，预计${task.plannedRequests}次提取请求`, 'info');
  try {
    await db.chats.put(chat);
    refreshVectorExtraction(chat);
    while (task.offset < snapshot.length) {
      if (runtime.controller.signal.aborted) throw new Error('提取已取消');
      const start = task.offset;
      const end = Math.min(start + task.batchSize, snapshot.length);
      const contextStart = task.batchEnabled ? Math.max(0, start - 5) : start;
      await executeVectorExtraction(chat, snapshot.slice(contextStart, end), task.updateTimestamp, {
        task, signal: runtime.controller.signal, contextCount: start - contextStart, primaryCount: end - start
      });
      refreshVectorExtraction(chat);
      if (runtime.pauseRequested && task.offset < snapshot.length) { task.status = 'paused'; break; }
    }
    if (task.offset === snapshot.length) task.status = 'completed';
    task.finishedAt = Date.now();
    vm.settings.autoExtractionBlocked = task.status === 'paused';
    await db.chats.put(chat);
    showToast(task.status === 'paused' ? '已暂停，继续时只处理未完成部分' :
      task.added || task.updated ? `提取完成：新增${task.added}条，更新${task.updated}条` :
      task.duplicates ? '提取完成：内容已有记录，无需新增' : '提取完成：本次未提取到新记忆', 'info');
    return task;
  } catch (error) {
    task.status = runtime.controller.signal.aborted ? 'cancelled' : 'failed';
    task.error = task.status === 'cancelled' ? '已取消。已发出的请求可能产生费用；已成功保存的部分保留。' : error.message;
    task.finishedAt = Date.now();
    vm.settings.autoExtractionBlocked = true;
    await db.chats.put(chat).catch(() => { task.error += '；任务状态未能保存'; });
    showToast(task.error, task.status === 'cancelled' ? 'info' : 'error');
    return task;
  } finally {
    manager._extractionLocks.delete(chat);
    refreshVectorExtraction(chat);
  }
}

async function controlVectorExtraction(chat, action) {
  const manager = window.vectorMemoryManager;
  const vm = manager.getVariableMemory(chat);
  const runtime = manager._extractionLocks.get(chat);
  if (action === 'pause' && runtime) {
    if (!runtime.controller) { showToast('正在转换旧记忆，请等待转换结束', 'info'); return; }
    runtime.pauseRequested = true;
    showToast('当前请求结束后暂停，不再发起下一批', 'info');
    return;
  }
  if (action === 'cancel') {
    if (runtime) {
      if (runtime.controller) runtime.controller.abort();
      else showToast('正在转换旧记忆，请等待转换结束', 'info');
      return;
    }
    if (vm.extractionTask) vm.extractionTask.status = 'cancelled';
    vm.settings.autoExtractionBlocked = true;
  } else if (action === 'resume') {
    if (!vm.extractionTask || runtime) return;
    const buckets = new Map();
    for (const message of chat.history || []) {
      const key = window.MemoryExtractionSupport.sourceKey(message);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(message);
    }
    const messages = vm.extractionTask.sourceKeys.map(key => buckets.get(key)?.shift());
    if (messages.some(message => !message)) { showToast('原消息已删除或修改，请取消任务后重新选择范围', 'error'); return; }
    return executeVectorExtractionInBatches(chat, messages, vm.extractionTask.updateTimestamp, true);
  } else if (action === 'enable-auto') {
    if (runtime || ['running', 'paused', 'failed'].includes(vm.extractionTask?.status)) {
      showToast('请先继续或取消未完成的任务', 'info'); return;
    }
    vm.settings.autoExtractionBlocked = false;
  }
  await db.chats.put(chat);
  refreshVectorExtraction(chat);
}
