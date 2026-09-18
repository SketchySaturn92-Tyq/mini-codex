'use strict';
/**
 * 安全层：把住三道门。
 *   1. 路径门：任何文件操作都必须落在项目根目录内。
 *   2. 命令门：明显危险的 shell 命令直接拦下，可疑的命令要求确认。
 *   3. 权限门：只读 / 动前询问 / 全自动 三档开关。
 */

const path = require('path');

const POLICY = {
  READONLY: 'readonly', // 只看不动
  ASK: 'ask', // 动前询问（默认）
  AUTO: 'auto', // 全自动
};

class PathOutsideError extends Error {
  constructor(input, root) {
    super(`路径越界：${input} 不在项目目录 ${root} 内，已拒绝。`);
    this.name = 'PathOutsideError';
  }
}

/**
 * 联网前的地址体检：只允许公网 http/https，挡住本机与内网。
 * 不加这道门，模型可以借"抓网页"去扫你的路由器、内网服务或本机端口。
 */
function assertPublicUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch (err) {
    throw new Error(`不是合法的网址：${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('只允许 http 或 https 开头的网址。');
  }
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('不允许访问本机或内网地址。');
  }
  if (host.includes(':')) {
    throw new Error('不允许访问本机或内网地址。');
  }
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    const isLoopback = a === 127 || a === 0;
    const isPrivate = a === 10
      || (a === 192 && b === 168)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 169 && b === 254);
    if (isLoopback || isPrivate) throw new Error('不允许访问本机或内网地址。');
  }
  return u.toString();
}

/** 绝对禁止的命令：命中就直接拒绝，连问都不问。 */
const BLOCKED = [
  { re: /\brm\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*r[a-zA-Z]*f\b/, why: '递归强删' },
  { re: /\brm\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*f[a-zA-Z]*r\b/, why: '递归强删' },
  { re: /\bsudo\b/, why: '提权操作' },
  { re: /\bmkfs\b|\bdiskutil\s+(erase|reformat)\b/i, why: '格式化磁盘' },
  { re: /\bdd\s+if=/, why: '裸写磁盘' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, why: '关机重启' },
  { re: /:\(\)\s*\{.*\}\s*;\s*:/, why: 'fork 炸弹' },
  { re: /\bchmod\s+-R\s+777\s+/, why: '全权限递归授权' },
  { re: /\bgit\s+push\b[^|;]*--force|\bgit\s+push\b[^|;]*-f\b/, why: '强推远端' },
  { re: /\bgit\s+reset\s+--hard\b/, why: '硬回退丢改动' },
  { re: /\bgit\s+clean\s+-[a-zA-Z]*f/, why: '清理未跟踪文件' },
  { re: /\bcurl\b[^|;]*\|\s*(ba|z)?sh\b/, why: '下载即执行' },
  { re: />\s*\/dev\/(sd|disk)/, why: '直写设备文件' },
];

/**
 * 只读命令白名单：只有"看一眼"的动作才算安全，其余一律按可疑处理。
 * 这里故意写得保守：拿不准就当可疑，大不了多问你一次。
 */
const READONLY_VERBS = /^\s*(ls|pwd|cat|head|tail|wc|file|stat|du|df|which|type|echo)\b/;
const GIT_READONLY = /^\s*git\s+(status|log|diff|show)\b/;
const DESTRUCTIVE_ARGS = /-(delete|exec|execdir|ok|fprint|fprint0|D|M|d|m)\b/;

function isReadOnlyCommand(command) {
  const cmd = String(command || '');
  if (!cmd.trim()) return false;

  // 换行、反引号、命令替换、变量展开、管道、重定向、串联：全部不算只读。
  // 不拦这些的话，只读档可以被 "ls\nrm -rf x" 这类写法绕过。
  if (/[\n\r`$]|[;&|<>]/.test(cmd)) return false;

  if (!(READONLY_VERBS.test(cmd) || GIT_READONLY.test(cmd))) return false;

  // 参数里出现项目外路径（绝对路径、~、..）也不放行，避免读走项目外的文件。
  const args = cmd.split(/\s+/).slice(1);
  if (args.some((t) => t.startsWith('/') || t.startsWith('~') || t.includes('..'))) return false;

  // find/grep 的破坏性参数，以及 git 的删除/强制类参数。
  const withoutVerbs = cmd.replace(READONLY_VERBS, '').replace(GIT_READONLY, '');
  if (DESTRUCTIVE_ARGS.test(withoutVerbs)) return false;

  return true;
}

