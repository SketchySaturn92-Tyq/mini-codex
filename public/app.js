'use strict';
/**
 * mini-codex 本地 Web 前端（原生 JS，零依赖）
 *
 * 目录：
 *   1. 基础工具（转义、DOM、格式化、网络）
 *   2. 全局状态与 DOM 引用
 *   3. 顶栏状态徽标
 *   4. 对话区（气泡、流式追加、发送 / 停止）
 *   5. 右侧时间线（工具卡片）
 *   6. 审批区
 *   7. 设置抽屉
 *   8. 历史会话回看
 *   9. SSE 文本流解析与事件分发
 *  10. 初始化
 *
 * 安全约定：所有来自服务器的文本，要么走 textContent，要么先过 escapeHtml。
 */

/* ============================================================
 * 1. 基础工具
 * ============================================================ */

const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** 把任意文本转义成可安全拼进 HTML 的形式。 */
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch]);
}

/** 按 id 取元素。 */
function $(id) {
  return document.getElementById(id);
}

/** 创建一个元素；文本一律走 textContent，天然防注入。 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

/** 清空子节点。 */
function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** 截断长文本，用于摘要展示。 */
function truncate(text, max) {
  const s = String(text == null ? '' : text);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 时间戳 → 时:分:秒。 */
function fmtClock(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 字节数 → 可读体积。 */
function fmtSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** 取路径最后一段。 */
function baseName(p) {
  const s = String(p || '');
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] || s;
}

/** 目录太长时保留尾部，前面用省略号。 */
function compactPath(p, max) {
  const s = String(p || '');
  return s.length > max ? `…${s.slice(-(max - 1))}` : s;
}

/** 工具参数 → 一行摘要（tool_start.summary 缺失时的兜底）。 */
function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const first = args.command || args.path || args.pattern || args.query || '';
  if (first) return truncate(String(first), 80);
  try {
    return truncate(JSON.stringify(args), 80);
  } catch (err) {
    return '';
  }
}

/** GET，返回解析后的 JSON；非 2xx 或 ok:false 都抛错。 */
async function getJSON(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `请求失败 HTTP ${res.status}`);
  if (data && data.ok === false) throw new Error(data.error || '请求失败');
  return data;
}

/** POST JSON，返回解析后的 JSON；非 2xx 或 ok:false 都抛错。 */
async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `请求失败 HTTP ${res.status}`);
  if (data && data.ok === false) throw new Error(data.error || '请求失败');
  return data;
}

/* ============================================================
 * 2. 全局状态与 DOM 引用
 * ============================================================ */

const app = {
  info: null, // GET /api/state 的返回
  running: false, // 是否正在跑一次 /api/chat
  abort: null, // 当前的 AbortController
  segmentEl: null, // 当前正在流式追加的思考段节点
  segmentText: '', // 该段已累积的文字
  lastAssistantText: '', // 最近一次完整助手文字
  think: null, // 本次运行的「思考过程」折叠块状态（结束后置空，块本身留在记录里）
  toolCards: new Map(), // toolId -> { card, dot, argsNode, statusNode, out }
  approvals: new Map(), // approvalId -> card
  guideDone: false, // 是否已提示过「没有密钥」
  replaying: false, // 是否处于只读回看模式
};

