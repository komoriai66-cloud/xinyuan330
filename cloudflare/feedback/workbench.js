import {
  json,
  fail,
  plain,
  owns,
  uuidPattern,
  checkedImage,
  parseFormRequest,
  verifyTurnstile,
} from "./shared.js";

export const outcomes = new Set([
  "received",
  "need_info",
  "accepted",
  "declined",
  "resolved",
]);
const taskStates = new Set(["todo", "doing", "paused", "done"]);
const products = new Set(["ephone", "uwu"]);
export const isClosed = (thread) =>
  !!(
    thread.visitor_closed ||
    thread.author_closed ||
    thread.status === "closed"
  );
const nowFor = (thread) =>
  Math.max(Date.now(), Number(thread.updated_at || 0) + 1);
const threadById = (env, id) =>
  env.DB.prepare("SELECT * FROM threads WHERE id = ?").bind(id).first();
const rows = async (statement) => (await statement.all()).results || [];

export async function readMessages(env, thread, privileged) {
  const messages = await rows(
    env.DB.prepare(
      `SELECT id, sender, body, attachment_key, attachment_type,
    created_at, state, moderation, edited_at, version FROM messages WHERE thread_id = ? ORDER BY created_at, id`,
    ).bind(thread.id),
  );
  return messages.map((message) => {
    if (
      message.state !== "active" ||
      (!privileged && message.moderation !== "approved")
    ) {
      return {
        ...message,
        body: "",
        attachment_key: null,
        attachment_type: null,
      };
    }
    return message;
  });
}

function titleStatement(env, threadId) {
  // The first message can be edited or erased. Never leave its old text in a list title.
  return env.DB.prepare(
    `UPDATE threads SET title = COALESCE((SELECT CASE
    WHEN state = 'retracted' THEN '首条消息已撤回' WHEN state = 'removed' THEN '首条消息已移除'
    ELSE COALESCE(NULLIF(trim(substr(body, 1, 32)), ''), '附图反馈') END FROM messages WHERE thread_id = ? ORDER BY created_at, id LIMIT 1), '空对话'),
    public_title = COALESCE((SELECT CASE WHEN state = 'retracted' THEN '首条消息已撤回'
    WHEN state = 'removed' THEN '首条消息已移除' WHEN moderation = 'pending' THEN '内容待审核'
    ELSE COALESCE(NULLIF(trim(substr(body, 1, 32)), ''), '附图反馈') END FROM messages WHERE thread_id = ? ORDER BY created_at, id LIMIT 1), '空对话')
    WHERE id = ?`,
  ).bind(threadId, threadId, threadId);
}

async function mutationLimit(request, env, admin) {
  if (admin) return true; // Admin authentication and its limiter run before this router.
  if (!env.RATE_LIMITER) return false;
  return (
    await env.RATE_LIMITER.limit({
      key: `edit:${request.headers.get("CF-Connecting-IP") || "unknown"}`,
    })
  ).success;
}

