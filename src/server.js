'use strict';
/**
 * 本地 Web 服务：给网页界面提供接口。
 * 只用 Node 自带的 http 模块，没有第三方依赖。
 *
 * 几条硬性约定：
 *   1. 只监听 127.0.0.1，不对外网开放。
 *   2. 静态文件只从 public 目录读，不接受任意路径。
 *   3. 审批请求挂在内存里等用户点按钮，超时（默认 5 分钟）自动拒绝。
 *   4. 读会话日志只允许读项目内 .mini-codex/sessions 下的文件。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const { resolveConfig } = require('./config');
const { Safety } = require('./safety');
const { defaultRegistry } = require('./tools');
const { createConversation, runTask } = require('./loop');
const { createSession, listSessions, readSession, LOG_DIR } = require('./session');
const { chooseModel } = require('./router');
const { readSettings, writeSettings } = require('./settings');
const { explainNetworkError, explainApiError, chat } = require('./model');
const { allSessions } = require('./terminal');
const pkg = require('../package.json');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BODY = 1024 * 1024;

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  const name = urlPath === '/' ? 'index.html' : path.basename(urlPath);
  const file = path.join(PUBLIC_DIR, name);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) {
    sendJson(res, 404, { ok: false, error: '没有这个文件' });
    return;
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}

/** 组装当前配置（网页上改过的设置会立即生效）。 */
function currentConfig(root, extra = {}) {
  return resolveConfig({ root, argv: { stream: true, ...extra } });
}

function buildState({ root, registry, sessionFile }) {
  const cfg = currentConfig(root);
  let sessions = [];
  try {
    sessions = listSessions(root, 30).map((s) => ({
      file: s.file,
      size: s.size,
      time: fs.statSync(s.file).mtime.toISOString(),
    }));
  } catch (err) {
    sessions = [];
  }
  if (!sessions.length && sessionFile) {
    sessions = [{ file: sessionFile, size: 0, time: new Date().toISOString() }];
  }
  return {
    ok: true,
    version: pkg.version,
    root,
    model: cfg.model,
    fastModel: cfg.fastModel || '',
    baseUrl: cfg.baseUrl,
    hasApiKey: cfg.hasApiKey,
    policy: cfg.policy,
    workdir: cfg.workdir || '',
    maxTurns: cfg.maxTurns,
    mirrorTerminal: !!cfg.mirrorTerminal,
    terminal: allSessions()[0] || null,
    allowNetwork: !!cfg.allowNetwork,
    allowDesktop: !!cfg.allowDesktop,
    tools: registry.tools.map((t) => t.name),
    sessions,
  };
}

/** 把 ~ 展开成用户主目录。 */
function expandHome(p) {
  const s = String(p || '').trim();
  if (!s) return '';
  if (s === '~') return process.env.HOME || s;
  if (s.startsWith('~/')) return path.join(process.env.HOME || '', s.slice(2));
  return s;
}

/**
 * 这次任务实际能在哪个目录里活动。
 * 设置里填了 workdir 就用它（比如让 agent 去整理桌面），没填就用启动目录。
 * 目录不存在就返回 null，让调用方明确报错，而不是悄悄退回项目目录。
 */
function resolveTaskRoot(cfg, fallback) {
  const raw = expandHome(cfg.workdir);
  if (!raw) return fallback;
  const abs = path.resolve(raw);
  return fs.existsSync(abs) ? abs : null;
}