const dom = {
  // 顶栏
  badgeRoot: $('badge-root'),
  badgeModel: $('badge-model'),
  badgePolicy: $('badge-policy'),
  linkState: $('link-state'),
  btnSettings: $('btn-settings'),
  // 对话区
  chatScroll: $('chat-scroll'),
  chatList: $('chat-list'),
  chatMeta: $('chat-meta'),
  input: $('input'),
  sendBtn: $('btn-send'),
  composer: $('composer'),
  composerLocked: $('composer-locked'),
  // 回看
  replayList: $('replay-list'),
  replayEvents: $('replay-events'),
  replayFile: $('replay-file'),
  btnReplayExit: $('btn-replay-exit'),
  // 历史会话
  btnHistory: $('btn-history'),
  btnHistoryClose: $('btn-history-close'),
  historyPopover: $('history-popover'),
  historyList: $('history-list'),
  // 右侧栏
  approvalZone: $('approval-zone'),
  approvalList: $('approval-list'),
  timelineList: $('timeline-list'),
  timelineEmpty: $('timeline-empty'),
  runStats: $('run-stats'),
  runMeta: $('run-meta'),
  // 设置抽屉
  settingsDrawer: $('settings-drawer'),
  settingsMask: $('settings-mask'),
  settingsMsg: $('settings-msg'),
  btnSettingsClose: $('btn-settings-close'),
  btnSaveSettings: $('btn-save-settings'),
  btnTestConn: $('btn-test-conn'),
  setBaseUrl: $('set-baseurl'),
  setWorkDir: $('set-workdir'),
  setModel: $('set-model'),
  setFastModel: $('set-fastmodel'),
  setMaxTurns: $('set-maxturns'),
  setApiKey: $('set-apikey'),
  setAllowNetwork: $('set-allow-network'),
  setAllowDesktop: $('set-allow-desktop'),
  setMirror: $('set-mirror'),
  // 轻提示
  toast: $('toast'),
};

/* ============================================================
 * 3. 顶栏状态徽标
 * ============================================================ */

/** 权限档位 → 中文。 */
function policyLabel(policy) {
  if (policy === 'readonly') return '只读';
  if (policy === 'auto') return '全自动';
  if (policy === 'ask') return '询问';
  return policy ? String(policy) : '—';
}

function renderBadges(info) {
  const d = info || {};
  dom.badgeRoot.textContent = d.root ? compactPath(d.root, 34) : '—';
  dom.badgeRoot.title = d.root || '未获取到项目目录';
  dom.badgeModel.textContent = d.model || '—';
  dom.badgeModel.title = d.fastModel ? `主模型 ${d.model}；快速模型 ${d.fastModel}` : (d.model || '');
  dom.badgePolicy.textContent = policyLabel(d.policy);
}

function setLinkState(text, kind) {
  dom.linkState.textContent = text || '';
  dom.linkState.className = `link-state${kind ? ` ${kind}` : ''}`;
}

/** 轻提示，2 秒后自动消失。 */
let toastTimer = null;
function toast(message) {
  dom.toast.textContent = message;
  dom.toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { dom.toast.hidden = true; }, 2000);
}

/* ============================================================
 * 4. 对话区
 * ============================================================ */

function removeChatEmpty() {
  const node = dom.chatList.querySelector('.chat-empty');
  if (node) node.remove();
}

function ensureChatEmpty() {
  const text = '还没有对话。可以这样说：帮我看看 src 目录的结构，或者把这个 bug 定位一下。';
  dom.chatList.appendChild(el('div', 'chat-empty', text));
}

function scrollChatToEnd() {
  dom.chatScroll.scrollTop = dom.chatScroll.scrollHeight;
}

function scrollSideToEnd() {
  const box = dom.timelineList.parentElement && dom.timelineList.parentElement.parentElement;
  if (box) box.scrollTop = box.scrollHeight;
}

/** 造一个消息节点，返回 {wrap, body}。 */
function buildMsg(kind, role, text) {
  const wrap = el('div', `msg msg-${kind}`);
  if (role) wrap.appendChild(el('div', 'msg-role', role));
  const body = el('div', 'msg-body', text);
  wrap.appendChild(body);
  return { wrap, body };
}

/** 往对话区加一条消息，返回正文节点。 */
function addBubble(kind, text, role) {
  removeChatEmpty();
  const { wrap, body } = buildMsg(kind, role, text);
  dom.chatList.appendChild(wrap);
  scrollChatToEnd();
  return body;
}

function addNotice(text) {
  addBubble('notice', text, '');
}

function addError(text) {
  addBubble('error', text, '出错');
}

/* ---------- 思考过程折叠块 ----------
   模型每一轮的中间叙述（"我先看看…""再搜一下…"）都不进正文，
   统一塞进这个默认收起的浅色小块。正文只留 done.text 那份最终结论。 */