async function changeMessage(request, env, admin, threadId, messageId, action) {
  const thread = await threadById(env, threadId);
  if (!thread) return fail("对话不存在。", 404);
  if (!admin && !(await owns(request, thread)))
    return fail("无权操作此消息。", 403);
  const message = await env.DB.prepare(
    "SELECT * FROM messages WHERE id = ? AND thread_id = ?",
  )
    .bind(messageId, threadId)
    .first();
  if (!message) return fail("消息不存在。", 404);
  const firstMessage = await env.DB.prepare(
    "SELECT id FROM messages WHERE thread_id = ? ORDER BY created_at, id LIMIT 1",
  )
    .bind(threadId)
    .first();
  const own = message.sender === (admin ? "admin" : "visitor");
  if (!own && !(admin && action === "remove"))
    return fail("只能修改、撤回或删除自己的消息。", 403);
  if (action === "remove" && (!admin || own))
    return fail("移除仅用于管理用户消息。", 403);
  if (!(await mutationLimit(request, env, admin)))
    return fail("操作过于频繁，请稍后再试。", 429);
  const form =
    request.method === "PATCH" ? await parseFormRequest(request) : null;
  const input = form ? { version: form.get("version") } : await request.json();
  if (Number(input.version) !== message.version)
    return fail("消息已发生变化，请刷新后再操作。", 409);
  if (message.state !== "active" && action !== "delete")
    return fail("此消息已经撤回或移除。", 409);
  let image = null;
  let body = "";
  let keepImage = false;
  if (action === "edit") {
    if (!admin && !(await verifyTurnstile(env, form.get("turnstileToken"))))
      return fail("人机验证失败，请重试。", 403);
    body = plain(form.get("body"), 5000);
    image = await checkedImage(form);
    keepImage = !image && form.get("removeImage") !== "1";
    if (!body && !image && !(keepImage && message.attachment_key))
      return fail("请填写文字或附图。");
  }
  const time = nowFor(thread);
  const statements = [];
  if (image)
    statements.push(
      env.DB.prepare(
        `INSERT INTO attachments (key, thread_id, content_type, data, created_at)
    SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM messages WHERE id = ? AND version = ?)`,
      ).bind(
        image.key,
        threadId,
        image.type,
        image.bytes,
        time,
        messageId,
        message.version,
      ),
    );
  if (message.attachment_key && !keepImage)
    statements.push(
      env.DB.prepare(
        `DELETE FROM attachments WHERE key = ?
    AND EXISTS (SELECT 1 FROM messages WHERE id = ? AND version = ?)`,
      ).bind(message.attachment_key, messageId, message.version),
    );
  const changeIndex = statements.length;
  if (action === "delete") {
    statements.push(
      env.DB.prepare(
        "DELETE FROM messages WHERE id = ? AND thread_id = ? AND version = ?",
      ).bind(messageId, threadId, message.version),
    );
  } else {
    statements.push(
      env.DB.prepare(
        `UPDATE messages SET body = ?, attachment_key = ?, attachment_type = ?,
      state = ?, moderation = ?, edited_at = ?, version = version + 1 WHERE id = ? AND thread_id = ? AND version = ?`,
      ).bind(
        body,
        image?.key || (keepImage ? message.attachment_key : null),
        image?.type || (keepImage ? message.attachment_type : null),
        action === "edit"
          ? "active"
          : action === "remove"
            ? "removed"
            : "retracted",
        action === "edit" && thread.kind === "public" && !admin
          ? "pending"
          : "approved",
        time,
        messageId,
        threadId,
        message.version,
      ),
    );
  }
  // Content changes notify the other side without claiming that a new reply was sent.
  statements.push(
    env.DB.prepare(
      `UPDATE threads SET updated_at = ?, ${admin ? "last_admin_change_at" : "last_visitor_change_at"} = ?
    ${!admin ? ", triage = 'reply', snoozed_until = 0" : ""} WHERE id = ? AND changes() > 0`,
    ).bind(time, time, threadId),
  );
  if (firstMessage?.id === messageId)
    statements.push(titleStatement(env, threadId));
  const result = await env.DB.batch(statements);
  const changes =
    result[changeIndex]?.meta?.changes ?? result[changeIndex]?.changes;
  if (changes === 0) return fail("消息已发生变化，请刷新后再操作。", 409);
  return json({ ok: true });
}

export async function addAdminReply(env, thread, body, image, id) {
  const existing = await env.DB.prepare(
    "SELECT id, thread_id, sender FROM messages WHERE id = ?",
  )
    .bind(id)
    .first();
  if (existing)
    return existing.thread_id === thread.id && existing.sender === "admin"
      ? json({ ok: true })
      : fail("消息编号冲突。", 409);
  const time = nowFor(thread);
  const statements = [];
  const openCondition =
    "id = ? AND visitor_closed = 0 AND author_closed = 0 AND status <> 'closed'";
  if (image)
    statements.push(
      env.DB.prepare(
        `INSERT INTO attachments (key, thread_id, content_type, data, created_at)
    SELECT ?, ?, ?, ?, ? FROM threads WHERE ${openCondition}`,
      ).bind(image.key, thread.id, image.type, image.bytes, time, thread.id),
    );
  const messageIndex = statements.length;
  statements.push(
    env.DB.prepare(
      `INSERT INTO messages (id, thread_id, sender, body, attachment_key, attachment_type, created_at)
    SELECT ?, ?, 'admin', ?, ?, ?, ? FROM threads WHERE ${openCondition}`,
    ).bind(
      id,
      thread.id,
      body,
      image?.key || null,
      image?.type || null,
      time,
      thread.id,
    ),
  );
  statements.push(
    env.DB.prepare(
      `UPDATE threads SET updated_at = ?, last_admin_at = ?, last_admin_change_at = ? WHERE id = ? AND changes() > 0`,
    ).bind(time, time, time, thread.id),
  );
  const result = await env.DB.batch(statements);
  if (
    (result[messageIndex]?.meta?.changes ?? result[messageIndex]?.changes) === 0
  )
    return fail("往来已结束，不能继续回信。", 409);
  return json({ ok: true }, 201);
}

