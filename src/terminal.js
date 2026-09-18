'use strict';
/**
 * 真实终端会话：一个长期活着的登录 shell。
 *
 * 和 run_shell 的区别：
 *   run_shell    —— 每条命令开一个新进程，跑完就没了，cd/export 不会留下
 *   terminal     —— 同一个 shell 一直活着，cd、export、激活虚拟环境、nvm 切换都保留，
 *                   而且带 -il 启动，会读 ~/.zprofile 与 ~/.zshrc，环境和你自己开的终端一致
 *
 * 关键技巧：命令执行完不能靠"等一会儿看有没有输出"来判断（那样永远不知道结束没有），
 * 而是在命令后面追加一行哨兵打印，读到哨兵才知道这条命令跑完了、退出码是多少。
 *
 * 已知限制：这里没有分配 pty，所以 vim、top 这类全屏交互程序画不出界面；
 * 需要这类操作请用桌面能力里的 applescript，或直接在终端里自己操作。
 */

const { spawn } = require('child_process');

const MARK_CWD = '__MC_CWD__';
const START_TIMEOUT_MS = 8000;

/** 去掉 ANSI 转义、退格、多余空行，让输出能读。 */
function clean(text) {
  return String(text || '')
    .replace(/\x1b\][^\x07]*\x07/g, '')       // OSC 序列（设置标题等）
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')   // CSI 序列（颜色、光标）
    .replace(/\x1b[=>()][A-Za-z0-9]?/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .split('\n')
    // 交互式 shell 会反复把空提示符打出来，占地方又没信息，直接丢掉
    .filter((line) => !/^\s*[%$#❯→]{1,2}\s*$/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 去掉提示符与命令回显：交互式 shell 会把提示符和刚敲的命令也打到输出里。 */
function stripEcho(raw, command) {
  let out = String(raw || '');
  const firstLine = String(command || '').split('\n')[0].trim();
  if (firstLine) {
    const at = out.indexOf(firstLine);
    if (at >= 0 && at < 600) out = out.slice(at + firstLine.length);
  }
  return clean(out);
}

class PersistentShell {
  constructor({ cwd, shell = '/bin/zsh' }) {
    this.cwd = cwd;
    this.shell = shell;
    this.child = null;
    this.pending = null;
    this.orphans = new Set(); // 超时后仍会回来的哨兵，读到就丢掉
    this.seq = 0;
    this.alive = false;
    this.lastError = '';
    this.createdAt = new Date().toISOString();
  }

  start() {
    if (this.child) return;

    // -i 读 ~/.zshrc，-l 读 ~/.zprofile：nvm、alias、自定义 PATH 都和你自己开的终端一致。
    // （实测 macOS 的 script 在这条链路里不可靠，会 EPIPE，所以直接起 shell。）
    const child = spawn(this.shell, ['-il'], {
      cwd: this.cwd,
      env: { ...process.env, TERM: 'dumb', PAGER: 'cat', GIT_PAGER: 'cat' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.alive = true;

    const onData = (buf) => this.onData(buf.toString('utf8'));
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    // 子进程提前退出时，写 stdin 会异步抛 EPIPE；不挂这个监听会直接把进程搞崩
    child.stdin.on('error', () => { /* 已退出，忽略 */ });

    child.on('exit', () => {
      this.alive = false;
      this.child = null;
      if (this.pending) {
        const { resolve, timer, out } = this.pending;
        clearTimeout(timer);
        this.pending = null;
        resolve({ ok: false, code: null, cwd: this.cwd, output: `${clean(out)}\n[终端会话已结束]` });
      }
    });
    child.on('error', (err) => {
      this.alive = false;
      this.lastError = err.message;
    });

    // 尽量把提示符压小声，避免每条命令的回显里混一堆用户名主机名
    try {
      child.stdin.write("PROMPT='' ; RPROMPT='' ; PROMPT2=''\n");
    } catch (err) {
      /* 忽略 */
    }
  }

  onData(chunk) {
    if (!this.pending) {
      // 没有待处理命令时，把零散输出丢掉（比如提示符回显），并清理过期哨兵
      for (const id of this.orphans) {
        const marker = `__MC_END_${id}__`;
        const idx = chunk.indexOf(marker);
        if (idx >= 0) {
          this.orphans.delete(id);
          chunk = chunk.slice(idx + marker.length);
        }
      }
      return;
    }

    this.pending.out += chunk;
    const marker = `__MC_END_${this.pending.id}__`;
    const idx = this.pending.out.indexOf(marker);
    if (idx < 0) return;

    const rest = this.pending.out.slice(idx + marker.length);
    const codeMatch = rest.match(/\s*(-?\d+)/);
    let output = this.pending.out.slice(0, idx);

    // 从输出里摘出当前目录
    let cwd = this.cwd;
    const cwdIdx = output.lastIndexOf(MARK_CWD);
    if (cwdIdx >= 0) {
      const after = output.slice(cwdIdx + MARK_CWD.length).split('\n')[0].trim();
      if (after) cwd = after;
      output = output.slice(0, cwdIdx);
    }
    this.cwd = cwd;

    const { resolve, timer, command: sentCommand } = this.pending;
    clearTimeout(timer);
    this.pending = null;
    resolve({ ok: codeMatch ? Number(codeMatch[1]) === 0 : null, code: codeMatch ? Number(codeMatch[1]) : null, output: stripEcho(output, sentCommand), cwd });
  }

  /**
   * 在这个长期会话里跑一条命令。
   * @returns {Promise<{ok:boolean, code:number|null, output:string, cwd:string, timedOut?:boolean}>}
   */
  run(command, { timeoutMs = 120000 } = {}) {
    this.start();
    if (!this.child) {
      return Promise.resolve({ ok: false, code: null, output: `终端会话启动失败：${this.lastError || '未知原因'}`, cwd: this.cwd });
    }
    if (this.pending) {
      return Promise.resolve({ ok: false, code: null, output: '上一条命令还在执行，等它结束或超时后再发下一条。', cwd: this.cwd });
    }

    const id = `${++this.seq}_${Date.now().toString(36)}`;
    // 先记退出码，再打印当前目录，最后打哨兵——顺序不能变，否则 $? 会被覆盖
    const wrapped = `${command}\n__mc_rc=$?\nprintf "\\n${MARK_CWD}%s\\n" "$PWD"\nprintf "__MC_END_${id}__ %s\\n" "$__mc_rc"\n`;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const partial = this.pending ? this.pending.out : '';
        this.pending = null;
        this.orphans.add(id); // 它迟早会回来，但已经不是我们在等的了
        resolve({
          ok: false,
          code: null,
          timedOut: true,
          cwd: this.cwd,
          output: `${clean(partial)}\n[超时] ${timeoutMs}ms 内没结束，命令可能还在跑（比如进了交互式程序）。可以用 terminal 再发一条命令，或设置 reset 重开会话。`,
        });
      }, Math.min(600000, Math.max(1000, timeoutMs)));

      this.pending = { id, out: '', resolve, timer, command };
      try {
        this.child.stdin.write(wrapped);
      } catch (err) {
        clearTimeout(timer);
        this.pending = null;
        resolve({ ok: false, code: null, output: `写入终端失败：${err.message}`, cwd: this.cwd });
      }
    });
  }

  kill() {
    if (this.child) {
      try {
        this.child.kill('SIGKILL');
      } catch (err) {
        /* 已经退出了 */
      }
    }
    this.child = null;
    this.alive = false;
  }

  status() {
    return {
      alive: !!this.child,
      cwd: this.cwd,
      shell: this.shell,
      startedAt: this.createdAt,
    };
  }
}

/** 每个工作目录共用一个会话，避免开一堆 shell。 */
const sessions = new Map();

/** 启动时预热：确认这个 shell 能起来，免得第一条命令才报错。 */
async function warmUp(shell) {
  const probe = new PersistentShell({ cwd: process.env.HOME || '/', shell });
  probe.start();
  const r = await Promise.race([
    probe.run('echo ready', { timeoutMs: 6000 }),
    new Promise((resolve) => setTimeout(() => resolve(null), START_TIMEOUT_MS)),
  ]);
  probe.kill();
  return !!(r && r.ok);
}

function getSession(root, shell = '/bin/zsh') {
  let s = sessions.get(root);
  if (!s) {
    s = new PersistentShell({ cwd: root, shell });
    sessions.set(root, s);
    s.start();
  }
  return s;
}

function resetSession(root) {
  const s = sessions.get(root);
  if (s) {
    s.kill();
    sessions.delete(root);
  }
}

function allSessions() {
  return [...sessions.entries()].map(([root, s]) => ({ root, ...s.status() }));
}

function killAll() {
  for (const s of sessions.values()) s.kill();
  sessions.clear();
}

module.exports = { PersistentShell, getSession, resetSession, allSessions, killAll, clean, warmUp };
