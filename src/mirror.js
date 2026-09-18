'use strict';
/**
 * 镜像窗口：把 agent 正在执行的命令实时显示到你真实看得见的终端窗口里。
 *
 * 设计要点（重要）：镜像窗口只是「看」，不「执行」。
 * 命令仍然只在 agent 的持久会话里跑一次，窗口里跑的是 tail -f 盯着一个日志文件。
 * 如果直接用 AppleScript 往终端里 do script 一条命令，那条命令会被执行第二次，
 * 轻则重复动文件，重则两边打架——所以必须用"看日志"的方式。
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const LOG_DIR = '.mini-codex';
const LOG_NAME = 'mirror.log';
const MAX_BYTES = 256 * 1024;

let openedFor = null; // 已经为哪个日志文件开过窗口，避免每来一条命令就开一个

function mirrorFile(root) {
  return path.join(root, LOG_DIR, LOG_NAME);
}

/** 写一行到镜像日志。任何失败都不允许影响任务本身。 */
function write(root, line) {
  const file = mirrorFile(root);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) {
      fs.writeFileSync(file, `[日志超过 ${Math.round(MAX_BYTES / 1024)}KB，已从头开始]\n`, 'utf8');
    }
    fs.appendFileSync(file, `${line}\n`, 'utf8');
  } catch (err) {
    /* 镜像只是附加功能，写不进去就算了 */
  }
}

/** AppleScript 字符串里的路径要转义，避免空格和引号把命令拆坏。 */
function quoteForShell(p) {
  return `'${String(p).replace(/'/g, `'\\''`)}'`;
}

/** 打开（或复用）一个 Terminal 窗口盯着镜像日志。 */
function openWindow(root) {
  const file = mirrorFile(root);
  if (openedFor === file) return;
  openedFor = file;

  const script = [
    'tell application "Terminal"',
    '  activate',
    `  do script "printf '\\\\n── mini-codex 镜像窗口 ──\\\\n下面是 agent 正在执行的命令，只显示不重复执行。\\\\n\\\\n'; tail -f ${quoteForShell(file)}"`,
    'end tell',
  ].join('\n');

  execFile('/usr/bin/osascript', ['-e', script], () => {
    /* 打不开窗口不影响命令执行 */
  });
}

/** 会话与日志路径都变了的时候，允许重新开窗。 */
function forget() {
  openedFor = null;
}

module.exports = { write, openWindow, forget, mirrorFile };