/** 造（或复用）本次运行的折叠块。 */
function ensureThinkBlock() {
  if (app.think && app.think.wrap) return app.think;
  removeChatEmpty();

  const wrap = el('div', 'think-block');
  const head = el('button', 'think-head');
  head.type = 'button';
  const chevron = el('span', 'think-chevron', '▸');
  const title = el('span', 'think-title', '思考过程');
  const meta = el('span', 'think-meta', '进行中…');
  head.append(chevron, title, meta);

  const body = el('div', 'think-body');
  wrap.append(head, body);
  dom.chatList.appendChild(wrap);

  const state = { wrap, head, body, meta, segEl: null, segText: '', count: 0, touched: false };
  app.think = state;

  head.addEventListener('click', () => {
    // 注意：run 结束后 app.think 会被置空，这里必须用闭包里的 state，
    // 否则点历史记录里的折叠块会读 null 报错。
    state.touched = true;
    state.wrap.classList.toggle('open');
  });

  scrollChatToEnd();
  return app.think;
}

function setThinkOpen(open) {
  if (app.think) app.think.wrap.classList.toggle('open', !!open);
}

/** 更新折叠块右侧那行小字。 */
function updateThinkMeta(text) {
  if (!app.think) return;
  app.think.meta.textContent = text != null ? text : `${app.think.count} 段 · 运行中…`;
}

/** 开始新的一段叙述；上一条会自然收尾。 */
function newThinkSeg() {
  const t = ensureThinkBlock();
  if (t.segEl) return t.segEl;
  const seg = el('div', 'think-seg');
  t.body.appendChild(seg);
  t.segEl = seg;
  t.segText = '';
  t.count += 1;
  updateThinkMeta();
  return seg;
}

/** 兼容旧调用：拿到当前正在写的段。 */
function ensureSegment() {
  return newThinkSeg();
}

/** 边收边追加。累积量存在当前段自己身上，避免跨段串味。 */
function appendDelta(text) {
  const t = ensureThinkBlock();
  const seg = newThinkSeg();
  t.segText += String(text == null ? '' : text);
  seg.textContent = t.segText;
  scrollChatToEnd();
}

/** assistant 事件：这一段的完整文字，直接覆盖。 */
function setSegmentText(text) {
  const t = ensureThinkBlock();
  const seg = newThinkSeg();
  t.segText = String(text == null ? '' : text);
  seg.textContent = t.segText;
  scrollChatToEnd();
}

/** 一段结束（遇到工具调用或整轮结束）：清空累积，下一段从头写起。 */
function endSegment() {
  if (!app.think) return;
  app.think.segEl = null;
  app.think.segText = '';
}

/**
 * 本次运行收尾。
 * force=true 强制展开（没有结论时，让人看到卡在哪）；
 * force=false 强制收起；不传则"用户自己点开过就保持打开"。
 */
function closeThink(force) {
  const t = app.think;
  if (!t) return;
  t.meta.textContent = t.count ? `${t.count} 段 · 点击展开` : '本次没有过程记录';
  if (force === true) setThinkOpen(true);
  else if (force === false) setThinkOpen(false);
  else if (!t.touched) setThinkOpen(false);
  app.think = null;
  app.segmentEl = null;
  app.segmentText = '';
}

/** 首次加载若没密钥，给一条醒目引导。 */
function showKeyGuide() {
  if (app.guideEl) return;
  const body = addBubble('guide', '还没有配置模型密钥，现在还不能对话。点右上角「设置」，填入 apiKey 后保存即可开始。', '需要配置');
  app.guideEl = (body && body.parentElement) || body;
}

/** 密钥填好以后，把那条提示收起来，免得一直挂着让人以为还没配好。 */
function hideKeyGuide() {
  if (!app.guideEl) return;
  if (app.guideEl.parentNode) app.guideEl.parentNode.removeChild(app.guideEl);
  app.guideEl = null;
}

/* ============================================================
 * 5. 右侧时间线
 * ============================================================ */

function hideTimelineEmpty() {
  dom.timelineEmpty.hidden = true;
}

/** 一轮的开始分隔线。 */
function addTurnLine(data) {
  const d = data || {};
  const text = `第 ${d.turn}/${d.maxTurns} 轮 · 上下文约 ${d.tokens} tokens`;
  dom.timelineList.appendChild(el('div', 'turn-line', text));
  dom.runMeta.textContent = `第 ${d.turn}/${d.maxTurns} 轮`;
  hideTimelineEmpty();
  scrollSideToEnd();
}

