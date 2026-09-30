// Local, in-memory UI verification. No production credentials or database are used.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import admin from "../admin-worker.js";
import publicWorker from "../public-worker.js";
const directory = path.dirname(fileURLToPath(import.meta.url)),
  main = path.resolve(directory, "../../.."),
  uwu = path.resolve(
    process.env.UWU_SOURCE_ROOT || path.join(main, "../OVO-main"),
  );
const sqlite = new DatabaseSync(":memory:");
sqlite.exec("PRAGMA foreign_keys = ON");
sqlite.exec(fs.readFileSync(path.join(directory, "../schema.sql"), "utf8"));
const prepare = (sql) => {
  let args = [];
  return {
    bind(...v) {
      args = v;
      return this;
    },
    first() {
      return sqlite.prepare(sql).get(...args) || null;
    },
    all() {
      return { results: sqlite.prepare(sql).all(...args) };
    },
    run() {
      return sqlite.prepare(sql).run(...args);
    },
  };
};
const env = {
  DB: {
    prepare,
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const r = statements.map((s) => s.run());
        sqlite.exec("COMMIT");
        return r;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  },
  RATE_LIMITER: { limit: async () => ({ success: true }) },
  READ_LIMITER: { limit: async () => ({ success: true }) },
  ADMIN_LIMITER: { limit: async () => ({ success: true }) },
  ADMIN_TOKEN_HASH: createHash("sha256").update("34".repeat(32)).digest("hex"),
  ALLOWED_ORIGINS: "http://127.0.0.1:8790",
  TURNSTILE_SECRET: "local-test",
  TURNSTILE_HOSTNAMES: "localhost",
};
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) =>
  String(input).startsWith(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
  )
    ? Promise.resolve(
        new Response(JSON.stringify({ success: true, hostname: "localhost" })),
      )
    : originalFetch(input, options);
