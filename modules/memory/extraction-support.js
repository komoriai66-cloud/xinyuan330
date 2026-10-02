(function () {
  'use strict';

  const validTime = value => {
    if (value === null || value === undefined || value === '') return null;
    const time = typeof value === 'number' ? value : new Date(value).getTime();
    return Number.isFinite(time) && time > 0 ? time : null;
  };

  function content(message) {
    if (message.type === 'offline_text') {
      return [...new Set([message.content, message.dialogue, message.description].filter(value => typeof value === 'string' && value.trim()))].join('\n');
    }
    if (message.type === 'sticker') return `[表情] ${message.meaning || message.content || ''}`;
    if (message.type === 'voice_message') return `[语音] ${message.content || ''}`;
    if (['ai_image', 'user_photo'].includes(message.type) || Array.isArray(message.content)) {
      const description = typeof message.content === 'string' && !/^(?:data:|https?:\/\/)/i.test(message.content) ? message.content : '';
      return `[图片] ${message.description || message.meaning || description || '没有文字说明'}`;
    }
    return typeof message.content === 'string' ? message.content : `[${message.type || '消息'}]`;
  }

  function eligible(message) {
    return !!message && (!message.isHidden || (message.role === 'system' && typeof message.content === 'string' && message.content.includes('内心独白')));
  }

  function sourceKey(message) {
    const text = JSON.stringify([message.timestamp, message.role, message.senderName, message.type, message.content, message.dialogue, message.description]);
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return `${message.id ? `id:${message.id}` : message.timestamp}:${(hash >>> 0).toString(36)}`;
  }

  function formatMessage(message, chat, number) {
    if (!eligible(message)) return '';
    const snapshot = message.memoryClock;
    const value = window.MemoryWorldTime ? window.MemoryWorldTime.messageTime(message) : message.timestamp;
    const time = snapshot && Number.isFinite(value) ? value : validTime(value);
    const date = snapshot && window.MemoryWorldTime
      ? window.MemoryWorldTime.format(time, snapshot.timeZone)
      : time !== null ? new Date(time).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '时间不明';
    const sender = message.role === 'user' ? (chat.settings?.myNickname || '用户') : (message.senderName || chat.originalName || chat.name || '角色');
    const remark = window.RemarkNames?.formatMemoryEvent(message, chat);
    const context = snapshot ? ` [${snapshot.timeSource === 'world' ? '世界时间' : '现实时间'}；时间线：${snapshot.timelineName || snapshot.timelineId}${snapshot.policy?.relativeBasis === 'real' ? `；相对日期参照现实时间${window.MemoryWorldTime.format(message.timestamp, snapshot.timeZone)}` : ''}]` : '';
    return `${number ? `[消息${number}] ` : ''}(${date})${context} ${sender}: ${remark || content(message)}`;
  }

  function datedText(text, worldCalendar = false) {
    const value = String(text || '');
    let match = value.match(/(?:\[|\()(\d{2})(\d{2})(\d{2})(?:\]|\))/);
    if (match) return calendarTime(2000 + Number(match[1]), Number(match[2]), Number(match[3]));
    match = value.match(worldCalendar ? /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/ : /(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
    if (match) return calendarTime(Number(match[1]), Number(match[2]), Number(match[3]));
    match = value.match(/\[(\d{2})(\d{2})\]\s*\[(\d{2})\]/);
    return match ? calendarTime(2000 + Number(match[1]), Number(match[2]), Number(match[3])) : null;
  }

  function calendarTime(year, month, day) {
    const date = new Date(year, month - 1, day, 12);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date.getTime() : null;
  }

  function datesInText(text, worldCalendar = false) {
    const dates = [];
    for (const pattern of [/(?:\[|\()\d{6}(?:\]|\))/g, worldCalendar ? /\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}/g : /20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}/g, /\[\d{4}\]\s*\[\d{2}\]/g]) {
      for (const match of String(text || '').matchAll(pattern)) {
        const date = datedText(match[0], worldCalendar);
        if (date) dates.push(date);
      }
    }
    return [...new Set(dates)];
  }

  function resolveLegacyTime(item, messages, worldCalendar = false) {
    const timeValue = worldCalendar ? value => {
      if (value === null || value === undefined || value === '') return null;
      const time = typeof value === 'number' ? value : new Date(value).getTime();
      return Number.isFinite(time) ? time : null;
    } : validTime;
    if (item.sourceMessageIds !== undefined && !Array.isArray(item.sourceMessageIds)) throw new Error('来源消息编号必须是数组');
    if (item.timeBasis && !['message', 'explicit', 'relative', 'fictional', 'unknown'].includes(item.timeBasis)) throw new Error('提取结果的时间依据无效');
    const ids = Array.isArray(item.sourceMessageIds) ? [...new Set(item.sourceMessageIds)] : [];
    if (ids.some(id => !Number.isInteger(id) || id < 1 || id > messages.length)) throw new Error('提取结果包含无效的来源消息编号');
    const sources = ids.map(id => messages[id - 1]);
    const basis = item.timeBasis || 'unknown';
    let start = null;
    let end = null;
    let precision = 'day';
    let plannedDate = null;
    const evidenceText = sources.map(content).join('\n');
    const selectedEvidence = typeof item.timeEvidence === 'string' && item.timeEvidence.trim() && evidenceText.includes(item.timeEvidence.trim()) ? item.timeEvidence.trim() : '';
    if (basis === 'message' && sources.length) {
      const times = sources.map(message => timeValue(message.timestamp)).filter(time => time !== null);
      start = times.length ? Math.min(...times) : null;
      end = times.length ? Math.max(...times) : null;
      precision = 'minute';
    } else if (basis === 'relative' && sources.length) {
      const anchorMessage = selectedEvidence ? sources.find(source => content(source).includes(selectedEvidence)) : sources[0];
      const evidence = selectedEvidence || content(anchorMessage);
      const anchor = timeValue(anchorMessage.timestamp);
      const relative = evidence.match(/前天|昨天|昨晚|今天|今晚|明天|明晚|后天/);
      if (anchor !== null && relative) {
        const date = new Date(anchor);
        const offset = { 前天: -2, 昨天: -1, 昨晚: -1, 今天: 0, 今晚: 0, 明天: 1, 明晚: 1, 后天: 2 }[relative[0]];
        date.setDate(date.getDate() + offset);
        date.setHours(12, 0, 0, 0);
        start = date.getTime();
      } else {
        const days = evidence.match(/(\d+)天前/);
        if (anchor !== null && days) {
          const date = new Date(anchor);
          date.setDate(date.getDate() - Number(days[1]));
          date.setHours(12, 0, 0, 0);
          start = date.getTime();
        }
        if (anchor !== null && start === null && /去年|上个月|上周/.test(evidence)) {
          const date = new Date(anchor);
          if (/去年/.test(evidence)) {
            start = calendarTime(date.getFullYear() - 1, 1, 1);
            end = calendarTime(date.getFullYear() - 1, 12, 31);
          } else if (/上个月/.test(evidence)) {
            start = new Date(date.getFullYear(), date.getMonth() - 1, 1, 12).getTime();
            end = new Date(date.getFullYear(), date.getMonth(), 0, 12).getTime();
          } else {
            const monday = new Date(anchor);
            monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) - 7);
            monday.setHours(12, 0, 0, 0);
            start = monday.getTime();
            const sunday = new Date(start);
            sunday.setDate(sunday.getDate() + 6);
            end = sunday.getTime();
          }
        }
      }
    } else if (basis === 'explicit') {
      const sourceDates = datesInText(selectedEvidence || evidenceText || item.content, worldCalendar);
      const proposed = timeValue(item.eventTime);
      start = sourceDates.find(date => proposed && new Date(proposed).toDateString() === new Date(date).toDateString()) || sourceDates[0] || null;
      if (start) {
        const exact = timeValue(item.eventTime);
        if (exact && new Date(exact).toDateString() === new Date(start).toDateString() && /\d{1,2}[:：]\d{2}/.test(selectedEvidence || evidenceText)) {
          start = exact;
          precision = 'minute';
        }
        const proposedEnd = timeValue(item.eventTimeEnd);
        if (proposedEnd && sourceDates.some(date => new Date(date).toDateString() === new Date(proposedEnd).toDateString())) end = proposedEnd;
      }
    } else if (!item.timeBasis) {
      start = timeValue(item.memoryTime) || datedText(item.content);
    }
    if (item.category === 'P' && sources.length && basis !== 'fictional' && basis !== 'unknown') {
      if (basis === 'message') {
        const relativePlan = /前天|昨天|昨晚|今天|今晚|明天|明晚|后天|\d+天前/.test(evidenceText);
        const datedPlan = datesInText(evidenceText, worldCalendar).length > 0;
        if (relativePlan || datedPlan) plannedDate = resolveLegacyTime({ ...item, category: 'E', timeBasis: datedPlan ? 'explicit' : 'relative' }, messages, worldCalendar).memoryTime;
      } else plannedDate = start;
      start = timeValue(sources[0].timestamp);
      end = null;
      precision = 'minute';
    }
    if (end !== null && (start === null || end < start)) throw new Error('提取结果的事件结束时间早于开始时间');
    return {
      memoryTime: start, memoryTimeEnd: end !== null && end !== start ? end : null,
      timeBasis: basis === 'fictional' ? 'fictional' : start !== null ? basis : 'unknown',
      timePrecision: start !== null ? precision : 'unknown',
      timeEvidence: selectedEvidence,
      eventTimeText: basis === 'fictional' ? String(item.eventTimeText || item.eventTime || '') : '',
      plannedTime: item.category === 'P' ? plannedDate : null,
      sourceMessageKeys: sources.map(sourceKey),
      sourceEvidence: sources.map(message => ({ key: sourceKey(message), timestamp: message.timestamp, content: content(message) }))
    };
  }

  function resolveTime(item, messages) {
    const e = window.MemoryWorldTime;
    const ids = Array.isArray(item.sourceMessageIds) ? item.sourceMessageIds : [];
    const sources = ids.map(id => messages[id - 1]).filter(Boolean);
    const snapshot = sources.find(source => source.memoryClock)?.memoryClock;
    if (!e || !snapshot) return resolveLegacyTime(item, messages);
    const timelineIds = new Set(sources.filter(source => source.memoryClock).map(source => source.memoryClock.timelineId));
    if (timelineIds.size > 1) throw new Error('同一条记忆包含不同时间线的来源，请分别提取，不能合并为同一事件');
    const timeZone = snapshot.timeZone;
    const policy = snapshot.policy || {};
    const adjusted = { ...item };
    if (snapshot.linked && policy.explicitPriority === 'world' && adjusted.timeBasis === 'explicit' && adjusted.category !== 'P') adjusted.timeBasis = 'message';
    if (policy.undated === 'unknown' && item.timeBasis === 'message' && adjusted.category !== 'P') adjusted.timeBasis = 'unknown';
    const relative = adjusted.timeBasis === 'relative';
    const virtual = messages.map(message => ({ ...message,
      timestamp: validTime(message.timestamp) !== null ? e.localDate(e.messageTime(message, relative), timeZone).getTime() : message.timestamp }));
    const result = resolveLegacyTime(adjusted, virtual, true);
    for (const key of ['memoryTime', 'memoryTimeEnd', 'plannedTime']) {
      if (result[key] !== null) result[key] = e.fromLocalDate(new Date(result[key]), timeZone);
    }
    // Plans are proposed at the message's world time even when relative execution
    // dates are deliberately configured to use the real calendar.
    if (adjusted.category === 'P' && sources.length && !['unknown', 'fictional'].includes(adjusted.timeBasis)) {
      result.memoryTime = e.messageTime(sources[0]);
      const evidence = sources.map(content).join('\n');
      const planBasis = datesInText(evidence, true).length ? 'explicit' : /前天|昨天|昨晚|今天|今晚|明天|明晚|后天|\d+天前/.test(evidence) ? 'relative' : null;
      if (planBasis) {
        const plannedSources = messages.map(message => message.memoryClock ? { ...message, memoryClock: {
          ...message.memoryClock, policy: { ...message.memoryClock.policy, explicitPriority: 'text' } } } : message);
        const plan = resolveTime({ ...item, category: 'E', timeBasis: planBasis }, plannedSources);
        result.plannedTime = plan.memoryTime;
        result.plannedTimePrecision = plan.timePrecision;
      } else if (result.plannedTime !== null) result.plannedTimePrecision = 'day';
    }
    // Only source text can supply a time of day. Do not turn day-only dates into noon.
    if (['explicit', 'relative'].includes(adjusted.timeBasis) && adjusted.category !== 'P' && result.memoryTime !== null && result.memoryTimeEnd === null) {
      const text = result.timeEvidence || sources.map(content).join('\n');
      const digital = text.match(/(\d{1,2})[:：](\d{2})/);
      const chinese = text.match(/(上午|早上|凌晨|下午|晚上|中午)?\s*([零〇一二两三四五六七八九十\d]{1,3})[点时](半|(?:[零〇一二两三四五六七八九十\d]{1,3})分)?/);
      const number = value => {
        if (/^\d+$/.test(value)) return Number(value);
        const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
        if (value === '十') return 10;
        if (value.includes('十')) { const [tens, ones] = value.split('十'); return (digits[tens] || 1) * 10 + (digits[ones] || 0); }
        return digits[value];
      };
      let hour = digital ? Number(digital[1]) : chinese ? number(chinese[2]) : NaN;
      const minute = digital ? Number(digital[2]) : chinese?.[3] === '半' ? 30 : chinese?.[3] ? number(chinese[3].replace('分', '')) : 0;
      if (chinese && /下午|晚上|中午/.test(chinese[1] || '') && hour < 12) hour += 12;
      if (chinese?.[1] === '凌晨' && hour === 12) hour = 0;
      if (Number.isInteger(hour) && hour >= 0 && hour < 24 && Number.isInteger(minute) && minute >= 0 && minute < 60) {
        const date = e.localDate(result.memoryTime, timeZone); date.setHours(hour, minute, 0, 0);
        result.memoryTime = e.fromLocalDate(date, timeZone); result.timePrecision = 'minute';
      }
    }
    const anchor = sources.find(source => source.memoryClock) || sources[0];
    const isRealRelative = relative && anchor.memoryClock?.policy?.relativeBasis === 'real';
    const metadata = { clockVersion: 1, memoryTimeZone: timeZone, timeSource: isRealRelative && adjusted.category !== 'P' ? 'real' : snapshot.timeSource,
      timelineId: snapshot.timelineId, timelineName: snapshot.timelineName };
    const automaticTime = Object.fromEntries(['memoryTime', 'memoryTimeEnd', 'plannedTime', 'timeBasis', 'timePrecision',
      'timeEvidence', 'eventTimeText', 'plannedTimePrecision'].map(key => [key, result[key] ?? null]));
    return { ...result, ...metadata, automaticTime: { ...automaticTime, ...metadata },
      sourceMessageKeys: sources.map(sourceKey),
      sourceEvidence: sources.map(message => ({ key: sourceKey(message), timestamp: message.timestamp,
        role: message.role, type: message.type, content: content(message), memoryClock: message.memoryClock ? JSON.parse(JSON.stringify(message.memoryClock)) : undefined })) };
  }

  function formatTime(fragment, language = 'zh-CN') {
    if (fragment.eventTimeText) return `剧情时间：${fragment.eventTimeText}`;
    const worldTime = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
    const start = fragment.clockVersion ? worldTime(fragment.memoryTime) : validTime(fragment.memoryTime);
    if (start === null) return language === 'en-US' ? 'Time unknown' : '时间不明';
    if (fragment.memoryTimeZone && window.MemoryWorldTime) {
      const format = time => window.MemoryWorldTime.format(time, fragment.memoryTimeZone, fragment.timePrecision === 'day', language);
      const end = worldTime(fragment.memoryTimeEnd);
      const planned = worldTime(fragment.plannedTime);
      const range = end !== null && end !== start ? `${format(start)} ~ ${format(end)}` : format(start);
      const plannedText = planned !== null ? window.MemoryWorldTime.format(planned, fragment.memoryTimeZone, fragment.plannedTimePrecision === 'day', language) : '';
      return planned !== null ? `${range}${language === 'en-US' ? ' (planned: ' : '（计划执行：'}${plannedText}${language === 'en-US' ? ')' : '）'}` : range;
    }
    const options = { year: 'numeric', month: '2-digit', day: '2-digit', ...(fragment.timePrecision === 'day' ? {} : { hour: '2-digit', minute: '2-digit', hour12: false }) };
    const date = new Date(start).toLocaleString(language, options);
    const end = validTime(fragment.memoryTimeEnd);
    const range = end && end !== start ? `${date} ~ ${new Date(end).toLocaleString(language, options)}` : date;
    const planned = validTime(fragment.plannedTime);
    return planned ? `${range}（计划执行：${new Date(planned).toLocaleString(language, options)}）` : range;
  }

  function repairDates(fragments, history) {
    const byKey = new Map((history || []).map(message => [sourceKey(message), message]));
    return fragments.map(fragment => {
      const sources = (fragment.sourceMessageKeys || []).map(key => byKey.get(key)).filter(Boolean);
      const evidence = sources.length ? sources : (fragment.sourceEvidence || []);
      if (fragment.timeBasis === 'manual') return null;
      if (['message', 'explicit', 'relative', 'fictional'].includes(fragment.timeBasis)) return null;
      const date = datedText(fragment.content) || evidence.map(source => datedText(source.content)).find(Boolean);
      if (date) return { id: fragment.id, memoryTime: date, memoryTimeEnd: null, timeBasis: 'explicit', timePrecision: 'day' };
      // 旧数据没有来源，不能凭写入时间猜事件时间。只在用户主动修复时标记未知。
      return fragment.timeBasis === 'unknown' && fragment.memoryTime === null ? null : { id: fragment.id, memoryTime: null, memoryTimeEnd: null, timeBasis: 'unknown', timePrecision: 'unknown' };
    }).filter(change => change && fragments.some(fragment => fragment.id === change.id && (fragment.memoryTime !== change.memoryTime || fragment.timeBasis !== change.timeBasis)));
  }

  async function requestData(url, options = {}) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 180000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`提取请求失败（${response.status}）${/context|token|too long|length/i.test(detail) ? '：内容超出模型容量，请缩小范围、换模型或开启分批' : ''}`);
      }
      return await response.json();
    } catch (error) {
      if (timedOut) throw new Error('提取请求超时，已停止；不会自动重试，已发出的请求是否计费由接口决定');
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  window.MemoryExtractionSupport = { validTime, content, eligible, sourceKey, formatMessage, datedText, resolveTime, formatTime, repairDates, requestData };
})();