/** 一行说明文字：上下文压缩、审批、停止等。 */
function addNoteLine(text) {
  dom.timelineList.appendChild(el('div', 'note-line', text));
  hideTimelineEmpty();
  scrollSideToEnd();
}

/** 工具开始：插一张运行中的卡片。 */
function markToolStart(ev) {
  const e = ev || {};
  const card = el('div', 'tool-card');
  const head = el('div', 'tool-head');
  const dot = el('span', 'tool-dot running');
  const name = el('span', 'tool-name', e.tool || 'tool');
  const argsNode = el('span', 'tool-args', e.summary || summarizeArgs(e.args) || '');
  const statusNode = el('span', 'tool-status', '运行中');
  head.append(dot, name, argsNode, statusNode);

  const out = el('pre', 'tool-output');
  card.append(head, out);
  head.addEventListener('click', () => card.classList.toggle('open'));

  dom.timelineList.appendChild(card);
  app.toolCards.set(e.id, { card, dot, argsNode, statusNode, out });
  hideTimelineEmpty();
  scrollSideToEnd();
}

/** 工具结束：更新状态并塞入完整输出。 */
function markToolEnd(ev) {
  const e = ev || {};
  let rec = app.toolCards.get(e.id);
  if (!rec) {
    // 没收到 tool_start 也能显示，避免丢信息
    markToolStart({ id: e.id, tool: e.tool, summary: e.summary });
    rec = app.toolCards.get(e.id);
  }
  if (!rec) return;
  const output = String(e.output == null ? '' : e.output);
  rec.out.textContent = output || '（没有输出）';
  rec.dot.className = `tool-dot ${e.ok ? 'ok' : 'fail'}`;
  rec.statusNode.textContent = e.ok ? '成功' : '失败';
  if (e.summary) rec.argsNode.textContent = e.summary;
  scrollSideToEnd();
}

/* ============================================================
 * 6. 审批区
 * ============================================================ */

/** 收到审批请求：在右侧栏顶部显示醒目卡片。 */
function showApproval(ev) {
  const e = ev || {};
  const card = el('div', 'approval-card');
  const head = el('div', 'approval-head');
  head.append(el('span', 'approval-tool', e.tool || 'tool'), el('span', 'approval-tag', '需要你的许可'));

  const preview = el('pre', 'approval-detail', e.preview || e.detail || '（无详情）');
  const actions = el('div', 'approval-actions');
  const allowBtn = el('button', 'btn btn-sm btn-ok', '允许');
  const denyBtn = el('button', 'btn btn-sm btn-no', '拒绝');
  allowBtn.type = 'button';
  denyBtn.type = 'button';
  const stateText = el('span', 'approval-state', '');
  actions.append(allowBtn, denyBtn, stateText);

  card.append(head, preview, actions);
  allowBtn.addEventListener('click', () => answerApproval(e.id, true, card));
  denyBtn.addEventListener('click', () => answerApproval(e.id, false, card));

  dom.approvalList.appendChild(card);
  dom.approvalZone.hidden = false;
  app.approvals.set(e.id, card);
  addNoteLine(`等待确认：${e.tool || 'tool'} ${truncate(e.detail || e.preview || '', 60)}`);
}

/** 点「允许 / 拒绝」后调接口。 */
async function answerApproval(id, allow, card) {
  const stateText = card.querySelector('.approval-state');
  card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  stateText.textContent = '提交中…';
  try {
    await postJSON('/api/approve', { id, allow });
    markApprovalDone(id, allow);
  } catch (err) {
    stateText.textContent = `提交失败：${err.message}`;
    card.querySelectorAll('button').forEach((b) => { b.disabled = false; });
  }
}

/** 把卡片标记为已处理。 */
function markApprovalDone(id, allowed) {
  const card = app.approvals.get(id);
  if (!card) return;
  card.classList.add('handled');
  card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  const stateText = card.querySelector('.approval-state');
  if (stateText) stateText.textContent = allowed ? '已允许' : '已拒绝';
}

/* ============================================================
 * 7. 设置抽屉
 * ============================================================ */

function setDrawerMsg(text, kind) {
  dom.settingsMsg.textContent = text || '';
  dom.settingsMsg.className = `drawer-msg${kind ? ` ${kind}` : ''}`;
}

