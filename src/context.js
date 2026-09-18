'use strict';
/**
 * 上下文层：模型没有记忆，每次都要把材料重新递过去；
 * 但它的"桌子"有限，所以这里负责两件事：
 *   1. 单条工具输出先截断，不要一条就把桌子占满。
 *   2. 总量超预算时，把最老的对话压成一句摘要，保留最近的原文。
 */

const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;

/** 粗略估算 token：中日韩字符约 1 字 1 token，其他字符约 4 字 1 token。 */
function estimateTokens(text) {
  const s = String(text || '');
  let cjk = 0;
  for (const ch of s) if (CJK.test(ch)) cjk += 1;
  const rest = s.length - cjk;
  return Math.ceil(cjk + rest / 4) + 4;
}

function countMessages(messages) {
  let total = 0;
  for (const m of messages) total += estimateTokens(m.content || '') + estimateTokens(JSON.stringify(m.tool_calls || ''));
  return total;
}

/** 长文本掐头去尾，中间留标记，避免把上下文一次性撑爆。 */
function truncateText(text, { maxLines = 400, maxChars = 12000 } = {}) {
  const s = String(text == null ? '' : text);
  const lines = s.split('\n');
  let out = s;
  let note = '';

  if (lines.length > maxLines) {
    const head = lines.slice(0, Math.ceil(maxLines * 0.6));
    const tail = lines.slice(-Math.ceil(maxLines * 0.3));
    out = [...head, `…（省略 ${lines.length - head.length - tail.length} 行）…`, ...tail].join('\n');
    note = `已按行数截断，原输出共 ${lines.length} 行，可用更精确的查询重新获取。`;
  }
  if (out.length > maxChars) {
    out = `${out.slice(0, maxChars)}\n…（省略 ${out.length - maxChars} 字符）…`;
    note = `已按长度截断，可用更精确的查询重新获取。`;
  }
  return note ? `${out}\n[${note}]` : out;
}

/**
 * 主整理函数：就地整理消息数组的副本。
 * 策略：system 永远保留；最近 keepRecent 条保留原文；更早的 tool 结果压成一行摘要。
 */
function manage(messages, { budgetTokens = 24000, keepRecent = 8 } = {}) {
  const list = messages.map((m) => ({ ...m }));
  let compressed = 0;
  let dropped = 0;

  const before = countMessages(list);
  if (before <= budgetTokens) return { messages: list, compressed, dropped, tokens: before };

  const cutIndex = Math.max(1, list.length - keepRecent);
  for (let i = 1; i < cutIndex; i += 1) {
    const m = list[i];
    if (m.role === 'tool' && !m.__summarized) {
      const raw = String(m.content || '');
      if (raw.length > 240) {
        m.content = `[早期工具结果已压缩] ${raw.slice(0, 200).replace(/\s+/g, ' ')} …（原 ${raw.length} 字符，需要时请重新调用工具获取）`;
        m.__summarized = true;
        compressed += 1;
      }
    } else if (m.role === 'assistant' && m.content && m.content.length > 400) {
      m.content = `${m.content.slice(0, 300)}…（早期回复已压缩）`;
      m.__summarized = true;
      compressed += 1;
    }
  }

  // 还有一招：如果"最近这几条"本身就很大（比如连着读了几个大文件、抓了几个网页），
  // 上面那轮压缩根本没碰到它们，总预算照样超。
  // 这时把最近窗口里较早的部分也压掉，但永远保护最后 4 条，避免刚拿到的东西立刻被抹掉。
  let tokens = countMessages(list);
  if (tokens > budgetTokens) {
    const protectFrom = Math.max(cutIndex, list.length - 4);
    for (let i = 1; i < protectFrom; i += 1) {
      const m = list[i];
      if (m.role === 'tool' && !m.__summarized && String(m.content || '').length > 240) {
        const raw = String(m.content);
        m.content = `[较早的工具结果已压缩] ${raw.slice(0, 200).replace(/\s+/g, ' ')} …（原 ${raw.length} 字符，需要时请重新调用工具获取）`;
        m.__summarized = true;
        compressed += 1;
      }
    }
    tokens = countMessages(list);
  }

  // 压完还超预算，才动刀丢弃。丢弃必须以"整组"为单位：
  // 模型协议要求 tool 消息紧跟在对应的 assistant tool_calls 之后，
  // 单独删掉任何一边都会让接口直接报错。所以一个 assistant 连同它后面所有 tool 结果，要么全留要么全删。
  const canDropFrom = list[1] && list[1].role === 'user' ? 2 : 1; // 第一条用户任务永远保留
  let guard = 0;
  while (tokens > budgetTokens && list.length > keepRecent + 1 && guard < 200) {
    guard += 1;
    const limit = list.length - keepRecent; // 只能动这个位置之前的消息
    let idx = -1;
    for (let i = canDropFrom; i < limit; i += 1) {
      if (list[i].role === 'assistant' || list[i].role === 'user') { idx = i; break; }
    }
    if (idx === -1) break;

    let end = idx + 1;
    while (end < list.length && list[end].role === 'tool') end += 1;
    if (end > limit) break; // 这一组会切到要保留的区域，停手

    list.splice(idx, end - idx);
    dropped += 1;
    tokens = countMessages(list);
  }

  return { messages: list, compressed, dropped, tokens };
}

module.exports = { estimateTokens, countMessages, truncateText, manage };
