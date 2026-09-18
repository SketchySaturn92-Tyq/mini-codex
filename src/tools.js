'use strict';
/**
 * 工具层：模型不能直接碰你的电脑，只能通过这里的工具"说话"，由程序替它执行。
 * 每个工具的形状固定：
 *   { name, description, permission, parameters(JSON Schema), run(args, ctx) -> {ok, output} }
 * 约定：run 永远不抛异常，失败也返回 {ok:false, output:'人话原因'}，让模型看得懂、能自己改。
 */

const fs = require('fs');
const path = require('path');
const { exec, execFile } = require('child_process');
const { truncateText } = require('./context');
const { explainNetworkError } = require('./model');
const { getSession, resetSession } = require('./terminal');
const mirror = require('./mirror');

const IGNORE_DIRS = new Set([
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', 'dist', 'build',
  '.idea', '.vscode', 'coverage', '.cache', '.DS_Store',
]);

const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.txt', '.yml', '.yaml',
  '.py', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.cs', '.php', '.sh', '.zsh',
  '.html', '.css', '.scss', '.sql', '.toml', '.ini', '.cfg', '.env', '.xml', '.csv', '.log',
]);

const ok = (output) => ({ ok: true, output: String(output) });
const fail = (output) => ({ ok: false, output: String(output) });

function looksBinary(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

function walk(dir, root, out = [], depth = 0) {
  if (depth > 8) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return out;
  }
  for (const e of entries) {
    if (IGNORE_DIRS.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, root, out, depth + 1);
    else if (e.isFile()) out.push(abs);
  }
  return out;
}

function rel(ctx, abs) {
  const r = path.relative(ctx.root, abs);
  return r === '' ? '.' : r;
}

/* ------------------------------ read_file ------------------------------ */
const readFileTool = {
  name: 'read_file',
  description: '读取项目内的文本文件，返回带行号的内容。支持 offset/limit 分页，默认读前 200 行。',
  permission: 'read',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对项目根目录的文件路径' },
      offset: { type: 'integer', description: '从第几行开始读（1 开始），默认 1' },
      limit: { type: 'integer', description: '最多读多少行，默认 200，上限 2000' },
    },
    required: ['path'],
  },
  async run(args, ctx) {
    let abs;
    try {
      abs = ctx.safety.resolve(args.path);
    } catch (err) {
      return fail(err.message);
    }
    if (!fs.existsSync(abs)) return fail(`文件不存在：${args.path}`);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) return fail(`${args.path} 是目录，请用 list_dir 查看。`);
    if (stat.size > 2 * 1024 * 1024) return fail(`文件过大（${stat.size} 字节），请用 grep 定位后用 offset/limit 分段读取。`);

    const buf = fs.readFileSync(abs);
    if (looksBinary(buf)) return fail(`${args.path} 看起来是二进制文件，无法按文本读取。`);

    const lines = buf.toString('utf8').split('\n');
    const offset = Math.max(1, Number(args.offset) || 1);
    const limit = Math.min(2000, Math.max(1, Number(args.limit) || 200));
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice.map((l, i) => `${String(offset + i).padStart(5)}| ${l}`).join('\n');
    const tail = offset - 1 + limit < lines.length
      ? `\n[还有 ${lines.length - (offset - 1 + limit)} 行未显示，可加大 limit 或调整 offset]`
      : '';
    return ok(`${args.path}（共 ${lines.length} 行）\n${numbered}${tail}`);
  },
};

