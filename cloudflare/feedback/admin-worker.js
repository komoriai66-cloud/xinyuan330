import { ADMIN_HTML } from './admin-page.js';
import { json, fail, visibleThread, plain, deleteThread, uuidPattern, sha256, tokenPattern, checkedImage, parseFormRequest } from './shared.js';
import { workbenchRoute, readMessages, isClosed, addAdminReply } from './workbench.js';

async function route(request, env) {
  const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
  if (path === '/' && request.method === 'GET') return new Response(ADMIN_HTML, { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src blob: data:; base-uri 'none'; frame-ancestors 'none'",
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
  } });

  if (path === '/api/session' && request.method === 'GET') return json({ ok: true });
  const enhanced = await workbenchRoute(request, env, true);
  if (enhanced) return enhanced;

  if (path === '/api/threads' && request.method === 'GET') {
    const params = new URL(request.url).searchParams;
    const cursor = params.get('before') || '';
    const match = /^(\d+):([0-9a-f-]{36})$/i.exec(cursor);
    if (cursor && !match) return fail('分页参数无效。');
    const product = params.get('product') || 'all';
    const kind = params.get('kind') || 'all';
    const status = params.get('status') || 'all';
    const search = plain(params.get('q'), 80);
    if (!['all', 'ephone', 'uwu'].includes(product) || !['all', 'private', 'public'].includes(kind) ||
        !['all', 'unread', 'waiting', 'revisit', 'needs_reply', 'open', 'pending', 'visible', 'hidden', 'closed'].includes(status)) return fail('筛选参数无效。');
    const where = [];
    const values = [];
    if (product !== 'all') { where.push('product = ?'); values.push(product); }
    if (kind !== 'all') { where.push('kind = ?'); values.push(kind); }
    if (status === 'needs_reply') { where.push("visitor_closed = 0 AND author_closed = 0 AND status NOT IN ('closed','hidden') AND triage = 'reply' AND snoozed_until <= ? AND max(last_visitor_at,last_visitor_change_at) > last_admin_at"); values.push(Date.now()); }
    else if (status === 'unread') where.push('max(last_visitor_at,last_visitor_change_at) > admin_seen_at');
    else if (status === 'waiting') where.push("triage = 'waiting'");
    else if (status === 'revisit') { where.push('snoozed_until > 0 AND snoozed_until <= ?'); values.push(Date.now()); }
    else if (status === 'closed') where.push("(visitor_closed = 1 OR author_closed = 1 OR status = 'closed')");
    else if (status === 'pending') where.push("(status = 'pending' OR EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = threads.id AND m.state = 'active' AND m.moderation = 'pending'))");
    else if (status !== 'all') { where.push('status = ?'); values.push(status); }
    if (search) { where.push(`(instr(lower(title),lower(?)) > 0 OR instr(lower(id),lower(?)) > 0 OR instr(lower(note),lower(?)) > 0
      OR EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = threads.id AND m.state = 'active' AND instr(lower(m.body),lower(?)) > 0))`); values.push(search,search,search,search); }
    if (match) { where.push('(updated_at < ? OR (updated_at = ? AND id < ?))'); values.push(Number(match[1]), Number(match[1]), match[2]); }
    const query = `SELECT id, product, kind, category, title, nickname, status, visitor_closed, author_closed, admin_seen_at, triage, snoozed_until, outcome, created_at, updated_at, last_admin_at, last_visitor_at, last_visitor_change_at
      FROM threads ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY updated_at DESC, id DESC LIMIT 101`;
    const rows = await env.DB.prepare(query).bind(...values).all();
    const page = (rows.results || []).slice(0, 100);
    const last = page.at(-1);
    return json({ threads: page, nextCursor: (rows.results || []).length > 100 ? `${last.updated_at}:${last.id}` : null });
  }
  const threadRoute = /^\/api\/threads\/([0-9a-f-]{36})$/i.exec(path);
  if (threadRoute && request.method === 'GET') {
    const thread = await env.DB.prepare('SELECT * FROM threads WHERE id = ?').bind(threadRoute[1]).first();
    if (!thread) return fail('对话不存在。', 404);
    const links = await env.DB.prepare('SELECT tasks.id, tasks.title, tasks.state FROM tasks JOIN task_threads l ON l.task_id = tasks.id WHERE l.thread_id = ?').bind(thread.id).all();
    return json({ thread: { ...visibleThread(thread), note: thread.note, triage: thread.triage, snoozed_until: thread.snoozed_until, admin_seen_at:thread.admin_seen_at }, messages: await readMessages(env,thread,true), tasks:links.results || [] });
  }
  if (threadRoute && request.method === 'PATCH') {
    const thread = await env.DB.prepare('SELECT * FROM threads WHERE id = ?').bind(threadRoute[1]).first();
    if (!thread) return fail('对话不存在。', 404);
    const body = await request.json();
    if (body.status !== undefined) {
      const allowed = thread.kind === 'public' ? ['pending', 'visible', 'hidden', 'closed'] : ['open', 'closed'];
      if (!allowed.includes(body.status)) return fail('状态无效。');
      if (body.status === 'closed') {
        await env.DB.prepare('UPDATE threads SET author_closed = 1, updated_at = ? WHERE id = ?').bind(Date.now(),thread.id).run();
      } else {
        const statements = [env.DB.prepare('UPDATE threads SET status = ?, author_closed = 0, updated_at = ? WHERE id = ?').bind(body.status,Date.now(),thread.id)];
        if (body.status === 'visible' && thread.status === 'pending') {
          statements.push(env.DB.prepare("UPDATE messages SET moderation = 'approved', version = version + 1 WHERE thread_id = ? AND state = 'active' AND moderation = 'pending'").bind(thread.id));
          statements.push(env.DB.prepare('UPDATE threads SET public_title = title WHERE id = ?').bind(thread.id));
        }
        await env.DB.batch(statements);
      }
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
    const thread = await env.DB.prepare('SELECT * FROM threads WHERE id = ?').bind(replyRoute[1]).first();
    if (!thread) return fail('对话不存在。', 404);
    if (isClosed(thread)) return fail('此对话已结束，不能继续回信。',409);
    let body, image = null, id;
    if ((request.headers.get('Content-Type') || '').startsWith('multipart/form-data')) {
      const form = await parseFormRequest(request); body = plain(form.get('body'),5000); image = await checkedImage(form); id = String(form.get('messageId') || '');
      if (!uuidPattern.test(id)) return fail('消息编号无效。');
    } else { body = plain((await request.json()).body,5000); id = crypto.randomUUID(); }
    if (!body && !image) return fail('请输入文字或附图。');
    return addAdminReply(env,thread,body,image,id);
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
      const inputError = /^(截图|请求格式|只支持)/.test(error?.message || '');
      return fail(inputError ? error.message : '服务暂时不可用，请稍后重试。', inputError ? 400 : 500);
    }
  }
};