function openSettings() {
  fillSettings(app.info);
  setDrawerMsg('', '');
  dom.settingsDrawer.hidden = false;
  dom.settingsMask.hidden = false;
}

function closeSettings() {
  dom.settingsDrawer.hidden = true;
  dom.settingsMask.hidden = true;
}

/** 用 /api/state 的值填充表单；密钥不回填，留空即不修改。 */
function fillSettings(info) {
  const d = info || {};
  dom.setBaseUrl.value = d.baseUrl || '';
  dom.setWorkDir.value = d.workdir || '';
  dom.setModel.value = d.model || '';
  dom.setFastModel.value = d.fastModel || '';
  dom.setMaxTurns.value = d.maxTurns != null ? String(d.maxTurns) : '';
  dom.setApiKey.value = '';
  dom.setApiKey.placeholder = d.hasApiKey ? '已配置，留空则不修改' : 'sk-…';
  const policy = d.policy || 'ask';
  document.querySelectorAll('input[name="policy"]').forEach((radio) => {
    radio.checked = radio.value === policy;
  });
  // 两个扩展能力开关，默认关
  dom.setAllowNetwork.checked = d.allowNetwork === true;
  dom.setAllowDesktop.checked = d.allowDesktop === true;
  dom.setMirror.checked = d.mirrorTerminal === true;
}

function currentPolicy() {
  const checked = document.querySelector('input[name="policy"]:checked');
  return checked ? checked.value : 'ask';
}

async function saveSettings() {
  const apiKey = dom.setApiKey.value.trim();
  const body = {
    baseUrl: dom.setBaseUrl.value.trim(),
    workdir: dom.setWorkDir.value.trim(),
    model: dom.setModel.value.trim(),
    fastModel: dom.setFastModel.value.trim(),
    maxTurns: dom.setMaxTurns.value.trim(),
    policy: currentPolicy(),
    allowNetwork: dom.setAllowNetwork.checked,
    allowDesktop: dom.setAllowDesktop.checked,
    mirrorTerminal: dom.setMirror.checked,
  };
  // 密钥留空表示「不改动」：省略该字段，避免把已保存的密钥清掉。
  if (apiKey) body.apiKey = apiKey;

  dom.btnSaveSettings.disabled = true;
  setDrawerMsg('保存中…', '');
  try {
    const data = await postJSON('/api/settings', body);
    if (data && data.state) applyState(data.state);
    setDrawerMsg('已保存', 'ok');
    toast('设置已保存');
    dom.setApiKey.value = '';
    if (app.info && app.info.hasApiKey) dom.setApiKey.placeholder = '已配置，留空则不修改';
  } catch (err) {
    setDrawerMsg(`保存失败：${err.message}`, 'err');
  } finally {
    dom.btnSaveSettings.disabled = false;
  }
}

/** 测试当前填的接口地址与密钥能不能真的对话，通过后顺手保存。 */
async function testConnection() {
  const body = {
    baseUrl: dom.setBaseUrl.value.trim(),
    model: dom.setModel.value.trim(),
    apiKey: dom.setApiKey.value.trim(),
  };
  dom.btnTestConn.disabled = true;
  setDrawerMsg('正在测试连接…', '');
  try {
    const data = await postJSON('/api/test-connection', body);
    if (data && data.ok) {
      setDrawerMsg(`${data.message || '连接成功'}，正在保存…`, 'ok');
      // 测通就直接存，避免出现「测过了但忘了点保存」这种坑
      await saveSettings();
    } else {
      setDrawerMsg(`连不上：${(data && data.error) || '未知原因'}`, 'err');
    }
  } catch (err) {
    setDrawerMsg(`测试失败：${err.message}`, 'err');
  } finally {
    dom.btnTestConn.disabled = false;
  }
}

/** 把一份 state 应用到界面。 */
function applyState(info) {
  app.info = info || {};
  renderBadges(app.info);
  if (app.info.hasApiKey === false) showKeyGuide();
  else hideKeyGuide();
}

/* ============================================================
 * 8. 历史会话回看
 * ============================================================ */

