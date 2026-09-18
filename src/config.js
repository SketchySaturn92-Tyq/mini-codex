'use strict';
/**
 * 配置读取顺序：命令行参数 > 环境变量 > 项目内 config.json > 内置默认值。
 * 密钥只从环境变量或 config.json 读，不写进代码。
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  fastModel: '', // 留空表示不做路由，全部走主力模型
  apiKeyEnv: 'MINI_CODEX_API_KEY',
  temperature: 0,
  maxTurns: 25,
  budgetTokens: 24000,
  keepRecent: 8,
  toolTimeoutMs: 60000,
  // 流式请求：多久没收到数据才算卡死（推理型模型单轮想得久是正常的，不能用总时长一刀切）
  streamIdleTimeoutMs: 120000,
  // 流式请求：无论如何不超过这个总时长，防止真的挂死
  streamHardLimitMs: 900000,
  // 非流式请求：整次调用的上限
  requestTimeoutMs: 180000,
  policy: 'ask',
  // 这两项默认关：它们会让 agent 伸到项目目录外面去
  allowNetwork: false,
  allowDesktop: false,
  // 把执行的命令实时镜像到一个终端窗口（只显示，不重复执行）
  mirrorTerminal: false,
  // auto：先按 chat/completions 发，遇到"只支持 responses"的模型自动改道
  // 也可以强制成 chat 或 responses
  apiMode: 'auto',
};

function readConfigFile(root) {
  const p = path.join(root, 'config.json');
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    throw new Error(`config.json 解析失败：${err.message}`);
  }
}

function resolveConfig({ root, argv = {}, env = process.env }) {
  const fileCfg = readConfigFile(root);
  const cfg = { ...DEFAULTS, ...fileCfg, ...argv };

  // 密钥：优先读 config 指定的环境变量名，再退回通用名字。
  const keyName = cfg.apiKeyEnv || DEFAULTS.apiKeyEnv;
  cfg.apiKey = argv.apiKey || env[keyName] || env.OPENAI_API_KEY || fileCfg.apiKey || '';
  cfg.hasApiKey = Boolean(cfg.apiKey);

  // 命令行开关覆盖权限档位。
  if (argv.yes) cfg.policy = 'auto';
  if (argv.readonly) cfg.policy = 'readonly';
  if (argv.allowNetwork) cfg.allowNetwork = true;
  if (argv.allowDesktop) cfg.allowDesktop = true;
  if (argv.mirror) cfg.mirrorTerminal = true;

  cfg.allowNetwork = !!cfg.allowNetwork;
  cfg.allowDesktop = !!cfg.allowDesktop;
  cfg.mirrorTerminal = !!cfg.mirrorTerminal;

  return cfg;
}

module.exports = { resolveConfig, DEFAULTS };
