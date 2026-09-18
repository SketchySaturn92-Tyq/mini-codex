'use strict';
/**
 * 会话续跑：把上次的日志压成一段"前情提要"，塞回新会话开头。
 *
 * 为什么用摘要而不是原样恢复消息？
 * 模型协议要求 tool 消息必须严格对应上一轮的 tool_calls，日志是先落盘的事后记录，
 * 原样拼回去很容易拼出一个接口不接受的序列。摘要做不到逐字还原，但永远不会拼错，
 * 对"接着上次继续"这个需求来说够用，也更好读。
 */

const { readSession, listSessions } = require('./session');
const { truncateText } = require('./context');

function latestSessionFile(root) {
  const list = listSessions(root, 1);
  return list.length ? list[0].file : null;
}

/**
 * @param {string} file 日志文件路径
 * @param {object} [opts]
 * @param {number} [opts.maxChars] 摘要最多多少字符，默认 4000
 * @returns {{text:string, file:string, events:number}}
 */
function buildDigest(file, { maxChars = 4000 } = {}) {
  const events = readSession(file, 1000);
  const lines = [];
  let lastConclusion = '';

  for (const e of events) {
    if (e.type === 'user') {
      lines.push(`【用户要求】${String(e.text || '').slice(0, 300)}`);
    } else if (e.type === 'tool_result') {
      const head = String(e.output || '').split('\n')[0].slice(0, 120);
      lines.push(`【动作】${e.tool} ${e.ok ? '成功' : '失败'}：${head}`);
    } else if (e.type === 'model_response' && e.text) {
      lines.push(`【助手】${String(e.text).slice(0, 200)}`);
    } else if (e.type === 'run_end') {
      lastConclusion = String(e.text || '').slice(0, 400);
      lines.push(`【结束】${e.stopReason}`);
    }
  }

  const body = truncateText(lines.join('\n'), { maxLines: 120, maxChars });
  const tail = lastConclusion ? `\n\n上次给出的结论：${lastConclusion}` : '';
  return {
    text: body + tail,
    file,
    events: events.length,
  };
}

/** 生成要注入对话的那条消息。 */
function resumeSeed(file, opts) {
  const digest = buildDigest(file, opts);
  return {
    role: 'user',
    content: [
      '【上次会话摘要】以下是你在同一个项目里上一次干活的过程记录，请在此基础上继续，不要重复已经做完的事。',
      digest.text,
      '如果上面的信息不够，用工具重新确认现状，不要凭记忆下结论。',
    ].join('\n\n'),
    __resume: digest.file,
  };
}

module.exports = { latestSessionFile, buildDigest, resumeSeed };