/* ------------------------------ write_file ----------------------------- */
const writeFileTool = {
  name: 'write_file',
  description: '创建或整体覆盖一个文本文件。整文件重写只适合新建文件或很短的配置；改已有文件请优先用 edit_file。',
  permission: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对项目根目录的文件路径' },
      content: { type: 'string', description: '完整的新文件内容' },
    },
    required: ['path', 'content'],
  },
  async run(args, ctx) {
    let abs;
    try {
      abs = ctx.safety.resolve(args.path);
    } catch (err) {
      return fail(err.message);
    }
    const content = String(args.content == null ? '' : args.content);
    if (content.length > 1024 * 1024) return fail('内容超过 1MB，请拆分成多次写入。');

    const existed = fs.existsSync(abs);
    const beforeLines = existed ? fs.readFileSync(abs, 'utf8').split('\n').length : 0;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    const afterLines = content.split('\n').length;

    return ok(existed
      ? `已覆盖 ${args.path}：行数 ${beforeLines} → ${afterLines}，${content.length} 字符。`
      : `已创建 ${args.path}：${afterLines} 行，${content.length} 字符。`);
  },
};

/* ------------------------------ edit_file ------------------------------ */
const editFileTool = {
  name: 'edit_file',
  description: '在已有文件里做精确字符串替换，改动最小。old_string 必须与文件中内容完全一致且唯一；确实要多处替换时显式设置 replace_all=true。',
  permission: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对项目根目录的文件路径' },
      old_string: { type: 'string', description: '要被替换掉的原内容，必须完全一致' },
      new_string: { type: 'string', description: '替换后的新内容' },
      replace_all: { type: 'boolean', description: '是否替换全部匹配，默认 false' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async run(args, ctx) {
    let abs;
    try {
      abs = ctx.safety.resolve(args.path);
    } catch (err) {
      return fail(err.message);
    }
    if (!fs.existsSync(abs)) return fail(`文件不存在：${args.path}，如需新建请用 write_file。`);

    const src = fs.readFileSync(abs, 'utf8');
    const oldStr = String(args.old_string);
    const newStr = String(args.new_string == null ? '' : args.new_string);
    if (!oldStr) return fail('old_string 不能为空。');

    const count = src.split(oldStr).length - 1;
    if (count === 0) return fail(`在 ${args.path} 里找不到这段原文，请先 read_file 确认当前内容（可能是空格或缩进不一致）。`);
    if (count > 1 && !args.replace_all) {
      return fail(`这段原文在 ${args.path} 里出现了 ${count} 次，不唯一。请补足上下文让它唯一，或设置 replace_all=true。`);
    }

    const next = args.replace_all ? src.split(oldStr).join(newStr) : src.replace(oldStr, newStr);
    fs.writeFileSync(abs, next, 'utf8');
    return ok(`已修改 ${args.path}：替换 ${args.replace_all ? count : 1} 处。`);
  },
};

/* ------------------------------ list_dir ------------------------------- */
const listDirTool = {
  name: 'list_dir',
  description: '列出目录下的文件和子目录，带大小，自动跳过 .git、node_modules 等。',
  permission: 'read',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对项目根目录的目录路径，默认根目录' },
    },
  },
  async run(args, ctx) {
    let abs;
    try {
      abs = ctx.safety.resolve(args.path || '.');
    } catch (err) {
      return fail(err.message);
    }
    if (!fs.existsSync(abs)) return fail(`目录不存在：${args.path || '.'}`);

    const entries = fs.readdirSync(abs, { withFileTypes: true })
      .filter((e) => !IGNORE_DIRS.has(e.name))
      .map((e) => {
        const st = fs.statSync(path.join(abs, e.name));
        const size = e.isDirectory() ? '<dir>' : `${st.size}B`;
        return `${e.isDirectory() ? '📁' : '📄'} ${e.name}  ${size}`;
      });
    if (!entries.length) return ok(`${args.path || '.'} 是空目录。`);
    const shown = entries.slice(0, 200).join('\n');
    const tail = entries.length > 200 ? `\n[共 ${entries.length} 项，只显示前 200 项]` : '';
    return ok(`${args.path || '.'} 下有 ${entries.length} 项：\n${shown}${tail}`);
  },
};

