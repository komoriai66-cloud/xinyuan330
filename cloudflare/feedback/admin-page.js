import { ADMIN_STYLE } from './admin-style.js';
import { ADMIN_SCRIPT } from './admin-client.js';

export const ADMIN_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>反馈管理</title>
<style>${ADMIN_STYLE}</style></head><body><header><span>EPhone / UWU · 反馈管理</span><button id="logout" hidden>退出</button></header>
<div id="login"><h2>管理员登录</h2><p class="meta">管理密钥只保存在本次标签页。</p><form id="login-form"><label>管理密钥<input name="token" type="password" autocomplete="off" pattern="[0-9a-fA-F]{64}" required></label><button class="primary">进入管理页</button></form><div id="login-notice" role="status"></div></div>
<main hidden><aside><nav id="products"><button data-product="all" class="active">全部来源</button><button data-product="ephone">EPhone</button><button data-product="uwu">UWU</button></nav>
<nav id="views"><button data-view="threads" class="active">收件箱</button><button data-view="tasks">待办</button><button data-view="knowledge">解答</button><button id="refresh">刷新</button></nav>
<div id="overview" class="overview" aria-label="需要关注的事项"></div>
<div class="toolbar"><input id="search" placeholder="搜索正文、标题或备注" aria-label="搜索"><select id="filter" aria-label="筛选"></select><button id="create" hidden>新增</button></div>
<div id="kind-tabs" class="kind-tabs"><button data-kind="all" class="active">全部</button><button data-kind="private">私密</button><button data-kind="public">公开</button></div>
<div id="notice" role="status"></div><div id="list" class="list">正在加载…</div><button id="more" hidden>加载更早反馈</button></aside>
<section id="detail"><p class="meta">选择一条反馈查看并回复。</p></section></main>
<div id="modal" class="modal-layer" hidden><div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="modal-title"><h3 id="modal-title"></h3><div id="modal-body"></div><div class="modal-actions"><button id="modal-cancel">取消</button><button id="modal-ok" class="primary">确定</button></div><p id="modal-error" role="status"></p></div></div>
<script>${ADMIN_SCRIPT}</script></body></html>`;