const fixtures = {};
for (const product of ["ephone", "uwu"]) {
  const token = "ab".repeat(32),
    id = crypto.randomUUID(),
    time = Date.now();
  fixtures[product] = {
    id,
    token,
    kind: "public",
    title:
      "很长的中文反馈标题以及LongEnglishWithoutSpaces1234567890，用来检查窄屏布局",
    seenAt: 0,
  };
  prepare(
    `INSERT INTO threads(id,product,kind,category,title,public_title,nickname,secret_hash,status,created_at,updated_at,last_visitor_at,last_visitor_change_at,outcome,outcome_note,resolved_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      id,
      product,
      "public",
      "bug",
      fixtures[product].title,
      fixtures[product].title,
      "很长的中文昵称LongNickname123456",
      createHash("sha256").update(token).digest("hex"),
      "visible",
      time,
      time,
      time,
      time,
      "resolved",
      "请更新后重试。若仍有问题，可反馈给作者。",
      "2026.09.30",
    )
    .run();
  for (const [sender, body] of [
    [
      "visitor",
      "导入时遇到问题，步骤：打开设置 → 导入。\nLongEnglishWithoutSpaces1234567890".repeat(
        3,
      ),
    ],
    ["admin", "已修复，请更新后重试。可以在这里继续补充截图。"],
  ])
    prepare(
      "INSERT INTO messages(id,thread_id,sender,body,created_at) VALUES(?,?,?,?,?)",
    )
      .bind(
        crypto.randomUUID(),
        id,
        sender,
        body,
        time + (sender === "admin" ? 1 : 0),
      )
      .run();
  const task = crypto.randomUUID();
  prepare(
    "INSERT INTO tasks(id,product,title,body,state,priority,review_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      task,
      product,
      "检查导入与截图保存任务LongEnglish1234567890",
      "下一步：验证手机导入。",
      "doing",
      "high",
      time - 1000,
      time,
      time,
    )
    .run();
  prepare("INSERT INTO task_threads(task_id,thread_id) VALUES(?,?)")
    .bind(task, id)
    .run();
  prepare(
    "INSERT INTO knowledge(id,product,title,body,category,published,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
  )
    .bind(
      crypto.randomUUID(),
      product,
      "导入失败时如何处理？",
      "请确认文件格式，然后重试。仍然失败可附图反馈。",
      "bug",
      1,
      time,
      time,
    )
    .run();
}
const metrics = `<script>setInterval(()=>{const visible=!!document.querySelector('main:not([hidden])')||!!document.querySelector('.open');parent.postMessage({feedbackQA:true,width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,documentWidth:document.documentElement.scrollWidth,ready:visible},'*');},500);</script>`;
function mailbox(product) {
  const p = product === "uwu" ? "sakura" : "mailbox";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}</style><link rel="stylesheet" href="/${product}/feedback.css"></head><body><script>window.EPHONE_FEEDBACK_CONFIG={apiUrl:location.origin+'/feedback-api',turnstileSiteKey:'local-test'};localStorage.setItem('${product === "uwu" ? "sakura" : "ephone"}_feedback_threads_v1',JSON.stringify([${JSON.stringify(fixtures[product])}]));window.turnstile={render(el,opts){el.textContent='本地测试验证';opts.callback('test-token');return 1},remove(){},reset(){}};</script><script src="/${product}/tools.js"></script><script src="/${product}/client.js"></script><script>window.${product === "uwu" ? "UWU" : "EPhone"}Feedback.open('public');</script>${metrics}</body></html>`;
}
http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1:8790");
      const pathname = url.pathname;
      if (pathname === "/qa") {
        const surface = url.searchParams.get("surface") || "admin";
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          `<!doctype html><meta charset="utf-8"><style>body{font:13px sans-serif;margin:12px}.frames{display:flex;gap:12px}iframe{border:1px solid #ddd;height:820px;flex-shrink:0}pre{white-space:pre-wrap}</style><p>本地预览 · ${surface} · 320 / 375 / 390px</p><pre id="results">正在检查…</pre><div class="frames">${[320, 375, 390].map((w) => `<iframe width="${w}" src="/${surface}"></iframe>`).join("")}</div><script>const checks={};addEventListener('message',e=>{if(!e.data.feedbackQA)return;checks[e.data.width]=e.data;document.querySelector('#results').textContent=Object.values(checks).map(v=>v.width+'px：'+(v.overflow?'横向溢出':'无横向溢出')+'，实际宽度 '+v.documentWidth).join('\\n')});</script>`,
        );
        return;
      }
      if (pathname === "/ephone" || pathname === "/uwu") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(mailbox(pathname.slice(1)));
        return;
      }
      const asset =
        /^\/(ephone|uwu)\/(client\.js|tools\.js|feedback\.css)$/.exec(pathname);
      if (asset) {
        const [, , file] = asset,
          product = asset[1];
        const relative =
          product === "ephone"
            ? {
                "client.js": "modules/feedback/client.js",
                "tools.js": "modules/feedback/tools.js",
                "feedback.css": "css/feedback.css",
              }[file]
            : {
                "client.js": "js/modules/feedback.js",
                "tools.js": "js/modules/feedback-tools.js",
                "feedback.css": "css/modules/feedback.css",
              }[file];
        res.setHeader(
          "Content-Type",
          file.endsWith(".css") ? "text/css" : "application/javascript",
        );
        res.end(
          fs.readFileSync(
            path.join(product === "ephone" ? main : uwu, relative),
          ),
        );
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const input = Buffer.concat(chunks);
      let apiPath = pathname === "/admin" ? "/" : pathname;
      const publicApi = pathname.startsWith("/feedback-api");
      if (publicApi) apiPath = pathname.slice("/feedback-api".length) || "/";
      const request = new Request(
        "http://127.0.0.1:8790" + apiPath + url.search,
        {
          method: req.method,
          headers: req.headers,
          ...(input.length ? { body: input } : {}),
        },
      );
      const response = await (publicApi ? publicWorker : admin).fetch(
        request,
        env,
      );
      res.statusCode = response.status;
      response.headers.forEach((v, k) => res.setHeader(k, v));
      if (pathname === "/admin") {
        res.setHeader(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; connect-src 'self'",
        );
        const html = await response.text();
        res.end(
          html.replace(
            "<script>",
            '<script>sessionStorage.setItem("ephone_feedback_admin_token","' +
              "34".repeat(32) +
              '");',
          ) + metrics,
        );
      } else res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error(error);
      res.statusCode = 500;
      res.end("Local preview failed");
    }
  })
  .listen(8790, "127.0.0.1", () =>
    console.log(
      "Local feedback preview: http://127.0.0.1:8790/qa?surface=admin",
    ),
  );