/* -------------------------------- grep --------------------------------- */
const grepTool = {
  name: 'grep',
  description: '在项目里按正则搜索文本，返回文件路径、行号和匹配行。用来定位符号、报错、配置。',
  permission: 'read',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式，例如 "function main" 或 "TODO|FIXME"' },
      path: { type: 'string', description: '限定搜索的相对目录或文件，默认全项目' },
      glob: { type: 'string', description: '按扩展名过滤，例如 ".js" 或 ".md"' },
      limit: { type: 'integer', description: '最多返回多少条匹配，默认 60' },
    },
    required: ['pattern'],
  },
  async run(args, ctx) {
    let abs;
    try {
      abs = ctx.safety.resolve(args.path || '.');
    } catch (err) {
      return fail(err.message);
    }
    let re;
    try {
      re = new RegExp(args.pattern, 'i');
    } catch (err) {
      return fail(`正则表达式不合法：${err.message}`);
    }

    const limit = Math.min(300, Math.max(1, Number(args.limit) || 60));
    let files = [];
    const st = fs.existsSync(abs) ? fs.statSync(abs) : null;
    if (!st) return fail(`路径不存在：${args.path || '.'}`);
    if (st.isDirectory()) files = walk(abs, ctx.root);
    else files = [abs];

    const hits = [];
    let scanned = 0;
    for (const f of files) {
      const ext = path.extname(f).toLowerCase();
      if (args.glob && ext !== String(args.glob).toLowerCase()) continue;
      if (!args.glob && ext && !TEXT_EXT.has(ext)) continue;
      const size = fs.statSync(f).size;
      if (size > 2 * 1024 * 1024) continue;
      scanned += 1;
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (re.test(lines[i])) {
          hits.push(`${rel(ctx, f)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (hits.length >= limit) break;
        }
      }
      if (hits.length >= limit) break;
    }

    if (!hits.length) return ok(`没有匹配「${args.pattern}」，共扫描 ${scanned} 个文本文件。`);
    return ok(`匹配 ${hits.length} 条：\n${hits.join('\n')}`);
  },
};

/* ------------------------------ run_shell ------------------------------ */
const runShellTool = {
  name: 'run_shell',
  description: '在项目根目录执行一条 shell 命令（跑测试、构建、git 查看等），返回退出码和输出。会超时；危险命令会被拦截。',
  permission: 'exec',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的单条命令' },
      timeout_ms: { type: 'integer', description: '超时毫秒数，默认 60000' },
    },
    required: ['command'],
  },
  async run(args, ctx) {
    const command = String(args.command || '').trim();
    if (!command) return fail('命令为空。');
    const timeout = Math.min(300000, Math.max(1000, Number(args.timeout_ms) || ctx.toolTimeoutMs || 60000));

    return new Promise((resolve) => {
      exec(command, { cwd: ctx.root, timeout, maxBuffer: 8 * 1024 * 1024, shell: '/bin/zsh' }, (err, stdout, stderr) => {
        const parts = [];
        if (stdout) parts.push(`--- stdout ---\n${stdout}`);
        if (stderr) parts.push(`--- stderr ---\n${stderr}`);
        if (!parts.length) parts.push('(命令没有产生任何输出)');

        let head;
        if (err && err.killed) head = `命令超时被终止（${timeout}ms）：${command}`;
        else if (err) head = `退出码 ${err.code == null ? '非零' : err.code}：${command}`;
        else head = `退出码 0：${command}`;

        const body = truncateText(parts.join('\n'), { maxLines: 200, maxChars: 8000 });

        if (ctx.mirror) {
          mirror.openWindow(ctx.root);
          mirror.write(ctx.root, `\n$ ${command}   （一次性进程）`);
          mirror.write(ctx.root, `  → ${head}`);
        }

        // 退出码非零也算"没成功"，这样连续失败能被主循环察觉并停下；
        // 但输出里写清是退出码问题还是超时，模型看得懂就行。
        resolve(err
          ? { ok: false, output: `${head}\n${body}` }
          : ok(`${head}\n${body}`));
      });
    });
  },
};

/* ------------------------------ todo_write ----------------------------- */
const todoTool = {
  name: 'todo_write',
  description: '记录当前任务的待办清单，长任务里用它保持方向，避免跑偏或漏做。',
  permission: 'read',
  parameters: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: '完整清单，每次传全量',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
          },
          required: ['text', 'status'],
        },
      },
    },
    required: ['items'],
  },
  async run(args, ctx) {
    if (!Array.isArray(args.items)) return fail('items 必须是数组。');
    ctx.todo = args.items.slice(0, 50);
    const icon = { pending: '☐', in_progress: '▶', done: '☑' };
    const rendered = ctx.todo
      .map((it) => `${icon[it.status] || '☐'} ${it.text}`)
      .join('\n');
    return ok(`当前清单：\n${rendered}`);
  },
};

/* ------------------------------ move_file ------------------------------ */
const moveFileTool = {
  name: 'move_file',
  description: '移动或重命名文件/目录（同目录内改名也算）。目标已存在时会拒绝，避免误覆盖。',
  permission: 'write',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: '原路径，相对项目根目录' },
      to: { type: 'string', description: '新路径，相对项目根目录' },
    },
    required: ['from', 'to'],
  },
  async run(args, ctx) {
    let from;
    let to;
    try {
      from = ctx.safety.resolve(args.from);
      to = ctx.safety.resolve(args.to);
    } catch (err) {
      return fail(err.message);
    }
    if (!fs.existsSync(from)) return fail(`原路径不存在：${args.from}`);
    if (fs.existsSync(to)) return fail(`目标已存在：${args.to}，请先确认要不要覆盖，或换个名字。`);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    return ok(`已把 ${args.from} 移动到 ${args.to}。`);
  },
};

/* ------------------------------ delete_file ---------------------------- */
const deleteFileTool = {
  name: 'delete_file',
  description: '删除一个文件或空目录。删除前必须已经确认过内容；目录非空会拒绝，避免连带删掉一堆东西。',
  permission: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对项目根目录的路径' },
    },
    required: ['path'],
  },
  async run(args, ctx) {
    let abs;
    try {
      abs = ctx.safety.resolve(args.path);
    } catch (err) {
      return fail(err.message);
    }
    if (!fs.existsSync(abs)) return fail(`路径不存在：${args.path}`);
    if (abs === ctx.root) return fail('不允许删除项目根目录。');

    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      const left = fs.readdirSync(abs).filter((n) => !IGNORE_DIRS.has(n));
      if (left.length) return fail(`目录非空（还有 ${left.length} 项），请先逐个处理，不要整目录删。`);
      fs.rmdirSync(abs);
      return ok(`已删除空目录 ${args.path}。`);
    }
    fs.unlinkSync(abs);
    return ok(`已删除文件 ${args.path}。`);
  },
};

/* ------------------------------- git_info ------------------------------ */
const gitTool = {
  name: 'git_info',
  description: '查看 git 状态、最近提交、某次改动或文件差异。只读，不会改仓库。',
  permission: 'read',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'status=当前改动 / log=最近提交 / diff=未提交的差异 / show=某次提交详情',
        enum: ['status', 'log', 'diff', 'show'],
      },
      target: { type: 'string', description: '可选，某个文件路径或某个提交号，例如 HEAD~1 或 src/a.js' },
      limit: { type: 'integer', description: 'log 时最多几条，默认 10' },
    },
    required: ['action'],
  },
  async run(args, ctx) {
    const action = String(args.action || 'status');
    const target = args.target ? ` ${String(args.target).replace(/[^\w./~^-]/g, '')}` : '';
    const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
    let command;
    if (action === 'status') command = `git status --short --branch${target}`;
    else if (action === 'log') command = `git log --oneline --decorate -n ${limit}${target}`;
    else if (action === 'diff') command = `git diff${target}`;
    else if (action === 'show') command = `git show --stat${target || ' HEAD'}`;
    else return fail(`不支持的 action：${args.action}，只能是 status / log / diff / show。`);

    return runShellTool.run({ command, timeout_ms: 20000 }, ctx);
  },
};

/* =============================== 联网能力 =============================== */
/* 默认关闭，要在设置里打开「允许联网」才可用。地址只允许公网 http/https。 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) mini-codex/0.3';

/** 网页给模型看之前先剥标签：HTML 里九成是噪音，留着既占上下文，又拖慢之后的每一轮。 */
function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article)[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, arr) => l || (arr[i - 1] && arr[i - 1] !== ''))
    .join('\n')
    .trim();
}

const fetchUrlTool = {
  name: 'fetch_url',
  description: '抓取公网网页或接口内容（http/https）。返回状态码、内容类型和正文，正文超过上限会被截断。',
  permission: 'network',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '完整网址，必须以 http:// 或 https:// 开头' },
      method: { type: 'string', enum: ['GET', 'POST'], description: '默认 GET' },
      body: { type: 'string', description: 'POST 时的请求体，一般是 JSON 字符串' },
      content_type: { type: 'string', description: 'POST 时的内容类型，默认 application/json' },
      max_chars: { type: 'integer', description: '最多返回多少字符，默认 8000，上限 40000' },
    },
    required: ['url'],
  },
  async run(args, ctx) {
    let target;
    try {
      target = ctx.safety.assertUrl(args.url);
    } catch (err) {
      return fail(err.message);
    }
    const method = String(args.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
    const maxChars = Math.min(40000, Math.max(500, Number(args.max_chars) || 8000));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const resp = await fetch(target, {
        method,
        headers: {
          'User-Agent': UA,
          Accept: '*/*',
          ...(method === 'POST' ? { 'Content-Type': args.content_type || 'application/json' } : {}),
        },
        body: method === 'POST' ? String(args.body || '') : undefined,
        signal: controller.signal,
      });
      const ctype = resp.headers.get('content-type') || '';
      const raw = await resp.text();
      // 是网页就剥成纯文本再给模型：既省 token，也让后续每一轮更快
      const isHtml = /text\/html|application\/xhtml/i.test(ctype) || /^\s*(<!doctype html|<html)/i.test(raw);
      const cleaned = isHtml ? htmlToText(raw) : raw;
      const head = `${method} ${target} → HTTP ${resp.status}${ctype ? `（${ctype}）` : ''}${isHtml ? '（已剥掉网页标签）' : ''}`;
      const body = truncateText(cleaned, { maxLines: 400, maxChars });
      return resp.ok ? ok(`${head}\n${body}`) : { ok: false, output: `${head}\n${body}` };
    } catch (err) {
      const reason = err.name === 'AbortError' ? '请求超时（30 秒）' : explainNetworkError(err, target);
      return fail(`抓取失败：${reason}`);
    } finally {
      clearTimeout(timer);
    }
  },
};

/** 把 HTML 里的常见转义还原，并去掉标签。 */
function stripHtml(s) {
  return String(s)
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** DuckDuckGo 的结果链接是跳转形式，这里还原成真实地址。 */
function unwrapDdg(href) {
  const m = String(href).match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch (err) {
      return href;
    }
  }
  if (href.startsWith('//')) return `https:${href}`;
  return href;
}

/** DuckDuckGo 的搜索结果解析。 */
function parseDdg(html) {
  const titles = [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)];
  return titles.map((m, i) => ({
    url: unwrapDdg(m[1]),
    title: stripHtml(m[2]),
    snippet: snippets[i] ? stripHtml(snippets[i][1]).slice(0, 220) : '',
  }));
}

/** 必应（中国版/国际版）的搜索结果解析。 */
function parseBing(html) {
  const chunks = html.split(/<li class="b_algo"/).slice(1);
  const out = [];
  for (const c of chunks) {
    const m = c.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!m) continue;
    const p = c.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    out.push({
      url: m[1],
      title: stripHtml(m[2]),
      snippet: p ? stripHtml(p[1]).slice(0, 220) : '',
    });
  }
  return out;
}

/**
 * 搜索入口按顺序试。国内网络通常连不上 DuckDuckGo，
 * 所以后面备了必应中国版；再不行就老实报错，别编结果。
 */
const SEARCH_BACKENDS = [
  { name: 'DuckDuckGo', url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, parse: parseDdg },
  { name: 'Bing 中国版', url: (q) => `https://cn.bing.com/search?q=${encodeURIComponent(q)}`, parse: parseBing },
  { name: 'Bing 国际版', url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`, parse: parseBing },
];

const webSearchTool = {
  name: 'web_search',
  description: '用关键词上网搜索，返回标题、链接和摘要。会依次尝试 DuckDuckGo、Bing 中国版、Bing 国际版，哪个通就用哪个；全都连不上时请改用 fetch_url 直接抓网址。',
  permission: 'network',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      limit: { type: 'integer', description: '最多返回几条，默认 8，上限 20' },
    },
    required: ['query'],
  },
  async run(args, ctx) {
    const q = String(args.query || '').trim();
    if (!q) return fail('搜索关键词为空。');
    const limit = Math.min(20, Math.max(1, Number(args.limit) || 8));

    const failures = [];
    for (const backend of SEARCH_BACKENDS) {
      let target;
      try {
        target = ctx.safety.assertUrl(backend.url(q));
      } catch (err) {
        failures.push(`${backend.name}：${err.message}`);
        continue;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const resp = await fetch(target, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' }, signal: controller.signal });
        if (!resp.ok) {
          failures.push(`${backend.name}：HTTP ${resp.status}`);
          continue;
        }
        const html = await resp.text();
        const items = backend.parse(html).slice(0, limit);
        if (!items.length) {
          failures.push(`${backend.name}：没解析出结果（可能被拦截或页面改版）`);
          continue;
        }
        const lines = items.map((it, i) => `${i + 1}. ${it.title}\n   ${it.url}${it.snippet ? `\n   ${it.snippet}` : ''}`);
        return ok(`「${q}」搜索结果 ${items.length} 条（来自 ${backend.name}）：\n${lines.join('\n')}`);
      } catch (err) {
        const reason = err.name === 'AbortError' ? '请求超时' : explainNetworkError(err, target);
        failures.push(`${backend.name}：${reason}`);
      } finally {
        clearTimeout(timer);
      }
    }

    return fail(`所有搜索入口都没成功：\n- ${failures.join('\n- ')}\n可以改用 fetch_url 直接抓具体网址。`);
  },
};

/* ============================== 桌面操作 =============================== */
/* 同样默认关闭。这些工具会碰到项目目录以外的世界，所以每一步都要用户点头才有动作。 */

function runCmd(command, args, { input, timeoutMs = 20000, cwd } = {}) {
  return new Promise((resolve) => {
    const child = execFile(command, args, { timeout: timeoutMs, cwd, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
    if (input != null) {
      try {
        child.stdin.end(input);
      } catch (err) {
        /* 进程可能已经退出，忽略 */
      }
    }
  });
}

/** AppleScript 字符串字面量的转义。 */
function asString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const openItemTool = {
  name: 'open_item',
  description: '用系统默认程序打开一个文件、文件夹或网址（相当于双击它）。文件必须是项目目录内的。',
  permission: 'desktop',
  parameters: {
    type: 'object',
    properties: {
      target: { type: 'string', description: '项目内的相对路径，或一个 http(s) 网址' },
    },
    required: ['target'],
  },
  async run(args, ctx) {
    const t = String(args.target || '').trim();
    if (!t) return fail('没给要打开的东西。');

    let what = t;
    if (/^https?:\/\//i.test(t)) {
      try {
        what = ctx.safety.assertUrl(t);
      } catch (err) {
        return fail(err.message);
      }
    } else {
      try {
        what = ctx.safety.resolve(t);
      } catch (err) {
        return fail(err.message);
      }
      if (!fs.existsSync(what)) return fail(`路径不存在：${t}`);
    }

    const r = await runCmd('open', [what], { timeoutMs: 15000 });
    return r.err ? fail(`打开失败：${r.stderr || r.err.message}`) : ok(`已用默认程序打开 ${t}`);
  },
};

const screenshotTool = {
  name: 'screenshot',
  description: '给当前屏幕截一张图，保存到项目内的 .mini-codex/screenshots/ 目录，并返回文件路径。首次使用需要在系统设置里给终端开「屏幕录制」权限。',
  permission: 'desktop',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '可选，文件名前缀' },
    },
  },
  async run(args, ctx) {
    const dir = path.join(ctx.root, '.mini-codex', 'screenshots');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const prefix = String(args.name || 'screen').replace(/[^\w.-]/g, '').slice(0, 40) || 'screen';
    const file = path.join(dir, `${prefix}-${stamp}.png`);

    const r = await runCmd('screencapture', ['-x', file], { timeoutMs: 20000 });
    if (r.err || !fs.existsSync(file)) {
      return fail(`截屏失败：${r.stderr || (r.err && r.err.message) || '没有生成文件'}。到「系统设置 → 隐私与安全性 → 屏幕录制」给终端放行后再试。`);
    }
    const size = fs.statSync(file).size;
    return ok(`已截屏：.mini-codex/screenshots/${path.basename(file)}（${Math.round(size / 1024)}KB）`);
  },
};

const clipboardTool = {
  name: 'clipboard',
  description: '读取或写入系统剪贴板，用来和你手上的内容互通。',
  permission: 'desktop',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['read', 'write'], description: 'read 读取，write 写入' },
      text: { type: 'string', description: 'action=write 时要写入的内容' },
    },
    required: ['action'],
  },
  async run(args) {
    const action = String(args.action || 'read');
    if (action === 'read') {
      const r = await runCmd('pbpaste', [], { timeoutMs: 10000 });
      if (r.err) return fail(`读剪贴板失败：${r.err.message}`);
      const text = r.stdout;
      if (!text) return ok('剪贴板是空的。');
      return ok(`剪贴板内容（${text.length} 字符）：\n${truncateText(text, { maxLines: 200, maxChars: 6000 })}`);
    }
    if (action === 'write') {
      const text = String(args.text == null ? '' : args.text);
      const r = await runCmd('pbcopy', [], { input: text, timeoutMs: 10000 });
      return r.err ? fail(`写剪贴板失败：${r.err.message}`) : ok(`已写入剪贴板（${text.length} 字符）。`);
    }
    return fail(`不支持的 action：${action}，只能是 read 或 write。`);
  },
};

const notifyTool = {
  name: 'notify',
  description: '发一条 macOS 系统通知，用来提醒你任务完成或需要你处理。',
  permission: 'desktop',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '通知标题' },
      message: { type: 'string', description: '通知正文' },
    },
    required: ['message'],
  },
  async run(args) {
    const title = String(args.title || 'mini-codex').slice(0, 80);
    const message = String(args.message || '').slice(0, 400);
    if (!message) return fail('通知内容为空。');
    const script = `display notification ${asString(message)} with title ${asString(title)}`;
    const r = await runCmd('osascript', ['-e', script], { timeoutMs: 15000 });
    return r.err ? fail(`发通知失败：${r.stderr || r.err.message}`) : ok(`已发出通知：${title}`);
  },
};

const appleScriptTool = {
  name: 'applescript',
  description: '运行一段 AppleScript，用来切换应用、模拟按键、控制系统窗口等。首次使用需要在系统设置里给终端开「辅助功能」权限。指令里不允许出现 do shell script（要跑命令请用 run_shell）。',
  permission: 'desktop',
  parameters: {
    type: 'object',
    properties: {
      script: { type: 'string', description: '要执行的 AppleScript 源码' },
    },
    required: ['script'],
  },
  async run(args) {
    const script = String(args.script || '');
    if (!script.trim()) return fail('脚本为空。');
    if (/do\s+shell\s+script/i.test(script)) {
      return fail('出于安全考虑，AppleScript 里不允许 do shell script（那等于绕开审批跑命令）。需要跑命令请用 run_shell 工具。');
    }
    const r = await runCmd('osascript', ['-e', script], { timeoutMs: 30000 });
    if (r.err) {
      const detail = (r.stderr || r.err.message || '').trim();
      return fail(`AppleScript 执行失败：${detail}${/辅助功能|not allowed|assistive|-1743/i.test(detail) ? '（到「系统设置 → 隐私与安全性 → 辅助功能」给终端放行）' : ''}`);
    }
    return ok(r.stdout.trim() ? `执行结果：\n${r.stdout.trim()}` : '脚本执行完成，没有输出。');
  },
};

/* ------------------------------ 终端会话 ------------------------------ */
// 和 run_shell 的区别：这个是同一个 shell 一直活着，cd / export / nvm 切换都保留。
const terminalTool = {
  name: 'terminal',
  description:
    '在一个持续存在的真实终端会话里执行命令。cd、export、激活虚拟环境、nvm 切换都会保留下来，'
    + '交互式程序也能跑；和 run_shell 的"每条命令一个全新进程"不同。返回里会带上退出码和当前目录。',
  permission: 'exec',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令，可以带 cd、export 这类会改变会话状态的写法' },
      timeout_ms: { type: 'integer', description: '超时毫秒数，默认 120000，上限 600000' },
      reset: { type: 'boolean', description: '为 true 时重开一个干净会话，之前的目录和变量都丢掉' },
    },
  },
  async run(args, ctx) {
    if (args.reset) {
      resetSession(ctx.root);
      const fresh = getSession(ctx.root);
      return ok(`终端会话已重置，当前目录 ${fresh.status().cwd}`);
    }

    const command = String(args.command || '').trim();
    if (!command) return fail('命令为空。');
    const timeout = Math.min(600000, Math.max(1000, Number(args.timeout_ms) || 120000));

    if (ctx.mirror) {
      mirror.openWindow(ctx.root);
      mirror.write(ctx.root, `\n$ ${command}`);
    }

    const session = getSession(ctx.root);
    const r = await session.run(command, { timeoutMs: timeout });

    if (ctx.mirror) {
      const lines = String(r.output || '')
        .split('\n')
        .filter((l) => l.trim() && !/^[\w.-]+@[\w.-]+.*[%$#]\s*$/.test(l.trim()) && !/^[%$#❯→]{1,2}$/.test(l.trim()));
      const brief = lines.slice(0, 3).join(' / ').slice(0, 200);
      mirror.write(ctx.root, `  → 退出码 ${r.code == null ? '未知' : r.code}${brief ? ` ｜ ${brief}` : ''}`);
    }

    const head = `$ ${command}\n[退出码 ${r.code == null ? '未知' : r.code} ｜ 当前目录 ${r.cwd}]`;
    const body = truncateText(r.output || '(命令没有产生输出)', { maxLines: 200, maxChars: 8000 });
    return { ok: !!r.ok, output: `${head}\n${body}` };
  },
};

/* ------------------------------ 注册表 --------------------------------- */
class ToolRegistry {
  constructor(tools) {
    this.tools = tools;
    this.map = new Map(tools.map((t) => [t.name, t]));
  }

  /** 转成模型能看懂的 JSON Schema 列表。 */
  schemas() {
    return this.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  briefList() {
    return this.tools.map((t) => ({ name: t.name, description: t.description }));
  }

  get(name) {
    return this.map.get(name);
  }
}

function defaultRegistry() {
  return new ToolRegistry([
    readFileTool,
    editFileTool,
    writeFileTool,
    listDirTool,
    grepTool,
    moveFileTool,
    deleteFileTool,
    gitTool,
    runShellTool,
    terminalTool,
    todoTool,
    // 联网（默认关闭，需在设置里打开）
    fetchUrlTool,
    webSearchTool,
    // 桌面操作（默认关闭，需在设置里打开）
    openItemTool,
    screenshotTool,
    clipboardTool,
    notifyTool,
    appleScriptTool,
  ]);
}

module.exports = { defaultRegistry, ToolRegistry, walk, IGNORE_DIRS };