export async function workbenchRoute(request, env, admin) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (Number(request.headers.get("Content-Length")) > 1300000)
    return fail("内容过大。", 413);
  const base = admin ? "/api" : "";
  const messageMatch = new RegExp(
    `^${base}/threads/([0-9a-f-]{36})/messages/([0-9a-f-]{36})(?:/(retract|remove|approve))?$`,
    "i",
  ).exec(path);
  if (messageMatch) {
    const [, threadId, messageId, verb] = messageMatch;
    if (verb === "approve" && admin && request.method === "POST") {
      const body = await request.json();
      const message = await env.DB.prepare(
        "SELECT * FROM messages WHERE id = ? AND thread_id = ?",
      )
        .bind(messageId, threadId)
        .first();
      if (!message) return fail("消息不存在。", 404);
      if (
        message.state !== "active" ||
        Number(body.version) !== message.version
      )
        return fail("消息已变化，请刷新后审核。", 409);
      const time = Date.now();
      const firstMessage = await env.DB.prepare(
        "SELECT id FROM messages WHERE thread_id = ? ORDER BY created_at, id LIMIT 1",
      )
        .bind(threadId)
        .first();
      const result = await env.DB.batch([
        env.DB.prepare(
          `UPDATE messages SET moderation = 'approved', version = version + 1 WHERE id = ? AND version = ?`,
        ).bind(messageId, message.version),
        env.DB.prepare(
          "UPDATE threads SET updated_at = ?, last_admin_change_at = ? WHERE id = ? AND changes() > 0",
        ).bind(time, time, threadId),
        ...(firstMessage?.id === messageId
          ? [titleStatement(env, threadId)]
          : []),
      ]);
      if ((result[0]?.meta?.changes ?? result[0]?.changes) === 0)
        return fail("消息已变化，请刷新后审核。", 409);
      return json({ ok: true });
    }
    const action =
      request.method === "PATCH" && !verb
        ? "edit"
        : request.method === "DELETE" && !verb
          ? "delete"
          : request.method === "POST"
            ? verb
            : null;
    if (["edit", "delete", "retract", "remove"].includes(action))
      return changeMessage(request, env, admin, threadId, messageId, action);
    return fail("操作无效。", 405);
  }

  if (!admin && path === "/public/knowledge" && request.method === "GET") {
    const product = url.searchParams.get("product") || "ephone";
    if (!products.has(product)) return fail("应用来源无效。");
    return json({
      entries: await rows(
        env.DB.prepare(
          `SELECT id, title, body, category, updated_at FROM knowledge
      WHERE product = ? AND published = 1 ORDER BY updated_at DESC LIMIT 50`,
        ).bind(product),
      ),
    });
  }
  const resultMatch = /^\/threads\/([0-9a-f-]{36})\/result$/i.exec(path);
  if (!admin && resultMatch && request.method === "POST") {
    const thread = await threadById(env, resultMatch[1]);
    if (!thread) return fail("对话不存在。", 404);
    if (!(await owns(request, thread))) return fail("无权确认此反馈。", 403);
    const input = await request.json();
    if (
      !["resolved", "problem"].includes(input.result) ||
      thread.outcome !== "resolved"
    )
      return fail("此反馈尚未标记为已解决。");
    if (!(await mutationLimit(request, env, false)))
      return fail("操作过于频繁，请稍后再试。", 429);
    const time = nowFor(thread);
    await env.DB.prepare(
      `UPDATE threads SET visitor_result = ?, triage = ?, snoozed_until = 0,
      outcome = ?, updated_at = ?, last_visitor_change_at = ? WHERE id = ?`,
    )
      .bind(
        input.result,
        input.result === "problem" ? "reply" : "none",
        input.result === "problem" ? "received" : "resolved",
        time,
        time,
        thread.id,
      )
      .run();
    return json({ ok: true });
  }
  if (!admin) return null;

  if (path === "/api/dashboard" && request.method === "GET") {
    const product = url.searchParams.get("product") || "all";
    if (product !== "all" && !products.has(product))
      return fail("应用来源无效。");
    const where = product === "all" ? "" : " WHERE product = ?";
    const query = env.DB.prepare(`SELECT
      SUM(CASE WHEN max(last_visitor_at, last_visitor_change_at) > admin_seen_at THEN 1 ELSE 0 END) AS unread,
      SUM(CASE WHEN triage = 'reply' AND visitor_closed = 0 AND author_closed = 0 AND status NOT IN ('closed','hidden')
        AND snoozed_until <= ? AND max(last_visitor_at,last_visitor_change_at) > last_admin_at THEN 1 ELSE 0 END) AS reply,
      SUM(CASE WHEN kind = 'public' AND status = 'pending' THEN 1 ELSE 0 END) AS review,
      SUM(CASE WHEN triage = 'waiting' THEN 1 ELSE 0 END) AS waiting,
      SUM(CASE WHEN snoozed_until > 0 AND snoozed_until <= ? THEN 1 ELSE 0 END) AS revisit FROM threads${where}`);
    const counts = await (
      product === "all"
        ? query.bind(Date.now(), Date.now())
        : query.bind(Date.now(), Date.now(), product)
    ).first();
    const tasks = await rows(
      env.DB.prepare(
        `SELECT state, review_at, updated_at FROM tasks${where}`,
      ).bind(...(product === "all" ? [] : [product])),
    );
    const pendingMessages = await env.DB.prepare(
      `SELECT count(*) AS count FROM messages m JOIN threads t ON t.id = m.thread_id
      WHERE m.state = 'active' AND m.moderation = 'pending' AND t.status <> 'pending' ${product !== "all" ? "AND t.product = ?" : ""}`,
    )
      .bind(...(product === "all" ? [] : [product]))
      .first();
    return json({
      counts: {
        ...counts,
        review: Number(counts?.review || 0) + Number(pendingMessages.count),
        due: tasks.filter(
          (t) =>
            t.state !== "done" && t.review_at > 0 && t.review_at <= Date.now(),
        ).length,
        stale: tasks.filter(
          (t) =>
            t.state !== "done" && t.updated_at < Date.now() - 14 * 86400000,
        ).length,
      },
    });
  }
  const metaMatch = /^\/api\/threads\/([0-9a-f-]{36})\/manage$/i.exec(path);
  if (metaMatch && request.method === "PATCH") {
    const thread = await threadById(env, metaMatch[1]);
    if (!thread) return fail("对话不存在。", 404);
    const body = await request.json();
    const sets = [];
    const values = [];
    const put = (key, value) => {
      sets.push(`${key} = ?`);
      values.push(value);
    };
    if (body.product !== undefined) {
      if (!products.has(body.product)) return fail("应用来源无效。");
      const linked = await env.DB.prepare(
        "SELECT count(*) AS count FROM task_threads l JOIN tasks t ON t.id = l.task_id WHERE l.thread_id = ? AND t.product <> ?",
      )
        .bind(thread.id, body.product)
        .first();
      if (linked.count)
        return fail("请先解除原来源的关联待办，再更正来源。", 409);
      put("product", body.product);
    }
    if (body.read === true)
      put(
        "admin_seen_at",
        Math.max(thread.last_visitor_at, thread.last_visitor_change_at),
      );
    if (body.triage !== undefined) {
      if (!["reply", "waiting", "none"].includes(body.triage))
        return fail("处理方式无效。");
      put("triage", body.triage);
    }
    if (body.snoozed_until !== undefined) {
      if (!Number.isSafeInteger(body.snoozed_until) || body.snoozed_until < 0)
        return fail("回看日期无效。");
      put("snoozed_until", body.snoozed_until);
    }
    if (body.author_closed !== undefined)
      put("author_closed", body.author_closed ? 1 : 0);
    if (body.outcome !== undefined) {
      if (!outcomes.has(body.outcome)) return fail("处理结果无效。");
      put("outcome", body.outcome);
      put("outcome_note", plain(body.outcome_note, 1000));
      put("resolved_version", plain(body.resolved_version, 60));
      put("visitor_result", "");
      const time = nowFor(thread);
      put("outcome_at", time);
      put("last_admin_change_at", time);
      put("updated_at", time);
    }
    if (!sets.length) return fail("没有需要保存的内容。");
    await env.DB.prepare(`UPDATE threads SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...values, thread.id)
      .run();
    return json({ ok: true });
  }

  const taskMatch =
    /^\/api\/tasks(?:\/([0-9a-f-]{36})(?:\/(links|notify))?)?$/i.exec(path);
  if (taskMatch) {
    const [, id, action] = taskMatch;
    const task = id
      ? await env.DB.prepare("SELECT * FROM tasks WHERE id = ?")
          .bind(id)
          .first()
      : null;
    if (id && !task) return fail("待办不存在。", 404);
    if (!id && request.method === "GET") {
      const product = url.searchParams.get("product") || "all";
      const state = url.searchParams.get("state") || "all";
      const q = plain(url.searchParams.get("q"), 80);
      if (product !== "all" && !products.has(product))
        return fail("应用来源无效。");
      if (!["all", "due", "stale", ...taskStates].includes(state))
        return fail("待办筛选无效。");
      const conditions = [];
      const values = [];
      if (product !== "all") {
        conditions.push("product = ?");
        values.push(product);
      }
      if (taskStates.has(state)) {
        conditions.push("state = ?");
        values.push(state);
      }
      if (state === "due") {
        conditions.push("state <> 'done' AND review_at > 0 AND review_at <= ?");
        values.push(Date.now());
      }
      if (state === "stale") {
        conditions.push("state <> 'done' AND updated_at < ?");
        values.push(Date.now() - 14 * 86400000);
      }
      if (q) {
        conditions.push(
          "(instr(lower(title),lower(?)) > 0 OR instr(lower(body),lower(?)) > 0)",
        );
        values.push(q, q);
      }
      return json({
        tasks: await rows(
          env.DB.prepare(
            `SELECT * FROM tasks ${conditions.length ? "WHERE " + conditions.join(" AND ") : ""}
        ORDER BY CASE state WHEN 'done' THEN 1 ELSE 0 END, CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
        updated_at DESC, id DESC LIMIT 500`,
          ).bind(...values),
        ),
      });
    }
    if (id && !action && request.method === "GET") {
      return json({
        task,
        threads: await rows(
          env.DB.prepare(
            `SELECT t.id, t.product, t.title, t.kind, t.status, t.visitor_closed, t.author_closed
        FROM threads t JOIN task_threads l ON l.thread_id = t.id WHERE l.task_id = ? ORDER BY t.updated_at DESC`,
          ).bind(id),
        ),
      });
    }
    if (action === "links") {
      const body = await request.json();
      if (!uuidPattern.test(body.thread_id || ""))
        return fail("反馈编号无效。");
      if (request.method === "DELETE") {
        await env.DB.prepare(
          "DELETE FROM task_threads WHERE task_id = ? AND thread_id = ?",
        )
          .bind(id, body.thread_id)
          .run();
      } else if (request.method === "POST") {
        const thread = await threadById(env, body.thread_id);
        if (!thread || thread.product !== task.product)
          return fail("只能关联相同来源的反馈。");
        await env.DB.prepare(
          "INSERT OR IGNORE INTO task_threads (task_id, thread_id) VALUES (?, ?)",
        )
          .bind(id, thread.id)
          .run();
      } else return fail("操作无效。", 405);
      return json({ ok: true });
    }
    if (action === "notify") {
      const recipients = await rows(
        env.DB.prepare(
          `SELECT t.* FROM threads t JOIN task_threads l ON l.thread_id = t.id
        WHERE l.task_id = ? AND t.visitor_closed = 0 AND t.author_closed = 0 AND t.status NOT IN ('closed','hidden') ORDER BY t.id`,
        ).bind(id),
      );
      if (request.method === "GET")
        return json({
          recipients: recipients.map((t) => ({ id: t.id, title: t.title })),
          total: recipients.length,
        });
      if (request.method !== "POST") return fail("操作无效。", 405);
      const input = await request.json();
      const body = plain(input.body, 5000);
      if (!body || !uuidPattern.test(input.batch_id || ""))
        return fail("请输入通知内容。");
      // Stable IDs make a retried batch safe; each conversation remains private.
      let count = 0;
      for (const thread of recipients) {
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(`${id}:${input.batch_id}:${thread.id}`),
        );
        const hex = [...new Uint8Array(digest)]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        const messageId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
        const response = await addAdminReply(
          env,
          thread,
          body,
          null,
          messageId,
        );
        if (response.status === 409) continue;
        if (!response.ok) return response;
        count++;
      }
      return json({ ok: true, count });
    }
    if (id && !action && request.method === "DELETE") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM task_threads WHERE task_id = ?").bind(id),
        env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(id),
      ]);
      return json({ ok: true });
    }
    if (
      (!id && request.method === "POST") ||
      (id && !action && request.method === "PATCH")
    ) {
      const body = await request.json();
      const value = { ...task, ...body };
      if (
        !products.has(value.product) ||
        !plain(value.title, 80) ||
        !taskStates.has(value.state || "todo") ||
        !["low", "normal", "high"].includes(value.priority || "normal") ||
        !Number.isSafeInteger(value.review_at || 0) ||
        (value.review_at || 0) < 0
      )
        return fail("待办内容无效。");
      if (task && value.product !== task.product)
        return fail("已创建待办不能更改来源。");
      const taskId = id || crypto.randomUUID();
      const time = Date.now();
      let linkedThread = null;
      if (body.thread_id) {
        linkedThread = await threadById(env, body.thread_id);
        if (!linkedThread || linkedThread.product !== value.product)
          return fail("关联反馈无效。");
      }
      const statements = [
        id
          ? env.DB.prepare(
              `UPDATE tasks SET title = ?, body = ?, state = ?, priority = ?, review_at = ?, updated_at = ? WHERE id = ?`,
            ).bind(
              plain(value.title, 80),
              plain(value.body, 5000),
              value.state,
              value.priority,
              value.review_at,
              time,
              id,
            )
          : env.DB.prepare(
              `INSERT INTO tasks (id,product,title,body,state,priority,review_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
            ).bind(
              taskId,
              value.product,
              plain(value.title, 80),
              plain(value.body, 5000),
              value.state || "todo",
              value.priority || "normal",
              value.review_at || 0,
              time,
              time,
            ),
      ];
      if (linkedThread)
        statements.push(
          env.DB.prepare(
            "INSERT OR IGNORE INTO task_threads (task_id, thread_id) VALUES (?, ?)",
          ).bind(taskId, linkedThread.id),
        );
      await env.DB.batch(statements);
      return json({ ok: true, id: taskId }, id ? 200 : 201);
    }
  }

  const knowledgeMatch = /^\/api\/knowledge(?:\/([0-9a-f-]{36}))?$/i.exec(path);
  if (knowledgeMatch) {
    const id = knowledgeMatch[1];
    if (!id && request.method === "GET") {
      const product = url.searchParams.get("product") || "all";
      if (product !== "all" && !products.has(product))
        return fail("应用来源无效。");
      const q = plain(url.searchParams.get("q"), 80);
      return json({
        entries: await rows(
          env.DB.prepare(
            `SELECT * FROM knowledge WHERE
        (? = 'all' OR product = ?) AND (instr(lower(title),lower(?)) > 0 OR instr(lower(body),lower(?)) > 0)
        ORDER BY updated_at DESC LIMIT 500`,
          ).bind(product, product, q, q),
        ),
      });
    }
    if (id && request.method === "GET") {
      const entry = await env.DB.prepare("SELECT * FROM knowledge WHERE id = ?")
        .bind(id)
        .first();
      return entry ? json({ entry }) : fail("解答不存在。", 404);
    }
    if (id && request.method === "DELETE") {
      await env.DB.prepare("DELETE FROM knowledge WHERE id = ?").bind(id).run();
      return json({ ok: true });
    }
    if (
      (!id && request.method === "POST") ||
      (id && request.method === "PATCH")
    ) {
      const old = id
        ? await env.DB.prepare("SELECT * FROM knowledge WHERE id = ?")
            .bind(id)
            .first()
        : {};
      if (id && !old) return fail("解答不存在。", 404);
      const value = { ...old, ...(await request.json()) };
      const entryId = id || crypto.randomUUID();
      const time = Date.now();
      if (
        !products.has(value.product) ||
        !["faq", "bug"].includes(value.category) ||
        !plain(value.title, 80) ||
        !plain(value.body, 5000)
      )
        return fail("请填写有效的解答内容。");
      if (id)
        await env.DB.prepare(
          "UPDATE knowledge SET title = ?, body = ?, category = ?, published = ?, updated_at = ? WHERE id = ?",
        )
          .bind(
            plain(value.title, 80),
            plain(value.body, 5000),
            value.category,
            value.published ? 1 : 0,
            time,
            id,
          )
          .run();
      else
        await env.DB.prepare(
          "INSERT INTO knowledge (id,product,title,body,category,published,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
        )
          .bind(
            entryId,
            value.product,
            plain(value.title, 80),
            plain(value.body, 5000),
            value.category,
            value.published ? 1 : 0,
            time,
            time,
          )
          .run();
      return json({ ok: true, id: entryId }, id ? 200 : 201);
    }
  }
  return null;
}