async function startServer({ root, port = 3333, host = '127.0.0.1', onReady }) {
  const registry = defaultRegistry();
  const approvals = new Map(); // 待用户确认的请求：id -> { resolve }
  let approvalSeq = 0;
  // 同一时刻只允许一个任务在跑。
  // 两个任务共用同一份对话历史，如果并发，两条消息流会交错插进同一个数组，
  // 就会出现"tool 消息找不到对应的 tool_calls"，上游直接返回 400。
  let activeRun = false;
  let taskRoot = root;
  let conversation = createConversation({ cfg: currentConfig(root), registry, root: taskRoot });

  /** 工作目录变了就重建对话——系统提示词里写着当前目录，不能沿用旧的。 */
  function conversationFor(nextRoot) {
    if (nextRoot !== taskRoot) {
      taskRoot = nextRoot;
      conversation = createConversation({ cfg: currentConfig(root), registry, root: taskRoot });
    }
    return conversation;
  }  const session = createSession({ root, meta: { mode: 'web', cwd: root } });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${host}`);
    const route = `${req.method} ${url.pathname}`;

    try {
      if (route === 'GET /' || route === 'GET /index.html' || route === 'GET /style.css' || route === 'GET /app.js') {
        serveStatic(res, url.pathname);
        return;
      }

      if (route === 'GET /api/state') {
        sendJson(res, 200, buildState({ root, registry, sessionFile: session.file }));
        return;
      }

      if (route === 'POST /api/settings') {
        const body = await readBody(req);
        try {
          writeSettings(root, body || {});
        } catch (err) {
          sendJson(res, 400, { ok: false, error: err.message });
          return;
        }
        // 权限、模型或工作目录可能变了，重建对话（系统提示词里写着这些）
        const cfgAfter = currentConfig(root);
        conversationFor(resolveTaskRoot(cfgAfter, root) || root);
        conversation = createConversation({ cfg: cfgAfter, registry, root: taskRoot });
        sendJson(res, 200, { ok: true, state: buildState({ root, registry, sessionFile: session.file }) });
        return;
      }

      if (route === 'GET /api/sessions') {
        const sessions = listSessions(root, 30).map((s) => ({
          file: s.file,
          size: s.size,
          time: fs.statSync(s.file).mtime.toISOString(),
        }));
        sendJson(res, 200, { ok: true, sessions });
        return;
      }

      if (route === 'GET /api/session') {
        const file = url.searchParams.get('file') || '';
        const sessionsDir = path.join(root, LOG_DIR);
        const resolved = path.resolve(file);
        if (!resolved.startsWith(sessionsDir) || !fs.existsSync(resolved)) {
          sendJson(res, 404, { ok: false, error: '找不到这个会话记录' });
          return;
        }
        sendJson(res, 200, { ok: true, events: readSession(resolved, 500) });
        return;
      }

      if (route === 'POST /api/test-connection') {
        const body = await readBody(req);
        const cfg = currentConfig(root);
        const baseUrl = String(body.baseUrl || cfg.baseUrl || '').trim();
        const apiKey = String(body.apiKey || cfg.apiKey || '').trim();
        const model = String(body.model || cfg.model || '').trim();
        // 接口形态：请求里没带就用配置里的，默认 auto
        const apiMode = String(body.apiMode || cfg.apiMode || 'auto');
        if (!baseUrl) {
          sendJson(res, 200, { ok: false, error: '请先填接口地址' });
          return;
        }
        if (!model) {
          sendJson(res, 200, { ok: false, error: '请先填模型名' });
          return;
        }

        // 直接复用真实调用链：这样"测试连接"与真正干活走的是同一条路，
        // 不会出现"测试通过但一聊天就报错"的假成功。
        const started = Date.now();
        try {
          const r = await chat({
            baseUrl,
            apiKey,
            model,
            messages: [{ role: 'user', content: 'ping，请回复 pong' }],
            apiMode,
            timeoutMs: 30000,
            stream: false,
          });          const ms = Date.now() - started;
          if (r.ok) {
            sendJson(res, 200, {
              ok: true,
              ms,
              message: `连接成功，模型已回应（${ms}ms）${r.text ? `：${String(r.text).slice(0, 40)}` : ''}`,
            });
          } else {
            sendJson(res, 200, { ok: false, ms, error: r.error });
          }
        } catch (err) {
          sendJson(res, 200, { ok: false, error: explainNetworkError(err, baseUrl) });
        }
        return;
      }

      if (route === 'POST /api/approve') {
        const body = await readBody(req);
        const pending = approvals.get(body.id);
        if (!pending) {
          sendJson(res, 404, { ok: false, error: '这条确认请求已经失效或已超时' });
          return;
        }
        approvals.delete(body.id);
        pending.resolve(!!body.allow);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (route === 'POST /api/chat') {
        const body = await readBody(req);
        const text = String(body.text || '').trim();
        if (!text) {
          sendJson(res, 400, { ok: false, error: '内容不能为空' });
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });

        let closed = false;
        req.on('close', () => {
          closed = true;
          // 页面关掉或刷新后，把还挂着的确认请求立刻按"拒绝"处理，
          // 否则这个任务会在后台空等五分钟，还会继续改对话历史。
          for (const [id, pending] of approvals) {
            pending.resolve(false);
            approvals.delete(id);
          }
        });
        const write = (event, data) => {
          if (closed) return;
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        if (activeRun) {
          write('error', { message: '上一个任务还在跑。等它结束，或者到终端窗口按 Ctrl+C 重启服务，再发这条消息。' });
          write('done', { stopReason: 'busy', text: '', turns: 0, toolCalls: 0, usage: {} });
          res.end();
          return;
        }
        activeRun = true;

        // 每次任务都按最新设置取配置，并做一次模型路由
        const cfg = currentConfig(root);
        const nextRoot = resolveTaskRoot(cfg, root);
        if (!nextRoot) {
          write('error', { message: `工作目录不存在：${cfg.workdir}。请到「设置」里填一个已经存在的文件夹。` });
          write('done', { stopReason: 'bad_workdir', text: '', turns: 0, toolCalls: 0, usage: {} });
          res.end();
          return;
        }
        const activeConversation = conversationFor(nextRoot);
        const routed = chooseModel({ cfg, input: text, conversation: activeConversation });
        cfg.model = routed.model;
        write('start', { model: routed.model, tier: routed.tier, reason: routed.reason, workdir: nextRoot });

        let currentTool = '';
        const approve = ({ detail, preview }) => new Promise((resolve) => {
          const id = `ap_${++approvalSeq}_${Date.now().toString(36)}`;
          const timer = setTimeout(() => {
            approvals.delete(id);
            write('approval_done', { id, allowed: false, timeout: true });
            resolve(false);
          }, APPROVAL_TIMEOUT_MS);
          approvals.set(id, {
            resolve: (allow) => {
              clearTimeout(timer);
              resolve(allow);
            },
          });
          write('approval', { id, tool: currentTool, detail, preview });
        });

        const safety = new Safety({
          root: nextRoot,
          policy: cfg.policy,
          approve,
          allowNetwork: cfg.allowNetwork,
          allowDesktop: cfg.allowDesktop,
        });

        const io = {
          onTurnStart: ({ turn, maxTurns, tokens }) => write('turn', { turn, maxTurns, tokens }),
          onDelta: (t) => write('delta', { text: t }),
          onAssistantText: (t) => write('assistant', { text: t }),
          onToolApprovalRequest: ({ tool }) => { currentTool = tool; },
          onToolStart: (ev) => {
            // id 由 loop.js 透传（就是模型的 tool_call id），保证 start 与 end 能对上；
            // 以前两边各自生成一个时间戳，导致时间线里一次调用留下两张卡片。
            currentTool = ev.tool;
            const args = ev.args || {};
            const summary = ev.tool === 'run_shell' ? String(args.command || '') : String(args.path || args.from || '');
            write('tool_start', {
              id: ev.id || `t_${Date.now().toString(36)}`,
              tool: ev.tool,
              args,
              summary: summary.slice(0, 120),
            });
          },
          onToolEnd: (ev) => {
            write('tool_end', {
              id: ev.id || `t_${Date.now().toString(36)}`,
              tool: ev.tool,
              ok: !!ev.result.ok,
              output: String(ev.result.output || '').slice(0, 8000),
              summary: String(ev.result.output || '').split('\n')[0].slice(0, 160),
            });
          },
          onContext: (info) => write('context', info),
          onError: (message) => write('error', { message }),
        };

        let result;
        try {
          result = await runTask({ input: text, conversation: activeConversation, cfg, registry, safety, session, io });
        } catch (err) {
          write('error', { message: `执行出错：${err.message}` });
          result = { text: '', stopReason: 'crash', stats: { turns: 0, toolCalls: 0, usage: {} } };
        } finally {
          activeRun = false; // 无论成功失败都要解锁，否则后面再也发不出消息
        }

        write('done', {
          stopReason: result.stopReason,
          text: result.text || '',
          turns: result.stats.turns,
          toolCalls: result.stats.toolCalls,
          usage: result.stats.usage || {},
          compressed: result.stats.compressed || 0,
          dropped: result.stats.dropped || 0,
        });

        // 用户中途关掉页面时，把所有还在等确认的请求按拒绝处理
        for (const [id, pending] of approvals) {
          pending.resolve(false);
          approvals.delete(id);
        }
        res.end();
        return;
      }

      sendJson(res, 404, { ok: false, error: `没有这个接口：${route}` });
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: err.message });
      else res.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const actual = server.address();
  const url = `http://${host}:${actual.port}`;
  if (onReady) onReady({ url, port: actual.port });
  return { server, url, port: actual.port };
}

module.exports = { startServer, buildState, PUBLIC_DIR };
