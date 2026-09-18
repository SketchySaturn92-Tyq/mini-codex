'use strict';
/**
 * 持久化层：把每次对话和工具调用写进 .mini-codex/sessions/*.jsonl。
 * 出问题时能回放，看它到底读了什么、改了什么、为什么改错。
 */

const fs = require('fs');
const path = require('path');

const LOG_DIR = '.mini-codex/sessions';

function createSession({ root, meta = {} }) {
  const dir = path.join(root, LOG_DIR);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp}.jsonl`);
  const buffer = [];
  let broken = false;

  /** 写日志失败绝不能影响任务本身：目录被删了就地重建，实在写不了就静音停用。 */
  const safeWrite = (text) => {
    if (broken) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file, text, 'utf8');
    } catch (err) {
      broken = true;
      console.warn(`[mini-codex] 会话日志写入失败，已停用日志（不影响任务）：${err.message}`);
    }
  };

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    broken = true;
    console.warn(`[mini-codex] 无法创建日志目录，本次不写日志：${err.message}`);
  }

  buffer.push({ type: 'session_start', time: new Date().toISOString(), ...meta });

  return {
    file,
    get disabled() {
      return broken;
    },
    log(event) {
      if (broken) return;
      buffer.push({ time: new Date().toISOString(), ...event });
      if (buffer.length >= 20) this.flush();
    },
    flush() {
      if (broken || !buffer.length) return;
      const text = `${buffer.map((e) => JSON.stringify(e)).join('\n')}\n`;
      buffer.length = 0;
      safeWrite(text);
    },
  };
}

function listSessions(root, limit = 20) {
  const dir = path.join(root, LOG_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((f) => ({ file: path.join(dir, f), size: fs.statSync(path.join(dir, f)).size }));
}

function readSession(file, limit = 200) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .slice(0, limit)
    .map((line) => {
      try { return JSON.parse(line); } catch (err) { return { type: 'unparsable', raw: line.slice(0, 200) }; }
    });
}

module.exports = { createSession, listSessions, readSession, LOG_DIR };
