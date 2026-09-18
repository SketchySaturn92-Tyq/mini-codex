'use strict';
/**
 * 模型路由：简单任务用便宜的小模型，复杂任务用主力模型。
 * 判断规则故意写得保守——拿不准就用主力模型，宁可多花一点，也别把活干砸。
 */

// 一出现这些词，说明任务涉及真实改动或排查，直接上主力模型
const HARD_HINTS = /(重构|架构|实现|修复|调试|排查|为什么|报错|错误|测试|部署|迁移|优化|设计|分析|整个|全部|所有|每个|多文件|项目)/;

// 带路径、带扩展名、带命令的样子，也按复杂处理
const CODE_SHAPE = /([./~][\w-]+|\w+\.(js|ts|json|md|py|go|rs|java|sh|css|html|ya?ml)\b)/i;

const MAX_SIMPLE_LEN = 40;

/**
 * 选择这次该用哪个模型。
 * @returns {{model:string, tier:'fast'|'main', reason:string}}
 */
function chooseModel({ cfg, input = '', conversation = null }) {
  const main = { model: cfg.model, tier: 'main', reason: '默认使用主力模型' };
  const fast = cfg.fastModel;
  if (!fast) return main;

  // 已经动过工具，说明进入实操阶段，交回主力模型
  if (conversation && Array.isArray(conversation.messages)) {
    const touched = conversation.messages.some((m) => m.role === 'tool');
    if (touched) return main;
  }

  const text = String(input || '').trim();
  if (!text) return main;
  if (text.length > MAX_SIMPLE_LEN) return main;
  if (HARD_HINTS.test(text)) return main;
  if (CODE_SHAPE.test(text)) return main;

  return { model: fast, tier: 'fast', reason: '短问答，用快速模型省钱' };
}

module.exports = { chooseModel, MAX_SIMPLE_LEN };
