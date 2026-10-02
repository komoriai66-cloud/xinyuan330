(function () {
  'use strict';

  const FILE_HEADER = '# EPhone Memory Import Text';

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function safeName(value) {
    return String(value || '角色').replace(/[\\/:*?"<>|]/g, '_');
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }

  function download(content, filename, type) {
    const blob = new Blob([content], { type: `${type};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function activeKind() {
    if (document.getElementById('memory-tab-vector')?.classList.contains('active')) return 'vector';
    if (document.getElementById('memory-tab-structured')?.classList.contains('active')) return 'structured';
    return 'original';
  }

  function payloadFor(chat, kind) {
    if (kind === 'original') return clone(chat.longTermMemory || []);
    if (kind === 'structured') return JSON.parse(window.structuredMemoryManager.exportMemory(chat));
    if (kind === 'vector') return JSON.parse(window.vectorMemoryManager.exportMemory(chat));
    return {
      original: clone(chat.longTermMemory || []),
      structured: chat.structuredMemory ? JSON.parse(window.structuredMemoryManager.exportMemory(chat)) : null,
      vector: (chat.variableMemory || chat.vectorMemory) ? JSON.parse(window.vectorMemoryManager.exportMemory(chat)) : null
    };
  }

  function envelope(chat, kind) {
    return {
      fileType: 'ephone-memory',
      formatRevision: 1,
      exportedAt: new Date().toISOString(),
      sourceChat: { id: chat.id, name: chat.name, originalName: chat.originalName || '', isGroup: !!chat.isGroup },
      memoryType: kind,
      normalMemory: (kind === 'original' || kind === 'all') ? window.normalMemoryManager?.transfer(chat) : undefined,
      data: payloadFor(chat, kind)
    };
  }

  function readingText(chat, kind) {
    const title = `《${chat.name || '角色'}的记忆》`;
    const head = `${title}\n\n导出时间：${new Date().toLocaleString('zh-CN')}\n记忆类型：${kind === 'all' ? '全部记忆' : kind === 'original' ? '原始长期记忆' : kind === 'structured' ? '结构化记忆' : '向量记忆'}\n\n`;
    if (kind === 'original') {
      const rows = (chat.longTermMemory || []).map((item, index) => {
        const stamp = Number.isFinite(Number(item.timestamp)) ? new Date(Number(item.timestamp)).toLocaleString('zh-CN') : '时间未知';
        return `${index + 1}. [${stamp}]\n${item.content || ''}`;
      });
      const overview = window.normalMemoryManager?.active(chat) || [];
      return head + (rows.length ? rows.join('\n\n────────────────────\n\n') : '暂无记忆') + (overview.length ? '\n\n【当前普通记忆概况】\n' + overview.map(e => `[${window.normalMemoryManager.labels[e.status]}] ${e.text}`).join('\n\n') : '');
    }
    if (kind === 'structured') return head + (window.structuredMemoryManager.serializeForPrompt(chat) || '暂无记忆');
    if (kind === 'vector') {
      const vm = window.vectorMemoryManager.getVariableMemory(chat);
      const rows = (vm.fragments || []).map((item, index) => `${index + 1}. [${window.MemoryExtractionSupport.formatTime(item)}] [${item.category || 'E'}]\n${item.content || ''}`);
      return head + (rows.length ? rows.join('\n\n────────────────────\n\n') : '暂无记忆');
    }
    return head + ['original', 'structured', 'vector'].map(type => `【${type}】\n${readingText(chat, type).split('\n\n').slice(3).join('\n\n')}`).join('\n\n====================\n\n');
  }

  function parseImportText(text) {
    const trimmed = String(text || '').replace(/^\uFEFF/, '').trim();
    if (!trimmed.startsWith(FILE_HEADER)) return JSON.parse(trimmed);
    const lines = trimmed.split(/\r?\n/);
    const body = lines.filter(line => line.trim() && !line.trim().startsWith('#')).join('\n');
    return JSON.parse(body);
  }

  function normalizeImported(value) {
    if (value?.fileType === 'ephone-memory' && value.memoryType && value.data !== undefined) return value;
    if (Array.isArray(value)) return { fileType: 'ephone-memory', memoryType: 'original', data: value };
    if (value?.type === 'structured-memory' || value?.type === 'structured-memory-partial') return { fileType: 'ephone-memory', memoryType: 'structured', data: value };
    if (value?.type === 'variable-memory-full' || value?.type === 'variable-memory-partial') return { fileType: 'ephone-memory', memoryType: 'vector', data: value };
    throw new Error('无法识别此记忆文件；阅读版 TXT 不能直接导入');
  }

  function originalCount(data) {
    return Array.isArray(data) ? data.length : 0;
  }

  async function applyImport(chat, imported, mode) {
    let count = 0;
    const applyOne = async (kind, data) => {
      if (kind === 'original') {
        if (!Array.isArray(data)) throw new Error('原始记忆数据格式不正确');
        if (mode === 'replace') chat.longTermMemory = clone(data);
        else {
          if (!Array.isArray(chat.longTermMemory)) chat.longTermMemory = [];
          const existing = new Set(chat.longTermMemory.map(item => `${item.timestamp || ''}\u0000${String(item.content || '').trim()}`));
          for (const item of data) {
            const key = `${item.timestamp || ''}\u0000${String(item.content || '').trim()}`;
            if (!existing.has(key)) { chat.longTermMemory.push(clone(item)); existing.add(key); count++; }
          }
          return;
        }
        count += originalCount(data);
      } else if (kind === 'structured' && data) {
        count += window.structuredMemoryManager.importMemory(chat, JSON.stringify(data), mode);
      } else if (kind === 'vector' && data) {
        count += await window.vectorMemoryManager.importMemory(chat, JSON.stringify(data), mode);
      }
    };
    if (imported.memoryType === 'all') {
      await applyOne('original', imported.data.original || []);
      await applyOne('structured', imported.data.structured);
      await applyOne('vector', imported.data.vector);
    } else await applyOne(imported.memoryType, imported.data);
    if (imported.memoryType === 'all' || imported.memoryType === 'original') window.normalMemoryManager?.importState(chat, imported.normalMemory, mode);
    return count;
  }

  async function importFile(chat, file) {
    const imported = normalizeImported(parseImportText(await file.text()));
    const targetName = escapeHtml(chat.name);
    const source = imported.sourceChat?.name ? `<br><small>来源角色：${escapeHtml(imported.sourceChat.name)}</small>` : '';
    const mode = await showChoiceModal('导入记忆', [
      { text: `合并到“${targetName}”${source}`, value: 'merge' },
      { text: `替换“${targetName}”的对应记忆${source}`, value: 'replace' }
    ]);
    if (!mode) return;
    if (window.vectorMemoryManager?._extractionLocks.get(chat)) throw new Error('正在提取，请结束当前任务后导入记忆');
    if (window.normalMemoryManager?.locks.has(chat)) throw new Error('正在梳理普通记忆，请暂停后再导入');
    const backup = {
      longTermMemory: clone(chat.longTermMemory), structuredMemory: clone(chat.structuredMemory),
      variableMemory: clone(chat.variableMemory), vectorMemory: clone(chat.vectorMemory),
      lastMemorySummaryTimestamp: chat.lastMemorySummaryTimestamp,
      lastStructuredMemoryTimestamp: chat.lastStructuredMemoryTimestamp,
      normalMemory: clone(chat.normalMemory)
    };
    try {
      const count = await applyImport(chat, imported, mode);
      await db.chats.put(chat);
      if (typeof renderLongTermMemoryList === 'function') renderLongTermMemoryList();
      if (activeKind() === 'structured' && typeof renderStructuredMemoryView === 'function') renderStructuredMemoryView();
      if (activeKind() === 'vector' && typeof renderVectorMemoryView === 'function') renderVectorMemoryView();
      showToast(`成功导入 ${count} 条记忆`, 'success');
    } catch (error) {
      chat.longTermMemory = backup.longTermMemory;
      chat.structuredMemory = backup.structuredMemory;
      chat.variableMemory = backup.variableMemory;
      chat.vectorMemory = backup.vectorMemory;
      chat.lastMemorySummaryTimestamp = backup.lastMemorySummaryTimestamp;
      chat.lastStructuredMemoryTimestamp = backup.lastStructuredMemoryTimestamp;
      chat.normalMemory = backup.normalMemory;
      throw error;
    }
  }

  function chooseFile(chat) {
    let input = document.getElementById('memory-transfer-import-input');
    if (!input) {
      input = document.createElement('input');
      input.id = 'memory-transfer-import-input';
      input.type = 'file';
      input.accept = '.json,.txt,application/json,text/plain';
      input.hidden = true;
      document.body.appendChild(input);
    }
    input.onchange = async () => {
      const file = input.files?.[0];
      input.value = '';
      if (!file) return;
      try { await importFile(chat, file); }
      catch (error) { console.error('[记忆导入]', error); showToast(`导入失败：${error.message}`, 'error'); }
    };
    input.click();
  }

  async function open(chat) {
    if (!chat) return;
    const current = activeKind();
    const kind = await showChoiceModal('记忆导入导出', [
      { text: '导出当前记忆 JSON', value: `json:${current}` },
      { text: '导出全部记忆 JSON', value: 'json:all' },
      { text: '导出当前记忆 TXT（可导入）', value: `importTxt:${current}` },
      { text: '导出当前记忆 TXT（阅读版）', value: `readTxt:${current}` },
      { text: '导入记忆 JSON / TXT', value: 'import' },
      { text: '隐藏此按钮（三击屏幕唤醒）', value: 'hide' }
    ]);
    if (!kind) return;
    if (kind === 'import') return chooseFile(chat);
    if (kind === 'hide') return window.hideMemoryTransferButton?.();
    const [format, memoryType] = kind.split(':');
    const base = `memory_${safeName(chat.name)}_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
    if (format === 'json') download(JSON.stringify(envelope(chat, memoryType), null, 2), `${base}.json`, 'application/json');
    else if (format === 'importTxt') download(`${FILE_HEADER}\n# encoding: UTF-8\n\n${JSON.stringify(envelope(chat, memoryType))}\n`, `${base}_可导入.txt`, 'text/plain');
    else download(readingText(chat, memoryType), `${base}_阅读版.txt`, 'text/plain');
    showToast('导出成功', 'success');
  }

  window.EPhoneMemoryTransfer = { open, importFile, parseImportText, normalizeImported, envelope, readingText };
})();
