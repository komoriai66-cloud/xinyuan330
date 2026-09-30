function adminClient() {
  "use strict";
  const $ = (s, root = document) => root.querySelector(s);
  const esc = (v) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const labels = {
    wish: "许愿",
    feedback: "反馈",
    bug: "报错",
    other: "其他",
    pending: "待审核",
    visible: "已公开",
    hidden: "已隐藏",
    open: "往来中",
    received: "已收到",
    need_info: "需要补充",
    accepted: "已采纳",
    declined: "暂不采纳",
    resolved: "已解决",
    todo: "待办",
    doing: "进行中",
    paused: "暂缓",
    done: "已完成",
    low: "低",
    normal: "普通",
    high: "高",
    reply: "待回复",
    waiting: "等用户补充",
    none: "无需回复",
    faq: "常见解答",
    ephone: "EPhone",
    uwu: "UWU",
  };
  const label = (v) => labels[v] || v;
  const date = (v) => (v ? new Date(v).toLocaleString("zh-CN") : "");
  const day = (v) => (v ? new Date(v).toLocaleDateString("sv-SE") : "");
  const opts = (values, chosen) =>
    values
      .map(
        (v) =>
          `<option value="${v}" ${v === chosen ? "selected" : ""}>${esc(label(v))}</option>`,
      )
      .join("");
  let token = "",
    product = "all",
    kind = "all",
    view = "threads",
    selected = null,
    all = [],
    cursor = null,
    sequence = 0,
    detailSequence = 0,
    data = null,
    timer,
    modalResolve,
    focusBefore;
  const files = new Map(),
    ids = new Map();
  const draftKey = (id) => "feedback_admin_reply_v2:" + id;
  const notice = (v) => {
    $("#notice").textContent = v || "";
    const detailNotice = $("#detail-notice");
    if (detailNotice) detailNotice.textContent = v || "";
  };
  function finishModal(result) {
    $("#modal").hidden = true;
    const resolve = modalResolve;
    modalResolve = null;
    if (resolve) resolve(result);
    focusBefore?.focus();
  }
  function lock() {
    token = "";
    sessionStorage.removeItem("ephone_feedback_admin_token");
    $("#login").hidden = false;
    $("main").hidden = true;
    $("#logout").hidden = true;
    all = [];
    selected = null;
    data = null;
    files.clear();
    $("#list").replaceChildren();
    $("#detail").replaceChildren();
    finishModal(false);
  }
  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", "Bearer " + token);
    const r = await fetch("/api" + path, {
      ...options,
      headers,
      cache: "no-store",
    });
    const result = await r.json().catch(() => ({}));
    if (r.status === 401) lock();
    if (!r.ok) throw Error(result.error || "请求失败");
    return result;
  }
  const send = (path, body, method = "POST") =>
    api(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  function run(fn) {
    return async (event) => {
      const b = event?.currentTarget;
      if (b?.disabled) return;
      if (b) b.disabled = true;
      try {
        await fn();
      } catch (e) {
        notice(e.message);
      } finally {
        if (b) b.disabled = false;
      }
    };
  }
  function remember() {
    const f = $("#reply");
    if (!f || !selected) return;
    sessionStorage.setItem(draftKey(selected), f.elements.body.value);
    const file = f.elements.image.files[0];
    if (file) files.set(selected, file);
  }
  function filters() {
    const values =
      view === "threads"
        ? [
            ["all", "全部状态"],
            ["unread", "未读"],
            ["needs_reply", "待回复"],
            ["pending", "待审核"],
            ["waiting", "等用户补充"],
            ["revisit", "到期回看"],
            ["visible", "已公开"],
            ["hidden", "已隐藏"],
            ["closed", "已结束"],
          ]
        : view === "tasks"
          ? [
              ["all", "全部待办"],
              ["todo", "待办"],
              ["doing", "进行中"],
              ["paused", "暂缓"],
              ["done", "已完成"],
              ["due", "到期回看"],
              ["stale", "两周未推进"],
            ]
          : [["all", "全部解答"]];
    $("#filter").innerHTML = values
      .map(([v, t]) => `<option value="${v}">${t}</option>`)
      .join("");
    $("#kind-tabs").hidden = view !== "threads";
    $("#create").hidden = view === "threads";
    $("#search").placeholder =
      view === "threads" ? "搜索正文、标题或备注" : "搜索标题或内容";
  }
  function activate() {
    document
      .querySelectorAll("[data-view]")
      .forEach((b) => b.classList.toggle("active", b.dataset.view === view));
    filters();
  }
  function reset() {
    remember();
    detailSequence++;
    selected = null;
    data = null;
    $("main").classList.remove("thread-open");
    $("#detail").innerHTML = '<p class="meta">选择一项查看详情。</p>';
  }
  function list() {
    $("#list").innerHTML = all.length
      ? all
          .map((t) => {
            const unread =
              view === "threads" &&
              Math.max(t.last_visitor_at, t.last_visitor_change_at) >
                t.admin_seen_at;
            const text =
              view === "threads"
                ? `${label(t.category)} · ${t.author_closed || t.visitor_closed ? "已结束" : label(t.status)} · ${label(t.outcome)}`
                : view === "tasks"
                  ? `${label(t.state)} · ${label(t.priority)}优先${t.review_at ? " · 回看 " + day(t.review_at) : ""}`
                  : `${label(t.category)} · ${t.published ? "已发布" : "草稿"}`;
            return `<button data-id="${t.id}" class="${selected === t.id ? "selected" : ""}"><b>${unread ? "● " : ""}${esc(t.title)}</b><small>${esc(t.product.toUpperCase() + " · " + text)}</small></button>`;
          })
          .join("")
      : "暂无匹配内容";
    $("#more").hidden = !cursor;
  }
  async function overview() {
    const result = await api("/dashboard?product=" + product);
    $("#overview").innerHTML = [
      ["unread", "未读"],
      ["reply", "待回"],
      ["review", "审核"],
      ["waiting", "待补"],
      ["revisit", "回看"],
      ["due", "待办到期"],
      ["stale", "未推进"],
    ]
      .map(
        ([key, text]) =>
          `<button data-count="${key}">${text} <span>${result.counts[key] || 0}</span></button>`,
      )
      .join("");
  }
  async function reload(more = false, refreshDetail = false) {
    const request = ++sequence;
    try {
      notice("");
      const params = new URLSearchParams({
        product,
        q: $("#search").value.trim(),
      });
      if (view === "threads") {
        params.set("kind", kind);
        params.set("status", $("#filter").value);
        if (more && cursor) params.set("before", cursor);
      }
      if (view === "tasks") params.set("state", $("#filter").value);
      const result = await api("/" + view + "?" + params);
      if (request !== sequence) return;
      const items = result.threads || result.tasks || result.entries;
      all = more ? all.concat(items) : items;
      cursor = result.nextCursor || null;
      list();
      await overview();
      if (refreshDetail && selected) await detail(selected);
    } catch (e) {
      if (request === sequence) notice(e.message);
    }
  }
  function modal(title, html, accept = "确定") {
    focusBefore = document.activeElement;
    $("#modal-title").textContent = title;
    $("#modal-body").innerHTML = html;
    $("#modal-ok").textContent = accept;
    $("#modal-error").textContent = "";
    $("#modal").hidden = false;
    $("#modal-cancel").focus();
    return new Promise((resolve) => {
      modalResolve = resolve;
    });
  }
  const confirm = (text) =>
    modal("确认操作", `<p class="meta">${esc(text)}</p>`);
  $("#modal-cancel").onclick = () => finishModal(false);
  $("#modal-ok").onclick = () => finishModal(true);
  $("#modal").onkeydown = (e) => {
    if (e.key === "Escape") finishModal(false);
    if (e.key === "Tab") {
      const nodes = [
        ...$("#modal").querySelectorAll("button,input,textarea,select"),
      ].filter((el) => !el.disabled && !el.hidden);
      if (e.shiftKey && document.activeElement === nodes[0]) {
        e.preventDefault();
        nodes.at(-1).focus();
      } else if (!e.shiftKey && document.activeElement === nodes.at(-1)) {
        e.preventDefault();
        nodes[0].focus();
      }
    }
  };
  function messageHTML(m) {
    const own = m.sender === "admin",
      active = m.state === "active";
    const text = !active
      ? m.state === "removed"
        ? "作者移除了一条消息"
        : `${own ? "作者" : "用户"}撤回了一条消息`
      : m.body;
    return `<article class="message ${own ? "admin" : "visitor"}"><div class="message-head"><small>${own ? "我" : "用户"} · ${esc(date(m.created_at))}${m.edited_at ? " · 已编辑" : ""}${active && m.moderation === "pending" ? " · 待审核" : ""}</small><details class="message-menu"><summary aria-label="消息操作">···</summary><div>${own && active ? `<button data-message="${m.id}" data-action="edit">修改</button><button data-message="${m.id}" data-action="retract">撤回</button>` : ""}${own ? `<button data-message="${m.id}" data-action="delete">删除</button>` : active ? `<button data-message="${m.id}" data-action="remove">移除</button>` : ""}${active && m.moderation === "pending" ? `<button data-message="${m.id}" data-action="approve">通过审核</button>` : ""}</div></details></div><div>${esc(text)}</div>${active && m.attachment_key ? `<button data-image="${m.attachment_key}">查看附图</button>` : ""}</article>`;
  }
  async function detail(id) {
    remember();
    selected = id;
    list();
    const request = ++detailSequence;
    try {
      const result = await api("/" + view + "/" + id);
      if (selected !== id || request !== detailSequence) return;
      data = result;
      const el = $("#detail");
      $("main").classList.add("thread-open");
      if (view === "threads") threadUI(el, result);
      else if (view === "tasks") taskUI(el, result.task, result.threads);
      else knowledgeUI(el, result.entry);
      back(el);
      if (view === "threads") {
        $("#messages").scrollTop = $("#messages").scrollHeight;
        await send("/threads/" + id + "/manage", { read: true }, "PATCH");
        const local = all.find((t) => t.id === id);
        if (local)
          local.admin_seen_at = Math.max(
            local.last_visitor_at,
            local.last_visitor_change_at,
          );
        list();
      }
    } catch (e) {
      notice(e.message);
    }
  }
  function back(el) {
    el.insertAdjacentHTML(
      "afterbegin",
      '<button type="button" class="mobile-back" id="back-list">‹ 返回列表</button><div id="detail-notice" role="status" aria-live="polite"></div>',
    );
    $("#back-list").onclick = () => {
      remember();
      $("main").classList.remove("thread-open");
    };
  }
  function threadUI(el, result) {
    const t = result.thread,
      closed = t.visitor_closed || t.author_closed || t.status === "closed";
    el.innerHTML = `<h2 title="${esc(t.title)}">${esc(t.title)}</h2><div class="meta">${t.product.toUpperCase()} · ${label(t.category)} · ${t.kind === "private" ? "私密" : "公开"} · ${closed ? "已结束往来" : label(t.status)} · ${label(t.outcome)}</div><div class="detail-controls"><details class="note"><summary>处理</summary><div class="compact-fields"><label>来源<select id="thread-product">${opts(["ephone", "uwu"], t.product)}</select></label><button id="save-product">更正来源</button>${t.kind === "public" ? `<label>展示<select id="thread-status">${opts(["pending", "visible", "hidden"], t.status)}</select></label><button id="save-status">保存展示</button>` : ""}<label>处理<select id="triage">${opts(["reply", "waiting", "none"], t.triage)}</select></label><label>回看日期<input id="snooze" type="date" value="${day(t.snoozed_until)}"></label><button id="save-triage">保存处理</button><label>结果<select id="outcome">${opts(["received", "need_info", "accepted", "declined", "resolved"], t.outcome)}</select></label><label>对应版本<input id="resolved-version" maxlength="60" value="${esc(t.resolved_version)}"></label><label class="wide">说明<textarea id="outcome-note" maxlength="1000">${esc(t.outcome_note)}</textarea></label><button id="save-outcome">告知结果</button><button id="toggle-close" ${t.visitor_closed ? "disabled" : ""}>${t.author_closed ? "重新开启往来" : "结束往来"}</button><button id="delete-thread">删除整段对话</button></div></details><details class="note"><summary>待办${result.tasks.length ? " · " + result.tasks.length : ""}</summary><div class="linked-items">${result.tasks.map((task) => `<button data-task="${task.id}">${esc(task.title)} · ${label(task.state)}</button>`).join("")}<button id="new-from-thread">新建待办</button><button id="link-existing">关联已有待办</button></div></details><details class="note"><summary>备注与环境</summary><textarea id="thread-note" maxlength="1000">${esc(t.note)}</textarea><button id="save-note">保存备注</button><p class="meta">${esc(t.environment || "未附带环境信息")}</p></details></div><div id="messages">${result.messages.map(messageHTML).join("")}</div>${closed ? '<p class="meta">往来已结束，仍可处理自己的旧消息。</p>' : `<form id="reply" class="reply"><label>回复<textarea name="body" maxlength="5000" placeholder="写下回复…"></textarea></label><div class="reply-tools"><label class="file-button">附图<input name="image" type="file" accept="image/png,image/jpeg,image/webp"></label><span id="file-name" class="meta"></span><button id="clear-image" type="button">移除</button><button class="primary" type="submit">发送回复</button></div><img id="reply-preview" hidden alt="待发送附图"></form>`}`;
    $("#save-product").onclick = run(async () => {
      await send(
        "/threads/" + t.id + "/manage",
        { product: $("#thread-product").value },
        "PATCH",
      );
      await reload(false, true);
    });
    if ($("#save-status"))
      $("#save-status").onclick = run(async () => {
        await send(
          "/threads/" + t.id,
          { status: $("#thread-status").value },
          "PATCH",
        );
        await reload(false, true);
      });
    $("#save-triage").onclick = run(async () => {
      await send(
        "/threads/" + t.id + "/manage",
        {
          triage: $("#triage").value,
          snoozed_until: $("#snooze").value
            ? new Date($("#snooze").value + "T00:00:00").getTime()
            : 0,
        },
        "PATCH",
      );
      await reload(false, true);
    });
    $("#save-outcome").onclick = run(async () => {
      await send(
        "/threads/" + t.id + "/manage",
        {
          outcome: $("#outcome").value,
          outcome_note: $("#outcome-note").value,
          resolved_version: $("#resolved-version").value,
        },
        "PATCH",
      );
      await reload(false, true);
    });
    $("#save-note").onclick = run(async () => {
      await send(
        "/threads/" + t.id,
        { note: $("#thread-note").value },
        "PATCH",
      );
      notice("备注已保存");
    });
    $("#toggle-close").onclick = run(async () => {
      await send(
        "/threads/" + t.id + "/manage",
        { author_closed: !t.author_closed },
        "PATCH",
      );
      await reload(false, true);
    });
    $("#delete-thread").onclick = run(async () => {
      if (!(await confirm("永久删除整段对话及附图？关联待办会保留。"))) return;
      await api("/threads/" + t.id, { method: "DELETE" });
      sessionStorage.removeItem(draftKey(t.id));
      files.delete(t.id);
      $("#reply")?.remove();
      reset();
      await reload();
    });
    $("#new-from-thread").onclick = () => {
      remember();
      view = "tasks";
      activate();
      selected = null;
      taskUI(
        el,
        {
          product: t.product,
          title: t.title,
          body: "",
          state: "todo",
          priority: "normal",
          review_at: 0,
          thread_id: t.id,
        },
        [],
      );
      back(el);
      $("main").classList.add("thread-open");
      reload();
    };
    $("#link-existing").onclick = run(async () => {
      const tasks = (await api("/tasks?product=" + t.product)).tasks.filter(
        (task) => task.state !== "done",
      );
      if (!tasks.length) {
        notice("没有可关联的待办，可先新建。");
        return;
      }
      if (
        await modal(
          "关联待办",
          `<label>待办<select id="link-task">${tasks.map((task) => `<option value="${task.id}">${esc(task.title)}</option>`).join("")}</select></label>`,
        )
      ) {
        await send("/tasks/" + $("#link-task").value + "/links", {
          thread_id: t.id,
        });
        await detail(t.id);
      }
    });
    el.querySelectorAll("[data-task]").forEach((b) => {
      b.onclick = () => {
        remember();
        view = "tasks";
        activate();
        detail(b.dataset.task);
        reload();
      };
    });
    el.querySelectorAll("[data-action][data-message]").forEach((b) => {
      b.onclick = run(() => messageAction(b.dataset.action, b.dataset.message));
    });
    el.querySelectorAll("[data-image]").forEach((b) => {
      b.onclick = run(async () => {
        const r = await fetch("/api/attachments/" + b.dataset.image, {
          headers: { Authorization: "Bearer " + token },
          cache: "no-store",
        });
        if (!r.ok) throw Error("附图加载失败");
        const url = URL.createObjectURL(await r.blob()),
          img = new Image();
        img.src = url;
        img.alt = "反馈附图";
        img.onload = () => URL.revokeObjectURL(url);
        b.replaceWith(img);
      });
    });
    if ($("#reply")) {
      const f = $("#reply");
      f.elements.body.value = sessionStorage.getItem(draftKey(t.id)) || "";
      f.oninput = () => {
        remember();
        ids.delete(t.id);
      };
      const preview = (file) => {
        $("#file-name").textContent = file?.name || "";
        $("#reply-preview").hidden = !file;
        if (file) {
          const url = URL.createObjectURL(file);
          $("#reply-preview").src = url;
          $("#reply-preview").onload = () => URL.revokeObjectURL(url);
        }
      };
      preview(files.get(t.id));
      f.elements.image.onchange = () => {
        ids.delete(t.id);
        const file = f.elements.image.files[0];
        if (file) files.set(t.id, file);
        preview(file);
      };
      $("#clear-image").onclick = () => {
        ids.delete(t.id);
        f.elements.image.value = "";
        files.delete(t.id);
        preview(null);
      };
      f.onsubmit = async (e) => {
        e.preventDefault();
        const b = f.querySelector("[type=submit]");
        if (b.disabled) return;
        b.disabled = true;
        try {
          remember();
          const form = new FormData();
          const body = f.elements.body.value;
          form.set("body", body);
          const file = files.get(t.id);
          if (file) form.set("image", file);
          const id = ids.get(t.id) || crypto.randomUUID();
          ids.set(t.id, id);
          form.set("messageId", id);
          await api("/threads/" + t.id + "/reply", {
            method: "POST",
            body: form,
          });
          if (f.elements.body.value === body && files.get(t.id) === file) {
            sessionStorage.removeItem(draftKey(t.id));
            files.delete(t.id);
            f.reset();
          } else {
            remember();
          }
          ids.delete(t.id);
          await reload(false, true);
        } catch (error) {
          notice(error.message);
        } finally {
          b.disabled = false;
        }
      };
    }
  }
  async function messageAction(action, id) {
    const m = data.messages.find((item) => item.id === id),
      path = "/threads/" + data.thread.id + "/messages/" + id;
    if (action === "edit") {
      if (
        !(await modal(
          "修改回复",
          `<label>内容<textarea id="edit-body" maxlength="5000">${esc(m.body)}</textarea></label><label class="file-button">替换附图<input id="edit-image" type="file" accept="image/png,image/jpeg,image/webp"></label>${m.attachment_key ? '<label class="check-label"><input id="remove-edit-image" type="checkbox">移除原附图</label>' : ""}`,
          "保存",
        ))
      )
        return;
      const form = new FormData();
      form.set("body", $("#edit-body").value);
      form.set("version", m.version);
      if ($("#edit-image").files[0])
        form.set("image", $("#edit-image").files[0]);
      if ($("#remove-edit-image")?.checked) form.set("removeImage", "1");
      await api(path, { method: "PATCH", body: form });
    } else {
      if (
        action !== "approve" &&
        !(await confirm(
          action === "delete"
            ? "永久删除自己的这条消息及附图？"
            : action === "remove"
              ? "移除用户内容并留下管理提示？"
              : "撤回这条回复及附图？",
        ))
      )
        return;
      await send(
        path + (action === "delete" ? "" : "/" + action),
        { version: m.version },
        action === "delete" ? "DELETE" : "POST",
      );
    }
    await reload(false, true);
  }
  function taskUI(el, t = {}, threads = []) {
    el.innerHTML = `<h2>${t.id ? "待办详情" : "新建待办"}</h2><form id="task-form" class="editor-form"><label>标题<input name="title" maxlength="80" required value="${esc(t.title || "")}"></label><div class="compact-fields"><label>来源<select name="product" ${t.id ? "disabled" : ""}>${opts(["ephone", "uwu"], t.product || (product === "all" ? "ephone" : product))}</select></label><label>状态<select name="state">${opts(["todo", "doing", "paused", "done"], t.state || "todo")}</select></label><label>优先级<select name="priority">${opts(["low", "normal", "high"], t.priority || "normal")}</select></label><label>回看日期<input name="review" type="date" value="${day(t.review_at)}"></label></div><label>下一步 / 任务摘要<textarea name="body" maxlength="5000" placeholder="记录下一步要做什么…">${esc(t.body || "")}</textarea></label><div class="toolbar"><button class="primary" type="submit">保存待办</button>${t.id ? '<button id="delete-task" type="button">删除待办</button>' : ""}</div></form>${t.id ? `<details class="note"><summary>关联反馈 · ${threads.length}</summary><div class="linked-items">${threads.map((thread) => `<div><button data-thread="${thread.id}">${esc(thread.title)}</button><button data-unlink="${thread.id}">解除</button></div>`).join("")}</div><p class="meta">从收件箱关联同一来源的反馈。</p></details><details class="note"><summary>统一通知</summary><form id="notify-form"><label>通知内容<textarea name="body" maxlength="5000" required placeholder="分别发送到仍可往来的关联对话。"></textarea></label><button type="submit">预览并发送</button></form></details>` : ""}`;
    $("#task-form").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target,
        b = f.querySelector("[type=submit]");
      if (b.disabled) return;
      b.disabled = true;
      try {
        const value = {
          title: f.elements.title.value,
          product: t.product || f.elements.product.value,
          body: f.elements.body.value,
          state: f.elements.state.value,
          priority: f.elements.priority.value,
          review_at: f.elements.review.value
            ? new Date(f.elements.review.value + "T00:00:00").getTime()
            : 0,
        };
        if (t.thread_id) value.thread_id = t.thread_id;
        const result = await send(
          "/tasks" + (t.id ? "/" + t.id : ""),
          value,
          t.id ? "PATCH" : "POST",
        );
        await reload();
        await detail(result.id);
      } catch (error) {
        notice(error.message);
      } finally {
        b.disabled = false;
      }
    };
    if (t.id) {
      $("#delete-task").onclick = run(async () => {
        if (!(await confirm("删除待办？原反馈不受影响。"))) return;
        await api("/tasks/" + t.id, { method: "DELETE" });
        reset();
        await reload();
      });
      el.querySelectorAll("[data-thread]").forEach((b) => {
        b.onclick = () => {
          view = "threads";
          activate();
          detail(b.dataset.thread);
          reload();
        };
      });
      el.querySelectorAll("[data-unlink]").forEach((b) => {
        b.onclick = run(async () => {
          await send(
            "/tasks/" + t.id + "/links",
            { thread_id: b.dataset.unlink },
            "DELETE",
          );
          await detail(t.id);
        });
      });
      $("#notify-form").onsubmit = async (e) => {
        e.preventDefault();
        const f = e.target,
          b = f.querySelector("button");
        if (b.disabled) return;
        b.disabled = true;
        try {
          const recipients = await api("/tasks/" + t.id + "/notify");
          if (!recipients.total) {
            notice("没有仍可往来的关联对话。");
            return;
          }
          const body = f.elements.body.value.trim();
          if (
            !(await modal(
              "通知预览",
              `<p class="meta">将发送给 ${recipients.total} 段独立对话，已结束的对话不会收到。</p><p class="preview-text">${esc(body)}</p>`,
              "发送",
            ))
          )
            return;
          if (f.dataset.batchBody !== body) {
            f.dataset.batchId = crypto.randomUUID();
            f.dataset.batchBody = body;
          }
          const sent = await send("/tasks/" + t.id + "/notify", {
            body,
            batch_id: f.dataset.batchId,
          });
          if (f.elements.body.value.trim() === body) f.reset();
          delete f.dataset.batchId;
          delete f.dataset.batchBody;
          notice("已通知 " + sent.count + " 段对话");
        } catch (error) {
          notice(error.message);
        } finally {
          b.disabled = false;
        }
      };
    }
  }
  function knowledgeUI(el, t = {}) {
    el.innerHTML = `<h2>${t.id ? "解答详情" : "新建解答"}</h2><p class="meta">发布到对应应用的信箱。请单独撰写公开内容。</p><form id="knowledge-form" class="editor-form"><label>标题<input name="title" maxlength="80" required value="${esc(t.title || "")}"></label><div class="compact-fields"><label>来源<select name="product" ${t.id ? "disabled" : ""}>${opts(["ephone", "uwu"], t.product || (product === "all" ? "ephone" : product))}</select></label><label>分类<select name="category">${opts(["faq", "bug"], t.category || "faq")}</select></label><label>展示<select name="published"><option value="0" ${!t.published ? "selected" : ""}>草稿</option><option value="1" ${t.published ? "selected" : ""}>发布</option></select></label></div><label>内容<textarea name="body" maxlength="5000" required>${esc(t.body || "")}</textarea></label><div class="toolbar"><button class="primary">保存解答</button>${t.id ? '<button id="delete-knowledge" type="button">删除</button>' : ""}</div></form>`;
    $("#knowledge-form").onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target,
        b = f.querySelector("button");
      if (b.disabled) return;
      b.disabled = true;
      try {
        const value = Object.fromEntries(new FormData(f));
        value.product = t.product || value.product;
        value.published = value.published === "1";
        const result = await send(
          "/knowledge" + (t.id ? "/" + t.id : ""),
          value,
          t.id ? "PATCH" : "POST",
        );
        await reload();
        await detail(result.id);
      } catch (error) {
        notice(error.message);
      } finally {
        b.disabled = false;
      }
    };
    if (t.id)
      $("#delete-knowledge").onclick = run(async () => {
        if (!(await confirm("删除这条解答？"))) return;
        await api("/knowledge/" + t.id, { method: "DELETE" });
        reset();
        await reload();
      });
  }
  async function signIn(value) {
    token = value.trim().toLowerCase();
    await api("/session");
    sessionStorage.setItem("ephone_feedback_admin_token", token);
    $("#login").hidden = true;
    $("main").hidden = false;
    $("#logout").hidden = false;
    filters();
    await reload();
  }
  $("#list").onclick = (e) => {
    const b = e.target.closest("[data-id]");
    if (b) detail(b.dataset.id);
  };
  document.querySelectorAll("[data-product]").forEach((b) => {
    b.onclick = () => {
      reset();
      product = b.dataset.product;
      document
        .querySelectorAll("[data-product]")
        .forEach((item) => item.classList.toggle("active", item === b));
      reload();
    };
  });
  document.querySelectorAll("[data-view]").forEach((b) => {
    b.onclick = () => {
      reset();
      view = b.dataset.view;
      activate();
      reload();
    };
  });
  document.querySelectorAll("[data-kind]").forEach((b) => {
    b.onclick = () => {
      reset();
      kind = b.dataset.kind;
      document
        .querySelectorAll("[data-kind]")
        .forEach((item) => item.classList.toggle("active", item === b));
      reload();
    };
  });
  $("#overview").onclick = (e) => {
    const key = e.target.closest("[data-count]")?.dataset.count;
    if (!key) return;
    reset();
    view = ["due", "stale"].includes(key) ? "tasks" : "threads";
    activate();
    $("#filter").value =
      { reply: "needs_reply", review: "pending" }[key] || key;
    reload();
  };
  $("#filter").onchange = () => {
    reset();
    reload();
  };
  $("#search").oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      reset();
      reload();
    }, 250);
  };
  $("#refresh").onclick = () => {
    remember();
    reload(false, $("main").classList.contains("thread-open"));
  };
  $("#more").onclick = () => reload(true);
  $("#create").onclick = () => {
    reset();
    $("main").classList.add("thread-open");
    if (view === "tasks") taskUI($("#detail"));
    else knowledgeUI($("#detail"));
    back($("#detail"));
  };
  $("#login-form").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await signIn(e.target.elements.token.value);
    } catch (error) {
      $("#login-notice").textContent = error.message;
    }
  };
  $("#logout").onclick = lock;
  window.addEventListener("beforeunload", remember);
  const saved = sessionStorage.getItem("ephone_feedback_admin_token");
  if (saved)
    signIn(saved).catch((error) => {
      $("#login-notice").textContent = error.message;
    });
}
export const ADMIN_SCRIPT = "(" + adminClient.toString() + ")();";
