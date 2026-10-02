// New messages keep their world clock separately from the real timestamp.
// Existing messages and memories are never backfilled.
(function () {
  'use strict';
  const sessionStart = Date.now();
  const storageKey = 'ephone-memory-time-default';
  const observed = new WeakMap();
  const known = new WeakSet();
  const defaults = Object.freeze({ linked: true, relativeBasis: 'world', explicitPriority: 'text',
    undated: 'message', decayBasis: 'world', halfLifeDays: 30, clockMode: 'global',
    timelineId: 'main', timelineName: '默认时间线', includeOtherEvents: true, shareFacts: true });
  const copy = value => JSON.parse(JSON.stringify(value));
  const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  function zone(value) {
    const name = value || Intl.DateTimeFormat().resolvedOptions().timeZone;
    try { new Intl.DateTimeFormat('en', { timeZone: name }).format(); return name; }
    catch (_) { throw new Error('请输入有效的时区，例如 Asia/Shanghai 或 UTC'); }
  }
  function normalize(value = {}) {
    const result = { ...defaults, ...value };
    for (const key of ['linked', 'includeOtherEvents', 'shareFacts']) result[key] = result[key] !== false;
    for (const [key, allowed] of Object.entries({ relativeBasis: ['world', 'real'], explicitPriority: ['text', 'world'],
      undated: ['message', 'unknown'], decayBasis: ['world', 'real', 'off'], clockMode: ['global', 'independent'] })) {
      if (!allowed.includes(result[key])) result[key] = defaults[key];
    }
    result.halfLifeDays = finite(result.halfLifeDays) && Number(result.halfLifeDays) > 0 ? Number(result.halfLifeDays) : 30;
    result.timelineId = String(result.timelineId || 'main');
    result.timelineName = String(result.timelineName || '默认时间线');
    return result;
  }
  function globalConfig() {
    if (window.state?.globalSettings?.memoryTimeDefault) return normalize(window.state.globalSettings.memoryTimeDefault);
    try { return normalize(JSON.parse(localStorage.getItem(storageKey) || '{}')); }
    catch (_) { return normalize(); }
  }
  function validateConfig(value) {
    const result = normalize(value);
    if (result.timelines !== undefined && (!Array.isArray(result.timelines) || result.timelines.some(item =>
      !item || typeof item.id !== 'string' || !item.id || typeof item.name !== 'string'))) throw new Error('时间线配置格式不正确');
    if (result.clockMode === 'independent') {
      const own = result.clock;
      if (!own || !finite(own.anchorTime) || !finite(own.anchorReal) || !finite(own.rate) || Number(own.rate) < 0 ||
        !Number.isFinite(new Date(Number(own.anchorTime)).getTime())) throw new Error('独立时钟配置缺少有效的日期、锚点或倍率');
      zone(own.timeZone);
    }
    return result;
  }
  function config(chat) {
    const own = chat?.settings?.memoryTime;
    const base = !own || own.inherit !== false ? globalConfig() : normalize(own);
    // A chat's clock and timeline stay independent from global extraction defaults.
    return normalize({ ...base, ...Object.fromEntries(['clockMode', 'clock', 'timelineId', 'timelineName', 'timelines',
      'includeOtherEvents', 'shareFacts'].filter(key => own?.[key] !== undefined).map(key => [key, own[key]])) });
  }
  function parts(time, timeZone) {
    const fields = new Intl.DateTimeFormat('en-CA', { timeZone: zone(timeZone), year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(time));
    return Object.fromEntries(fields.filter(field => field.type !== 'literal').map(field => [field.type, Number(field.value)]));
  }
  function localDate(time, timeZone) {
    const p = parts(time, timeZone);
    const date = new Date(0);
    date.setFullYear(p.year, p.month - 1, p.day);
    date.setHours(p.hour, p.minute, p.second, new Date(time).getMilliseconds());
    return date;
  }
  function fromParts(p, timeZone) {
    const desired = new Date(0);
    desired.setUTCFullYear(p.year, p.month - 1, p.day);
    desired.setUTCHours(p.hour || 0, p.minute || 0, p.second || 0, p.millisecond || 0);
    let result = desired.getTime();
    for (let attempt = 0; attempt < 4; attempt++) {
      const actual = parts(result, timeZone);
      const represented = new Date(0);
      represented.setUTCFullYear(actual.year, actual.month - 1, actual.day);
      represented.setUTCHours(actual.hour, actual.minute, actual.second, p.millisecond || 0);
      const difference = desired.getTime() - represented.getTime();
      result += difference;
      if (!difference) break;
    }
    const actual = parts(result, timeZone);
    if (['year', 'month', 'day', 'hour', 'minute'].some(key => actual[key] !== (p[key] || 0))) {
      throw new Error('这个日期或时刻在所选时区不存在，请重新填写');
    }
    return result;
  }
  function fromLocalDate(date, timeZone) {
    return fromParts({ year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(),
      hour: date.getHours(), minute: date.getMinutes(), second: date.getSeconds(), millisecond: date.getMilliseconds() }, timeZone);
  }
  function toInput(time, timeZone) {
    if (!finite(time)) return '';
    const p = parts(Number(time), timeZone);
    const pad = number => String(number).padStart(2, '0');
    return `${String(p.year).padStart(4, '0')}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
  }
  function parseInput(value, timeZone) {
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/);
    if (!match) throw new Error('请填写完整日期和时间');
    return fromParts({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
      hour: match[4] === undefined ? 12 : Number(match[4]), minute: Number(match[5] || 0) }, timeZone);
  }
  function format(time, timeZone, dayOnly = false, language = 'zh-CN') {
    if (!finite(time)) return language === 'en-US' ? 'Time unknown' : '时间不明';
    return new Date(Number(time)).toLocaleString(language, { timeZone: zone(timeZone), year: 'numeric', month: '2-digit', day: '2-digit',
      ...(dayOnly ? {} : { hour: '2-digit', minute: '2-digit', hour12: false }) });
  }
  function globalClock(real = Date.now()) {
    const timeZone = zone();
    const enabled = localStorage.getItem('custom-time-enabled') === 'true';
    const fields = ['year', 'month', 'day', 'hour', 'minute'].map(key => localStorage.getItem(`custom-time-${key}`));
    const anchor = Number(localStorage.getItem('custom-time-anchor'));
    const paused = localStorage.getItem('custom-time-paused') === 'true';
    const pausedValue = localStorage.getItem('custom-time-paused-value');
    const storedRate = Number(localStorage.getItem('custom-time-rate') ?? 1);
    const rate = finite(storedRate) && storedRate >= 0 ? storedRate : 1;
    if (enabled && paused && finite(pausedValue)) return { time: Number(pausedValue), timeZone, enabled: true, paused, rate };
    if (enabled && fields.every(value => value !== null && value !== '') && anchor > 0) {
      const exact = localStorage.getItem('custom-time-base-value');
      const base = finite(exact) ? Number(exact) : new Date(Number(fields[0]), Number(fields[1]) - 1, Number(fields[2]), Number(fields[3]), Number(fields[4])).getTime();
      if (Number.isFinite(base)) return { time: base + (real - anchor) * rate, timeZone, enabled: true, paused: false, rate };
    }
    return { time: real, timeZone, enabled: false, paused: false, rate: 1 };
  }
  function clock(chat, real = Date.now()) {
    const settings = config(chat);
    const own = settings.clock;
    if (settings.clockMode === 'independent' && own && finite(own.anchorTime) && finite(own.anchorReal)) {
      const rate = finite(own.rate) && Number(own.rate) >= 0 ? Number(own.rate) : 1;
      return { time: Number(own.anchorTime) + (own.paused ? 0 : (real - Number(own.anchorReal)) * rate),
        timeZone: zone(own.timeZone), enabled: true, paused: !!own.paused, rate };
    }
    return globalClock(real);
  }
  function customTime(chat) {
    const current = clock(chat);
    const date = localDate(current.time, current.timeZone);
    return { enabled: current.enabled, year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(),
      hour: date.getHours(), minute: date.getMinutes(), date, timestamp: current.time, timeZone: current.timeZone,
      formatted: format(current.time, current.timeZone) };
  }
  function capture(message, chat, existing = false) {
    if (!message || typeof message !== 'object' || message.memoryClock || known.has(message)) return false;
    if (existing || !finite(message.timestamp) || Number(message.timestamp) < sessionStart || Number(message.timestamp) > Date.now() + 60000) {
      known.add(message); return false;
    }
    const settings = config(chat);
    const real = Number(message.timestamp);
    const world = clock(chat, real);
    message.memoryClock = { realTime: real, worldTime: world.time, timeZone: world.timeZone,
      timeSource: settings.linked && world.enabled ? 'world' : 'real', linked: settings.linked,
      timelineId: settings.timelineId, timelineName: settings.timelineName,
      policy: { relativeBasis: settings.relativeBasis, explicitPriority: settings.explicitPriority, undated: settings.undated } };
    return true;
  }
  function observe(chat) {
    if (!Array.isArray(chat?.history) || observed.has(chat.history)) return chat;
    const history = chat.history;
    history.forEach(message => { if (message && typeof message === 'object') known.add(message); });
    observed.set(history, chat);
    // Only the particular history array is decorated. JSON/IndexedDB keep plain arrays.
    for (const method of ['push', 'unshift', 'splice']) {
      Object.defineProperty(history, method, { configurable: true, writable: true, enumerable: false, value: function (...args) {
        const additions = method === 'splice' ? args.slice(2) : args;
        additions.forEach(message => capture(message, chat));
        return Array.prototype[method].apply(this, args);
      } });
    }
    return chat;
  }
  function flush(chat) {
    const chats = chat ? [chat] : Object.values(window.state?.chats || {});
    for (const item of chats) {
      (item.history || []).forEach(message => capture(message, item));
      observe(item);
    }
  }
  function attachDatabase(database) {
    if (!database?.chats?.hook || database.__memoryClockAttached) return;
    database.__memoryClockAttached = true;
    database.chats.hook('reading', chat => observe(chat));
    database.chats.hook('creating', function (_, chat) {
      observe(chat);
      const live = window.state?.chats?.[chat.id];
      if (live) observe(live);
    });
    database.chats.hook('updating', function (changes, id, previous) {
      if (!Array.isArray(changes.history)) return;
      const keys = new Set((previous.history || []).map(message => `${message.id || ''}:${message.timestamp}:${message.role}:${message.type || ''}`));
      const next = { ...previous, ...changes };
      let changed = false;
      for (const message of changes.history) {
        const key = `${message.id || ''}:${message.timestamp}:${message.role}:${message.type || ''}`;
        if (keys.has(key)) continue;
        if (capture(message, next)) {
          changed = true;
          const live = window.state?.chats?.[id]?.history?.find(item => `${item.id || ''}:${item.timestamp}:${item.role}:${item.type || ''}` === key);
          if (live && !live.memoryClock) live.memoryClock = copy(message.memoryClock);
        }
      }
      if (changed) return { history: changes.history };
    });
  }
  async function saveConfig(chat, value) {
    flush(chat);
    const old = chat.settings.memoryTime;
    chat.settings.memoryTime = value.inherit ? { ...copy(value), inherit: true } : { ...normalize(copy(value)), inherit: false };
    try { await window.db.chats.put(chat); }
    catch (error) { if (old === undefined) delete chat.settings.memoryTime; else chat.settings.memoryTime = old; throw error; }
    if (chat.variableMemory) chat.variableMemory._retrievalCache = { query: '', resultIds: [], timestamp: 0, msgCount: 0 };
  }
  async function saveGlobal(value) {
    flush();
    const next = normalize(value);
    const settings = window.state.globalSettings;
    const previous = settings.memoryTimeDefault;
    settings.memoryTimeDefault = next;
    try { await window.db.globalSettings.put(settings); }
    catch (error) { if (previous === undefined) delete settings.memoryTimeDefault; else settings.memoryTimeDefault = previous; throw error; }
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch (_) { /* IndexedDB remains authoritative. */ }
    Object.values(window.state.chats || {}).forEach(chat => {
      if (chat.variableMemory) chat.variableMemory._retrievalCache = { query: '', resultIds: [], timestamp: 0, msgCount: 0 };
    });
  }
  function messageTime(message, relative = false) {
    const snapshot = message?.memoryClock;
    if (!snapshot || !snapshot.linked || (relative && snapshot.policy?.relativeBasis === 'real')) return Number(message?.timestamp);
    return snapshot.timeSource === 'world' ? Number(snapshot.worldTime) : Number(message.timestamp);
  }
  function label(fragment) {
    if (!fragment.clockVersion) return '';
    if (fragment.timeBasis === 'fictional') return '剧情纪年';
    if (!finite(fragment.memoryTime)) return '时间不明';
    if (fragment.timeBasis === 'manual') return '手动指定';
    if (fragment.timeBasis === 'unknown') return '时间不明';
    if (fragment.timeBasis === 'fictional') return '剧情纪年';
    if (fragment.timeBasis === 'explicit') return '原文日期';
    return fragment.timeSource === 'world' ? '世界时间' : '现实时间';
  }
  function visible(chat, fragment) {
    if (!fragment.clockVersion) return true;
    const settings = config(chat);
    if (fragment.timelineId === settings.timelineId) return true;
    return ['C', 'U', 'A', 'T'].includes(fragment.category) ? settings.shareFacts : settings.includeOtherEvents;
  }
  function temporalNote(chat, fragment, language = 'zh') {
    if (!fragment.clockVersion) return '';
    const foreign = fragment.timelineId !== config(chat).timelineId;
    const current = clock(chat);
    const future = finite(fragment.memoryTime) && (fragment.timePrecision === 'day'
      ? toInput(fragment.memoryTime, fragment.memoryTimeZone || current.timeZone).slice(0, 10) > toInput(current.time, fragment.memoryTimeZone || current.timeZone).slice(0, 10)
      : Number(fragment.memoryTime) > current.time + 60000);
    if (fragment.category === 'P' && !['completed', 'cancelled', 'fulfilled', 'done'].includes(fragment.status)) {
      return language === 'en' ? '(plan; not yet an accomplished event) ' : '（约定／计划，不能当作已完成经历）';
    }
    if (foreign) return language === 'en' ? `(timeline: ${fragment.timelineName || fragment.timelineId}) ` : `（时间线：${fragment.timelineName || fragment.timelineId}）`;
    if (future) return language === 'en' ? '(recorded experience after the current world date; do not treat it as already happened in this date) '
      : '（已记录经历晚于当前世界日期，请区分穿越经历与当前日期，不要当作当前日期前已发生的事）';
    return '';
  }
  function promptRules(chat, language = 'zh') {
    if (!chat.variableMemory?.fragments?.some(fragment => fragment.clockVersion && visible(chat, fragment))) return '';
    return language === 'en'
      ? '[Memory date rules: use each event date and status. Plans are not accomplished experiences. Records from other timelines or later than the current world date must not be presented as already happened before this date.]\n'
      : '[记忆日期规则：以每条事件日期与状态为准；约定和计划不是已完成经历；标为其他时间线或晚于当前世界日期的记录，不得当作当前日期之前已经发生的往事。]\n';
  }
  function decay(chat, fragment) {
    const settings = config(chat);
    if (settings.decayBasis === 'off') return 1;
    if (!finite(fragment.memoryTime)) return 0.5;
    const current = settings.decayBasis === 'real' || fragment.timeSource !== 'world' ? Date.now() : clock(chat).time;
    const realSources = (fragment.sourceEvidence || []).map(source => Number(source.timestamp)).filter(Number.isFinite);
    const eventTime = settings.decayBasis === 'real' && fragment.timeSource === 'world' && realSources.length
      ? Math.max(...realSources) : Number(fragment.memoryTime);
    const age = Math.max(0, current - eventTime);
    return Math.max(0.1, Math.exp(-0.693 * age / (86400000 * settings.halfLifeDays)));
  }
  function manualData(chat) {
    const current = clock(chat);
    const settings = config(chat);
    return { clockVersion: 1, memoryTime: settings.linked ? current.time : Date.now(), memoryTimeZone: current.timeZone,
      timeSource: settings.linked && current.enabled ? 'world' : 'real', timelineId: settings.timelineId, timelineName: settings.timelineName };
  }
  async function shiftDates(chat, ids, days, undo = false) {
    const vm = chat.variableMemory;
    if (window.vectorMemoryManager._extractionLocks.get(chat)) throw new Error('请先结束记忆提取再调整日期');
    const fields = ['memoryTime', 'memoryTimeEnd', 'plannedTime', 'timeBasis', 'timePrecision', 'eventTimeText', 'timeEvidence', 'timeSource'];
    const before = copy(vm.fragments);
    const nextFragments = copy(vm.fragments);
    const priorBackup = vm.timeShiftBackup;
    let nextBackup = priorBackup;
    if (undo) {
      if (!priorBackup) throw new Error('没有可撤销的日期调整');
      for (const record of priorBackup) {
        const fragment = nextFragments.find(item => item.id === record.id);
        if (fragment) { Object.assign(fragment, record.fields); (record.absent || []).forEach(key => delete fragment[key]); }
      }
      nextBackup = null;
    } else {
      if (!Number.isInteger(days)) throw new Error('请填写整数天数，可用负数向前调整');
      const selected = nextFragments.filter(item => ids.includes(item.id) && finite(item.memoryTime));
      if (!selected.length) throw new Error('所选记忆没有可调整的日期');
      nextBackup = selected.map(item => ({ id: item.id, fields: Object.fromEntries(fields.filter(key => Object.prototype.hasOwnProperty.call(item, key)).map(key => [key, item[key]])),
        absent: fields.filter(key => !Object.prototype.hasOwnProperty.call(item, key)) }));
      for (const item of selected) {
        for (const key of ['memoryTime', 'memoryTimeEnd', 'plannedTime']) {
          if (!finite(item[key])) continue;
          const date = localDate(item[key], item.memoryTimeZone || zone());
          date.setDate(date.getDate() + days);
          item[key] = fromLocalDate(date, item.memoryTimeZone || zone());
        }
        item.timeBasis = 'manual'; item.eventTimeText = '';
      }
    }
    vm.fragments = nextFragments;
    if (nextBackup) vm.timeShiftBackup = nextBackup; else delete vm.timeShiftBackup;
    try { await window.db.chats.put(chat); }
    catch (error) { vm.fragments = before; if (priorBackup) vm.timeShiftBackup = priorBackup; else delete vm.timeShiftBackup; throw error; }
    vm._retrievalCache = { query: '', resultIds: [], timestamp: 0, msgCount: 0 };
  }
  window.MemoryWorldTime = { defaults, normalize, validateConfig, config, globalConfig, clock, globalClock, customTime, capture, observe, flush,
    attachDatabase, saveConfig, saveGlobal, zone, parts, localDate, fromLocalDate, format, parseInput, toInput, messageTime,
    label, visible, temporalNote, promptRules, decay, manualData, shiftDates };
  attachDatabase(window.db);
})();