async function toggleHistory() {
  if (!dom.historyPopover.hidden) {
    dom.historyPopover.hidden = true;
    return;
  }
  dom.historyPopover.hidden = false;
  await loadSessions();
}

async function loadSessions() {
  clear(dom.historyList);
  dom.historyList.appendChild(el('div', 'popover-empty', '加载中…'));
  try {
    const data = await getJSON('/api/sessions');
    const list = (data && Array.isArray(data.sessions)) ? data.sessions : [];
    clear(dom.historyList);
    if (!list.length) {
      dom.historyList.appendChild(el('div', 'popover-empty', '还没有会话记录。'));
      return;
    }
    list.forEach((s) => dom.historyList.appendChild(renderSessionItem(s)));
  } catch (err) {
    clear(dom.historyList);
    dom.historyList.appendChild(el('div', 'popover-empty', `读取失败：${err.message}`));
  }
}

function renderSessionItem(s) {
  const item = el('button', 'session-item');
  item.type = 'button';
  item.appendChild(el('span', 'session-name', baseName(s.file)));
  item.appendChild(el('span', 'session-sub', `${fmtClock(s.time)} · ${fmtSize(s.size)}`));
  item.addEventListener('click', () => {
    dom.historyPopover.hidden = true;
    openReplay(s.file);
  });
  return item;
}

/** 只读显示某次历史会话的事件流。 */
async function openReplay(file) {
  try {
    const data = await getJSON(`/api/session?file=${encodeURIComponent(file)}`);
    renderReplay(file, (data && Array.isArray(data.events)) ? data.events : []);
  } catch (err) {
    toast(`读取会话失败：${err.message}`);
  }
}

function renderReplay(file, events) {
  dom.replayFile.textContent = file;
  const box = dom.replayEvents;
  clear(box);
  // 只挑 user / tool_result / run_end 三类显示
  const useful = events.filter((e) => e && (e.type === 'user' || e.type === 'tool_result' || e.type === 'run_end'));
  if (!useful.length) {
    box.appendChild(el('div', 'chat-empty', '这次会话没有可显示的事件。'));
  } else {
    useful.forEach((e) => box.appendChild(renderReplayItem(e)));
  }

  dom.chatList.hidden = true;
  dom.replayList.hidden = false;
  dom.composer.hidden = true;
  dom.composerLocked.hidden = false;
  app.replaying = true;
  dom.chatScroll.scrollTop = 0;
}

function renderReplayItem(e) {
  if (e.type === 'user') {
    return buildMsg('user', `你 · ${fmtClock(e.time)}`, e.text).wrap;
  }
  if (e.type === 'tool_result') {
    const wrap = el('div', 'replay-item');
    wrap.appendChild(el('div', 'msg-role', `${fmtClock(e.time)} · 工具调用`));
    const card = el('div', 'tool-card open');
    const head = el('div', 'tool-head');
    head.append(
      el('span', `tool-dot ${e.ok ? 'ok' : 'fail'}`),
      el('span', 'tool-name', e.tool || 'tool'),
      el('span', 'tool-args', e.summary || ''),
      el('span', 'tool-status', e.ok ? '成功' : '失败'),
    );
    const out = el('pre', 'tool-output', String(e.output == null ? '' : e.output) || '（没有输出）');
    card.append(head, out);
    wrap.appendChild(card);
    return wrap;
  }
  const wrap = el('div', 'replay-item');
  wrap.appendChild(el('div', 'note-line', `运行结束：${e.stopReason || '未知'}${e.text ? ` · ${truncate(e.text, 60)}` : ''}`));
  return wrap;
}

/** 退出回看，回到实时对话。 */
function exitReplay() {
  app.replaying = false;
  dom.replayList.hidden = true;
  dom.chatList.hidden = false;
  dom.composer.hidden = false;
  dom.composerLocked.hidden = true;
  clear(dom.replayEvents);
  scrollChatToEnd();
}

/* ============================================================
 * 9. SSE 文本流解析与事件分发
 * ============================================================ */

/** 把缓冲区里已经完整的事件块（以空行分隔）逐个消费掉。 */
function drainEvents(buffer) {
  let rest = buffer;
  for (;;) {
    const idx = rest.indexOf('\n\n');
    if (idx < 0) return rest;
    const chunk = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    if (chunk.trim()) handleRawEvent(chunk);
  }
}

