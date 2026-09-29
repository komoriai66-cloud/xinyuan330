import { ADMIN_HTML } from './admin-page.js';
import { json, fail, visibleThread, plain, deleteThread, uuidPattern, sha256, tokenPattern } from './shared.js';

async function route(request, env) {
  const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
  if (path === '/' && request.method === 'GET') return new Response(ADMIN_HTML, { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src blob:; base-uri 'none'; frame-ancestors 'none'",
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
  } });

  if (path === '/api/session' && request.method === 'GET') return json({ ok: true });

  if (path === '/api/threads' && request.method === 'GET') {
    const cursor = new URL(request.url).searchParams.get('before') || '';
    const match = /^(\d+):([0-9a-f-]{36})$/i.exec(cursor);
    if (cursor && !match) return fail('分页参数无效。');
    const query = `SELECT id, kind, category, title, nickname, status, visitor_closed, created_at, updated_at, last_admin_at, last_visitor_at
      FROM threads ${match ? 'WHERE updated_at < ? OR (updated_at = ? AND id < ?)' : ''}
      ORDER BY updated_at DESC, id DESC LIMIT 101`;
    const statement = env.DB.prepare(query);
    const rows = await (match ? statement.bind(Number(match[1]), Number(match[1]), match[2]) : statement).all();
    const page = (rows.results || []).slice(0, 100);
    const last = page.at(-1);
    return json({ threads: page, nextCursor: (rows.results || []).length > 100 ? `${last.updated_at}:${last.id}` : null });
  }
  const threadRoute = /^\/api\/threads\/([0-9a-f-]{36})$/i.exec(path);
  if (threadRoute && request.method === 'GET') {
    const thread = await env.DB.prepare('SELECT * FROM threads WHERE id = ?').bind(threadRoute[1]).first();
    if (!thread) return fail('对话不存在。', 404);
    const messages = await env.DB.prepare(`SELECT id, sender, body, attachment_key, attachment_type, created_at
      FROM messages WHERE thread_id = ? ORDER BY created_at, id`).bind(thread.id).all();
    return json({ thread: { ...visibleThread(thread), note: thread.note }, messages: messages.results || [] });
  }
  if (threadRoute && request.method === 'PATCH') {
    const thread = await env.DB.prepare('SELECT * FROM threads WHERE id = ?').bind(threadRoute[1]).first();
    if (!thread) return fail('对话不存在。', 404);
    const body = await request.json();
    if (body.status !== undefined) {
      const allowed = thread.kind === 'public' ? ['pending', 'visible', 'hidden', 'closed'] : ['open', 'closed'];
      if (!allowed.includes(body.status)) return fail('状态无效。');
      await env.DB.prepare('UPDATE threads SET status = ?, updated_at = ? WHERE id = ?').bind(body.status, Date.now(), thread.id).run();
    }
    if (body.note !== undefined) {
      await env.DB.prepare('UPDATE threads SET note = ? WHERE id = ?').bind(plain(body.note, 1000), thread.id).run();
    }
    return json({ ok: true });
  }
  if (threadRoute && request.method === 'DELETE') {
    await deleteThread(env, threadRoute[1]);
    return json({ ok: true });
  }
  const replyRoute = /^\/api\/threads\/([0-9a-f-]{36})\/reply$/i.exec(path);
  if (replyRoute && request.method === 'POST') {
    const thread = await env.DB.prepare('SELECT id, status, visitor_closed, updated_at FROM threads WHERE id = ?').bind(replyRoute[1]).first();
    if (!thread) return fail('对话不存在。', 404);
    if (thread.status === 'closed') return fail('请先重新打开对话。', 409);
    if (thread.visitor_closed) return fail('投信者已关闭此对话。', 409);
    const body = plain((await request.json()).body, 5000);
    if (!body) return fail('请输入回复内容。');
    const now = Math.max(Date.now(), thread.updated_at + 1);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO messages (id, thread_id, sender, body, created_at)
        VALUES (?, ?, 'admin', ?, ?)`).bind(crypto.randomUUID(), thread.id, body, now),
      env.DB.prepare('UPDATE threads SET updated_at = ?, last_admin_at = ? WHERE id = ?').bind(now, now, thread.id)
    ]);
    return json({ ok: true }, 201);
  }
  const imageRoute = /^\/api\/attachments\/([0-9a-f-]{36})$/i.exec(path);
  if (imageRoute && request.method === 'GET') {
    const attachment = await env.DB.prepare('SELECT content_type, data FROM attachments WHERE key = ?').bind(imageRoute[1]).first();
    if (!attachment) return fail('截图不存在。', 404);
    return new Response(new Uint8Array(attachment.data), { headers: {
      'Content-Type': attachment.content_type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store'
    } });
  }
  return fail('页面不存在。', 404);
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
    if (path === '/' && request.method === 'GET') return route(request, env);
    const origin = request.headers.get('Origin');
    if (origin && origin !== new URL(request.url).origin) return fail('来源不受允许。', 403);
    try {
      if (!env.ADMIN_TOKEN_HASH || !env.ADMIN_LIMITER) return fail('管理登录尚未配置。', 503);
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (!(await env.ADMIN_LIMITER.limit({ key: ip })).success) return fail('尝试过于频繁，请稍后重试。', 429);
      const match = /^Bearer ([0-9a-f]{64})$/i.exec(request.headers.get('Authorization') || '');
      if (!match || !tokenPattern.test(match[1]) || (await sha256(match[1])) !== env.ADMIN_TOKEN_HASH) {
        return fail('管理员密钥无效。', 401);
      }
      if (!env.DB) return fail('数据库尚未配置。', 503);
      return await route(request, env);
    }
    catch (error) {
      console.error('feedback admin request failed', error?.name || 'Error');
      return fail('服务暂时不可用，请稍后重试。', 500);
    }
  }
};
