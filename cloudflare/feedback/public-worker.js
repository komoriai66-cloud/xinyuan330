import {
  uuidPattern, tokenPattern, categories, json, fail, sha256, owns, visibleThread,
  plain, verifyTurnstile, checkedImage, parseFormRequest, deleteThread
} from './shared.js';
import { workbenchRoute, readMessages, isClosed } from './workbench.js';

function corsHeaders(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  let localOrigin = false;
  try {
    const url = new URL(origin);
    localOrigin = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.origin === origin;
  } catch (_) { /* Invalid or opaque origins are denied. */ }
  return origin && (allowed.includes(origin) || localOrigin) ? {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-EPhone-Feedback',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin'
  } : {};
}
async function rateLimit(request, env, scope) {
  if (!env.RATE_LIMITER) return false;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const result = await env.RATE_LIMITER.limit({ key: `${scope}:${ip}` });
  return result.success;
}
async function readLimit(request, env) {
  if (!env.READ_LIMITER) return false;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const result = await env.READ_LIMITER.limit({ key: ip });
  return result.success;
}
async function threadById(env, id) {
  return env.DB.prepare('SELECT * FROM threads WHERE id = ?').bind(id).first();
}
async function messagesFor(env, threadId) {
  const result = await env.DB.prepare('SELECT id, sender, body, attachment_key, attachment_type, created_at FROM messages WHERE thread_id = ? ORDER BY created_at, id').bind(threadId).all();
  return result.results || [];
}
async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path === '/health' && request.method === 'GET') return json({ ok: true });
  if (!env.DB) return fail('数据库尚未配置。', 503);
  if ((request.method === 'GET' || path === '/inbox') && !(await readLimit(request, env))) {
    return fail('访问过于频繁，请稍后再试。', 429);
  }
  const enhanced = await workbenchRoute(request, env, false);
  if (enhanced) return enhanced;

  if (path === '/inbox' && request.method === 'POST') {
    const entries = (await request.json()).threads;
    if (!Array.isArray(entries) || entries.length > 30) return fail('对话列表无效。');
    const valid = entries.filter(item => uuidPattern.test(item?.id || '') && tokenPattern.test(item?.token || ''));
    if (!valid.length) return json({ threads: [] });
    const placeholders = valid.map(() => '?').join(',');
    const rows = await env.DB.prepare(`SELECT id, product, kind, title, status, visitor_closed, author_closed, updated_at, last_admin_at, last_admin_change_at, outcome, secret_hash
      FROM threads WHERE id IN (${placeholders})`).bind(...valid.map(item => item.id)).all();
    const result = [];
    for (const row of rows.results || []) {
      const entry = valid.find(item => item.id === row.id);
      if ((await sha256(entry.token)) === row.secret_hash) {
        const { secret_hash, ...safe } = row;
        result.push(safe);
      }
    }
    return json({ threads: result });
  }

  if (path === '/public/threads' && request.method === 'GET') {
    const product = url.searchParams.get('product') || 'ephone';
    if (!['ephone', 'uwu'].includes(product)) return fail('应用来源无效。');
    const cursor = url.searchParams.get('before') || '';
    const match = /^(\d+):([0-9a-f-]{36})$/i.exec(cursor);
    if (cursor && !match) return fail('分页参数无效。');
    const search = plain(url.searchParams.get('q'), 80);
    const category = url.searchParams.get('category') || 'all';
    if (category !== 'all' && !categories.has(category)) return fail('分类无效。');
    const query = `SELECT id, product, kind, category, public_title AS title, nickname, status, created_at, updated_at, outcome
      FROM threads WHERE product = ? AND kind = 'public' AND status = 'visible'
      AND (? = 'all' OR category = ?) AND (instr(lower(public_title),lower(?)) > 0 OR EXISTS
        (SELECT 1 FROM messages m WHERE m.thread_id = threads.id AND m.state = 'active' AND m.moderation = 'approved' AND instr(lower(m.body),lower(?)) > 0))
      ${match ? 'AND (created_at < ? OR (created_at = ? AND id < ?))' : ''}
      ORDER BY created_at DESC, id DESC LIMIT 21`;
    const statement = env.DB.prepare(query);
    const values = [product, category, category, search, search];
    if (match) values.push(Number(match[1]), Number(match[1]), match[2]);
    const rows = await statement.bind(...values).all();
    const page = (rows.results || []).slice(0, 20);
    const last = page.at(-1);
    return json({ threads: page, nextCursor: (rows.results || []).length > 20 ? `${last.created_at}:${last.id}` : null });
  }

  const threadRoute = /^\/threads\/([0-9a-f-]{36})$/i.exec(path);
  if (threadRoute && request.method === 'GET') {
    const thread = await threadById(env, threadRoute[1]);
    if (!thread) return fail('对话不存在。', 404);
    const owner = await owns(request, thread);
    if (!owner && !(thread.kind === 'public' && thread.status === 'visible')) {
      return fail('无权查看此对话。', 403);
    }
    return json({ thread: visibleThread(thread, owner), messages: await readMessages(env, thread, owner) });
  }

  if (path === '/threads' && request.method === 'POST') {
    if (!(await rateLimit(request, env, 'create'))) return fail('提交过于频繁，请稍后再试。', 429);
    if (Number(request.headers.get('Content-Length')) > 1300000) return fail('内容过大。', 413);
    const form = await parseFormRequest(request);
    const id = String(form.get('id') || '');
    const token = String(form.get('token') || '');
    const kind = String(form.get('kind') || '');
    const product = String(form.get('product') || 'ephone');
    const category = String(form.get('category') || '');
    const title = plain(form.get('title'), 80);
    const body = plain(form.get('body'), 5000);
    const nickname = kind === 'public' ? plain(form.get('nickname'), 24) : '';
    const environment = plain(form.get('environment'), 1000);
    if (!uuidPattern.test(id) || !tokenPattern.test(token) || !['private', 'public'].includes(kind) ||
        !['ephone', 'uwu'].includes(product) ||
        !categories.has(category) || !title || !body) return fail('请填写有效的标题和内容。');
    const existing = await threadById(env, id);
    if (existing) return (await sha256(token)) === existing.secret_hash
      ? json({ thread: visibleThread(existing) }) : fail('对话编号冲突。', 409);
    if (!(await verifyTurnstile(env, form.get('turnstileToken')))) return fail('人机验证失败，请重试。', 403);
    const image = await checkedImage(form);
    const now = Date.now();
    const statements = [
        env.DB.prepare(`INSERT INTO threads (id, product, kind, category, title, public_title, nickname, secret_hash, status, environment, created_at, updated_at, last_visitor_at, last_visitor_change_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, product, kind, category, title, title, nickname, await sha256(token), kind === 'private' ? 'open' : 'pending', environment, now, now, now, now)
    ];
    if (image) statements.push(env.DB.prepare(`INSERT INTO attachments (key, thread_id, content_type, data, created_at)
      VALUES (?, ?, ?, ?, ?)`).bind(image.key, id, image.type, image.bytes, now));
    statements.push(
        env.DB.prepare(`INSERT INTO messages (id, thread_id, sender, body, attachment_key, attachment_type, created_at)
          VALUES (?, ?, 'visitor', ?, ?, ?, ?)`).bind(crypto.randomUUID(), id, body, image?.key || null, image?.type || null, now)
    );
    await env.DB.batch(statements);
    const thread = await threadById(env, id);
    return json({ thread: visibleThread(thread) }, 201);
  }

  const messageRoute = /^\/threads\/([0-9a-f-]{36})\/messages$/i.exec(path);
  if (messageRoute && request.method === 'POST') {
    const thread = await threadById(env, messageRoute[1]);
    if (!thread) return fail('对话不存在。', 404);
    if (!(await owns(request, thread))) return fail('无权回复此对话。', 403);
    if (isClosed(thread) || thread.status === 'hidden') return fail('此对话已关闭。', 409);
    if (!(await rateLimit(request, env, 'message'))) return fail('发送过于频繁，请稍后再试。', 429);
    if (Number(request.headers.get('Content-Length')) > 1300000) return fail('内容过大。', 413);
    const form = await parseFormRequest(request);
    const messageId = String(form.get('messageId') || '');
    const body = plain(form.get('body'), 5000);
    if (!uuidPattern.test(messageId)) return fail('消息编号无效。');
    const existing = await env.DB.prepare('SELECT id FROM messages WHERE id = ? AND thread_id = ?').bind(messageId, thread.id).first();
    if (existing) return json({ ok: true });
    if (!(await verifyTurnstile(env, form.get('turnstileToken')))) return fail('人机验证失败，请重试。', 403);
    const image = await checkedImage(form);
    if (!body && !image) return fail('请输入文字或附图。');
    const now = Math.max(Date.now(), thread.updated_at + 1);
    const statements = [];
    if (image) statements.push(env.DB.prepare(`INSERT INTO attachments (key, thread_id, content_type, data, created_at)
      VALUES (?, ?, ?, ?, ?)`).bind(image.key, thread.id, image.type, image.bytes, now));
    statements.push(
        env.DB.prepare(`INSERT INTO messages (id, thread_id, sender, body, attachment_key, attachment_type, moderation, created_at)
          VALUES (?, ?, 'visitor', ?, ?, ?, ?, ?)`).bind(messageId, thread.id, body, image?.key || null, image?.type || null, thread.kind === 'public' ? 'pending' : 'approved', now),
        env.DB.prepare("UPDATE threads SET updated_at = ?, last_visitor_at = ?, last_visitor_change_at = ?, triage = 'reply', snoozed_until = 0 WHERE id = ?").bind(now, now, now, thread.id)
    );
    await env.DB.batch(statements);
    return json({ ok: true }, 201);
  }

  if (threadRoute && request.method === 'PATCH') {
    const thread = await threadById(env, threadRoute[1]);
    if (!thread) return fail('对话不存在。', 404);
    if (!(await owns(request, thread))) return fail('无权关闭此对话。', 403);
    await env.DB.prepare('UPDATE threads SET visitor_closed = 1, updated_at = ? WHERE id = ?')
      .bind(Date.now(), thread.id).run();
    return json({ ok: true });
  }

  if (threadRoute && request.method === 'DELETE') {
    const thread = await threadById(env, threadRoute[1]);
    if (!thread) return fail('对话不存在。', 404);
    if (!(await owns(request, thread))) return fail('无权删除此对话。', 403);
    await deleteThread(env, thread.id);
    return json({ ok: true });
  }

  const attachmentRoute = /^\/attachments\/([0-9a-f-]{36})$/i.exec(path);
  if (attachmentRoute && request.method === 'GET') {
    const row = await env.DB.prepare(`SELECT a.content_type, a.data, t.*, m.state AS message_state, m.moderation FROM attachments a
      JOIN threads t ON t.id = a.thread_id JOIN messages m ON m.attachment_key = a.key WHERE a.key = ?`).bind(attachmentRoute[1]).first();
    if (!row) return fail('截图不存在。', 404);
    if (!(await owns(request, row)) && !(row.kind === 'public' && row.status === 'visible' && row.message_state === 'active' && row.moderation === 'approved')) {
      return fail('无权查看截图。', 403);
    }
    return new Response(new Uint8Array(row.data), { headers: {
      'Content-Type': row.content_type,
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store'
    } });
  }
  return fail('接口不存在。', 404);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin, env);
    if (origin && !cors['Access-Control-Allow-Origin']) return fail('来源不受允许。', 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let response;
    try { response = await route(request, env); }
    catch (error) {
      console.error('feedback request failed', error?.name || 'Error');
      const inputError = error instanceof Error && /^(截图|请求格式|只支持)/.test(error.message);
      response = fail(inputError ? error.message : '服务暂时不可用，请稍后重试。', inputError ? 400 : 500);
    }
    const headers = new Headers(response.headers);
    Object.entries(cors).forEach(([key, value]) => headers.set(key, value));
    headers.set('Cache-Control', 'no-store');
    return new Response(response.body, { status: response.status, headers });
  }
};