/** 解析单个事件块：event: 名字 + 若干 data: 行。 */
function handleRawEvent(raw) {
  let eventName = 'message';
  const dataLines = [];
  raw.split('\n').forEach((line) => {
    const l = line.replace(/\r$/, '');
    if (!l || l.startsWith(':')) return; // 空行或心跳注释
    if (l.startsWith('event:')) eventName = l.slice(6).trim();
    else if (l.startsWith('data:')) dataLines.push(l.slice(5).replace(/^ /, ''));
  });
  if (!dataLines.length) return;
  let data = {};
  try {
    data = JSON.parse(dataLines.join('\n'));
  } catch (err) {
    data = { text: dataLines.join('\n') };
  }
  dispatchEvent(eventName, data);
}

/** 一个事件 → 一处界面更新。 */
function dispatchEvent(name, data) {
  const d = data || {};
  switch (name) {
    case 'turn':
      addTurnLine(d);
      break;

    case 'delta':
      appendDelta(d.text);
      break;

    case 'assistant':
      setSegmentText(d.text);
      break;

    case 'tool_start':
      endSegment(); // 工具调用前的文字到此为止
      markToolStart(d);
      break;

    case 'tool_end':
      markToolEnd(d);
      break;

    case 'approval':
      showApproval(d);
      break;

    case 'approval_done':
      markApprovalDone(d.id, Boolean(d.allowed));
      addNoteLine(`审批结果：${d.allowed ? '已允许' : '已拒绝'}`);
      break;

    case 'context':
      addNoteLine(`上下文整理：压缩 ${d.compressed || 0} 条，丢弃 ${d.dropped || 0} 条，约 ${d.tokens || 0} tokens`);
      break;

    case 'error':
      addError(d.message || '服务端返回了未知错误。');
      addNoteLine(`错误：${truncate(d.message || '', 80)}`);
      break;

    case 'done':
      handleDone(d);
      break;

    default:
      // 未知事件不崩页面，留给时间线一条记录
      addNoteLine(`未知事件：${name}`);
  }
}

function handleDone(d) {
  endSegment();
  const usage = d.usage || {};
  const finalText = String(d.text == null ? '' : d.text).trim();
  const failed = d.stopReason === 'model_error' || d.stopReason === 'crash';

  if (failed) {
    // 具体的错误已经由 error 事件弹出过了，这里只把过程展开，方便追查
    closeThink(true);
  } else if (finalText) {
    // 正常收尾：过程收起，只把结论留在正文里
    closeThink(false);
    addBubble('assistant', d.text, '结论');
    app.lastAssistantText = finalText;
  } else {
    // 没结论（例如轮数用尽或被停止）：展开过程，让人看到做到哪一步
    closeThink(true);
    const why = d.stopReason && d.stopReason !== 'model_done'
      ? `本次没有给出最终结论，停止原因：${d.stopReason}。`
      : '模型这一轮没有输出文字。';
    addBubble('notice', `${why}上面的「思考过程」可以展开查看。`, '本次结果');
  }

  const parts = [];
  if (typeof d.turns === 'number') parts.push(`${d.turns} 轮`);
  if (typeof d.toolCalls === 'number') parts.push(`${d.toolCalls} 次工具调用`);
  parts.push(`tokens ${usage.promptTokens || 0}+${usage.completionTokens || 0}`);
  if (d.compressed || d.dropped) parts.push(`压缩 ${d.compressed || 0} / 丢弃 ${d.dropped || 0}`);
  if (d.stopReason && d.stopReason !== 'model_done') parts.push(`停止原因 ${d.stopReason}`);
  dom.runStats.textContent = parts.join(' · ');
  dom.runMeta.textContent = '';
  setRunning(false);
}

/* ============================================================
 * 10. 发送 / 停止
 * ============================================================ */

/** 切换运行状态：按钮在「发送」和「停止」之间变。 */
function setRunning(on) {
  app.running = on;
  dom.sendBtn.textContent = on ? '停止' : '发送';
  dom.sendBtn.classList.toggle('btn-primary', !on);
  dom.sendBtn.classList.toggle('btn-danger', on);
  dom.chatMeta.textContent = on ? '运行中…' : '';
}