/** 判断一条 shell 命令的风险等级：拦截 / 可疑 / 安全。 */
function classifyCommand(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return { level: 'blocked', reason: '空命令' };

  for (const rule of BLOCKED) {
    if (rule.re.test(cmd)) return { level: 'blocked', reason: rule.why };
  }
  // 只有白名单里的纯查看命令才免确认；其余（写文件、装依赖、管道、重定向…）
  // 一律按可疑处理，交给上层决定是问人还是硬拦。
  if (isReadOnlyCommand(cmd)) return { level: 'safe', reason: '' };
  return { level: 'risky', reason: '可能修改文件或环境，需要确认' };
}

/** 把用户给的相对路径解析成绝对路径，并保证不越出项目根。 */
function resolveInRoot(root, input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new PathOutsideError(String(input), root);
  }
  const abs = path.resolve(root, input);
  const rel = path.relative(root, abs);
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  if (!inside) throw new PathOutsideError(input, root);
  return abs;
}

/** 展示用：把绝对路径缩成相对项目根的写法，日志更清爽。 */
function displayPath(root, abs) {
  const rel = path.relative(root, abs);
  return rel === '' ? '.' : rel;
}

class Safety {
  /**
   * @param {object} opts
   * @param {string} opts.root   项目根目录（绝对路径）
   * @param {string} [opts.policy] POLICY 之一，默认 ASK
   * @param {(req:object)=>Promise<boolean>} [opts.approve] 询问用户是否放行
   */
  constructor({ root, policy = POLICY.ASK, approve, allowNetwork = false, allowDesktop = false }) {
    this.root = path.resolve(root);
    this.policy = policy;
    this.approve = approve || (async () => false);
    // 联网和桌面操作属于"会伸到项目外面去"的能力，默认一律关闭，要用户显式打开。
    this.allowNetwork = !!allowNetwork;
    this.allowDesktop = !!allowDesktop;
    this.audit = []; // 审计留痕
  }

  resolve(input) {
    return resolveInRoot(this.root, input);
  }

  /** 检查一个网址能不能访问，不能就抛出人话错误。 */
  assertUrl(raw) {
    return assertPublicUrl(raw);
  }

  /** 写操作（改文件、跑命令、上网、操作桌面）是否需要放行。 */
  evaluate({ kind, detail }) {
    if (kind === 'read') return { allow: true };

    if (kind === 'network') {
      if (!this.allowNetwork) {
        return {
          allow: false,
          blocked: true,
          reason: '联网能力当前是关闭的。需要的话，到「设置」里打开「允许联网」再试。',
        };
      }
      if (this.policy === POLICY.READONLY) {
        return { allow: false, blocked: true, reason: '当前是只读模式，不允许联网。' };
      }
      return this.policy === POLICY.AUTO ? { allow: true } : { allow: false, needAsk: true, reason: '联网' };
    }

    if (kind === 'desktop') {
      if (!this.allowDesktop) {
        return {
          allow: false,
          blocked: true,
          reason: '桌面操作当前是关闭的。需要的话，到「设置」里打开「允许操作桌面」再试。',
        };
      }
      if (this.policy === POLICY.READONLY) {
        return { allow: false, blocked: true, reason: '当前是只读模式，不允许操作桌面。' };
      }
      return this.policy === POLICY.AUTO ? { allow: true } : { allow: false, needAsk: true, reason: '桌面操作' };
    }

    if (kind === 'exec') {
      const { level, reason } = classifyCommand(detail);
      if (level === 'blocked') {
        return { allow: false, blocked: true, reason: `命令被安全策略拦截：${reason}` };
      }
      if (this.policy === POLICY.READONLY) {
        return isReadOnlyCommand(detail)
          ? { allow: true }
          : { allow: false, blocked: true, reason: '当前是只读模式，只允许查看类命令（ls/cat/git status 等）。' };
      }
      if (level === 'risky') {
        return this.policy === POLICY.AUTO
          ? { allow: true }
          : { allow: false, needAsk: true, reason };
      }
      return { allow: true };
    }

    // 写文件
    if (this.policy === POLICY.READONLY) {
      return { allow: false, blocked: true, reason: '当前是只读模式，不允许修改文件。' };
    }
    if (this.policy === POLICY.ASK) return { allow: false, needAsk: true };
    return { allow: true };
  }

  /** 真正去问用户，并记录审计。 */
  async ask({ kind, detail, preview }) {
    const ok = await this.approve({ kind, detail, preview, root: this.root });
    this.audit.push({
      time: new Date().toISOString(),
      kind,
      detail: String(detail).slice(0, 500),
      approved: !!ok,
    });
    return ok;
  }
}

module.exports = {
  POLICY,
  Safety,
  PathOutsideError,
  classifyCommand,
  resolveInRoot,
  displayPath,
  isReadOnlyCommand,
  assertPublicUrl,
};
