'use strict';
/**
 * 设置读写：网页上改的配置存回项目目录的 config.json。
 * 只允许写白名单里的字段，避免前端误传把配置搞坏。
 * 文件权限设成 600，因为里面可能存着密钥。
 */

const fs = require('fs');
const path = require('path');

const ALLOWED_KEYS = [
  'baseUrl', 'model', 'fastModel', 'apiKey', 'apiKeyEnv',
  'policy', 'maxTurns', 'budgetTokens', 'keepRecent', 'toolTimeoutMs',
  'allowNetwork', 'allowDesktop', 'mirrorTerminal', 'workdir', 'apiMode',
];

const POLICIES = ['readonly', 'ask', 'auto'];
const API_MODES = ['auto', 'chat', 'responses'];
const NUMERIC_KEYS = ['maxTurns', 'budgetTokens', 'keepRecent', 'toolTimeoutMs'];
const BOOLEAN_KEYS = ['allowNetwork', 'allowDesktop', 'mirrorTerminal'];

function configPath(root) {
  return path.join(root, 'config.json');
}

function readSettings(root) {
  const p = configPath(root);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    throw new Error(`config.json 解析失败：${err.message}，请手工修好再保存设置。`);
  }
}

/** 合并写入。传入 undefined 或空字符串表示"不改这一项"。 */
function writeSettings(root, patch = {}) {
  const current = readSettings(root);
  const next = { ...current };

  for (const [key, raw] of Object.entries(patch)) {
    if (!ALLOWED_KEYS.includes(key)) continue;
    if (raw === undefined || raw === null) continue;

    let value = typeof raw === 'string' ? raw.trim() : raw;
    // 开关类字段允许显式写 false（表示"关掉"），其他字段的空值视为"不改这项"
    if (BOOLEAN_KEYS.includes(key)) {
      next[key] = raw === true || raw === 'true' || raw === 'on' || raw === 1 || raw === '1';
      continue;
    }
    if (value === '') continue; // 空值不动原配置

    if (key === 'policy') {
      if (!POLICIES.includes(value)) throw new Error(`权限档位只能是 ${POLICIES.join(' / ')}`);
    } else if (key === 'apiMode') {
      if (!API_MODES.includes(value)) throw new Error(`接口形态只能是 ${API_MODES.join(' / ')}`);
    } else if (NUMERIC_KEYS.includes(key)) {
      value = Number(value);
      if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} 必须是正数`);
    } else if (typeof value !== 'string') {
      throw new Error(`${key} 必须是字符串`);
    }

    next[key] = value;
  }

  const p = configPath(root);
  fs.writeFileSync(p, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(p, 0o600);
  } catch (err) {
    /* 某些文件系统不支持，忽略 */
  }
  return next;
}

module.exports = { readSettings, writeSettings, configPath, ALLOWED_KEYS, POLICIES };