/** 输入框高度随内容增长。 */
function autoGrow() {
  const ta = dom.input;
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
}

/** 开始新一轮：清空右侧时间线。 */
function resetRun() {
  app.toolCards.clear();
  app.approvals.clear();
  app.segmentEl = null;
  app.segmentText = '';
  app.lastAssistantText = '';
  app.think = null; // 上一轮的折叠块留在记录里，这一轮另起一个
  clear(dom.timelineList);
  clear(dom.approvalList);
  dom.approvalZone.hidden = true;
  dom.timelineEmpty.hidden = false;
  dom.runStats.textContent = '';
  dom.runMeta.textContent = '';
}

/** POST /api/chat，手动解析 SSE（EventSource 不支持 POST）。 */
async function streamChat(text, signal) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j && j.error) detail = j.error;
    } catch (err) { /* 响应体不是 JSON，忽略 */ }
    throw new Error(detail);
  }
  if (!res.body) throw new Error('当前浏览器不支持流式读取响应');

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    buffer = drainEvents(buffer);
  }
  buffer += decoder.decode().replace(/\r\n/g, '\n');
  if (buffer.trim()) handleRawEvent(buffer);
}

async function sendMessage() {
  const text = dom.input.value.trim();
  if (!text) return;
  if (app.replaying) { toast('回看模式下不能发送'); return; }
  if (app.running) return; // 运行中忽略重复发送

  dom.input.value = '';
  autoGrow();
  addBubble('user', text, '你');
  resetRun();
  setRunning(true);

  const controller = new AbortController();
  app.abort = controller;
  try {
    await streamChat(text, controller.signal);
  } catch (err) {
    if (err && err.name === 'AbortError') {
      addNotice('已停止本次运行。');
      addNoteLine('被用户手动停止。');
    } else {
      addError(`对话请求失败：${err.message}`);
    }
    closeThink(true); // 中断或出错时把过程展开，方便看卡在哪
  } finally {
    app.abort = null;
    endSegment();
    closeThink(); // 兜底：任何路径出去都不能让折叠块停在"进行中…"
    setRunning(false);
  }
}

/** 点按钮：运行中是「停止」，否则是「发送」。 */
function onSendButtonClick() {
  if (app.running) {
    if (app.abort) app.abort.abort();
    return;
  }
  sendMessage();
}

/* ============================================================
 * 11. 初始化
 * ============================================================ */

/** 读取服务状态，填徽标并决定要不要提示配置密钥。 */
async function loadState() {
  setLinkState('连接中…', '');
  try {
    const data = await getJSON('/api/state');
    applyState(data);
    setLinkState('已连接', 'ok');
  } catch (err) {
    setLinkState('连接失败', 'err');
    addError(`读取服务状态失败：${err.message}。请确认服务已启动，并从它提供的地址打开本页面。`);
  }
}

function bindEvents() {
  // 输入框
  dom.input.addEventListener('input', autoGrow);
  dom.input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    if (app.running) { toast('正在运行中，先点「停止」再发送'); return; }
    sendMessage();
  });
  dom.sendBtn.addEventListener('click', onSendButtonClick);

  // 设置抽屉
  dom.btnSettings.addEventListener('click', openSettings);
  dom.btnSettingsClose.addEventListener('click', closeSettings);
  dom.settingsMask.addEventListener('click', closeSettings);
  dom.btnSaveSettings.addEventListener('click', saveSettings);
  dom.btnTestConn.addEventListener('click', testConnection);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeSettings();
      dom.historyPopover.hidden = true;
    }
  });

  // 历史会话
  dom.btnHistory.addEventListener('click', toggleHistory);
  dom.btnHistoryClose.addEventListener('click', () => { dom.historyPopover.hidden = true; });
  dom.btnReplayExit.addEventListener('click', exitReplay);
  document.addEventListener('click', (e) => {
    if (dom.historyPopover.hidden) return;
    if (dom.historyPopover.contains(e.target) || dom.btnHistory.contains(e.target)) return;
    dom.historyPopover.hidden = true;
  });
}

function init() {
  bindEvents();
  autoGrow();
  ensureChatEmpty();
  loadState();
}

init();
