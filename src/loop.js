'use strict';
/**
 * 会话循环层：整个系统的心脏。
 * 一圈做完四件事：整理上下文 → 问模型 → 执行它要求的工具 → 把结果贴回去。
 * 直到模型不再要求工具（说明它认为干完了），或者触发停止条件。
 */

const { manage } = require('./context');
const { buildSystemPrompt } = require('./prompt');
const modelClient = require('./model');

const STOP = {
  MODEL_DONE: 'model_done', // 模型不再调用工具，正常结束
  MAX_TURNS: 'max_turns', // 转数用尽
  MODEL_ERROR: 'model_error', // 模型接口报错
  USER_STOP: 'user_stop', // 用户中途喊停
  TOOL_FAILURE_STORM: 'tool_failure_storm', // 同一工具连续失败过多
};

function previewDiff(oldStr, newStr, maxLines = 12) {
  const a = String(oldStr).split('\n');
  const b = String(newStr).split('\n');
  const out = [];
  a.slice(0, maxLines).forEach((l) => out.push(`- ${l}`));
  if (a.length > maxLines) out.push(`- …（另有 ${a.length - maxLines} 行）`);
  b.slice(0, maxLines).forEach((l) => out.push(`+ ${l}`));
  if (b.length > maxLines) out.push(`+ …（另有 ${b.length - maxLines} 行）`);
  return out.join('\n');
}

function buildApprovalPreview(toolName, args) {
  if (toolName === 'edit_file') return previewDiff(args.old_string, args.new_string);
  if (toolName === 'write_file') return previewDiff('', args.content);
  if (toolName === 'run_shell') return `$ ${args.command}`;
  return JSON.stringify(args).slice(0, 400);
}

function createConversation({ cfg, registry, root }) {
  return {
    messages: [
      {
        role: 'system',
        content: buildSystemPrompt({
          root,
          policy: cfg.policy,
          tools: registry.briefList(),
          // 这两个必须传：漏传的话提示词会永远写"已关闭"，
          // 结果就是用户明明打开了开关，模型却一口回绝，还说"能力是关闭的"。
          allowNetwork: !!cfg.allowNetwork,
          allowDesktop: !!cfg.allowDesktop,
        }),
      },
    ],
  };
}

/** 执行单个工具调用。任何异常都转成模型看得懂的文本结果。 */
async function executeToolCall({ call, registry, safety, ctx, io }) {
  const tool = registry.get(call.name);
  if (!tool) {
    return { ok: false, output: `没有名为 ${call.name} 的工具。可用工具：${registry.tools.map((t) => t.name).join('、')}` };
  }
  if (call.args && call.args.__parseError) {
    return { ok: false, output: `${call.args.__parseError}。请重新调用并给出合法 JSON 参数。` };
  }

  const kind = tool.permission || 'read';
  const detail = kind === 'exec' ? call.args.command : (call.args.path || '');
  const verdict = safety.evaluate({ kind, detail });

  if (verdict.blocked) {
    safety.audit.push({ time: new Date().toISOString(), kind, detail, approved: false, blocked: true });
    return { ok: false, output: `已拒绝：${verdict.reason}` };
  }

  if (verdict.needAsk) {
    if (io && io.onToolApprovalRequest) io.onToolApprovalRequest({ tool: tool.name, args: call.args });
    const allowed = await safety.ask({
      kind,
      detail,
      preview: buildApprovalPreview(tool.name, call.args),
    });
    if (!allowed) {
      return { ok: false, output: `用户没有批准这次 ${tool.name} 操作，请换一种方式，或先向用户说明理由。` };
    }
  }

  if (io && io.onToolStart) io.onToolStart({ id: call.id, tool: tool.name, args: call.args });
  let result;
  try {
    result = await tool.run(call.args || {}, ctx);
  } catch (err) {
    result = { ok: false, output: `工具执行异常：${err.message}` };
  }
  if (!result || typeof result !== 'object') result = { ok: false, output: '工具没有返回结果。' };
  if (io && io.onToolEnd) io.onToolEnd({ id: call.id, tool: tool.name, result });
  return result;
}

/**
 * 跑一次任务。
 * @param {object} p
 * @param {string} p.input           用户这次说的话
 * @param {object} p.conversation    createConversation 的返回值，跨轮复用
 * @param {Function} [p.callModel]   可注入的模型调用（测试用假模型就靠它）
 */
async function runTask({
  input,
  conversation,
  cfg,
  registry,
  safety,
  session,
  io = {},
  callModel = modelClient.chat,
}) {
  // 注意：后面一律直接用 conversation.messages，不要另存局部变量。
  // 上下文一旦压缩，数组会被整体替换，旧的引用会变成过期快照，导致模型再也看不到新结果。
  conversation.messages.push({ role: 'user', content: input });
  if (session) session.log({ type: 'user', text: input });

  const ctx = {
    root: safety.root,
    safety,
    toolTimeoutMs: cfg.toolTimeoutMs,
    todo: [],
    // 打开后，工具执行时会把命令同步到一个可见的终端窗口（只显示，不重复执行）
    mirror: !!cfg.mirrorTerminal,
  };

  const stats = { turns: 0, toolCalls: 0, compressed: 0, dropped: 0, usage: { promptTokens: 0, completionTokens: 0 } };
  let stopReason = STOP.MAX_TURNS;
  let finalText = '';
  const recentFailures = [];

  for (let turn = 1; turn <= cfg.maxTurns; turn += 1) {
    stats.turns = turn;

    const managed = manage(conversation.messages, { budgetTokens: cfg.budgetTokens, keepRecent: cfg.keepRecent });
    if (managed.compressed || managed.dropped) {
      conversation.messages = managed.messages;
      stats.compressed += managed.compressed;
      stats.dropped += managed.dropped;
      if (io.onContext) io.onContext({ compressed: managed.compressed, dropped: managed.dropped, tokens: managed.tokens });
    }
    const working = managed.messages;

    if (io.onTurnStart) io.onTurnStart({ turn, maxTurns: cfg.maxTurns, tokens: managed.tokens });

    const resp = await callModel({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      temperature: cfg.temperature,
      timeoutMs: cfg.requestTimeoutMs || 120000,
      messages: working,
      tools: registry.schemas(),
      stream: !!cfg.stream,
      onDelta: io.onDelta,
      // auto：先按 chat/completions 发，遇到"只支持 responses"的模型自动改道
      apiMode: cfg.apiMode || 'auto',
      // 超时策略：流式看"空闲多久"，非流式看"总时长"
      timeoutMs: cfg.requestTimeoutMs || 180000,
      idleTimeoutMs: cfg.streamIdleTimeoutMs || 120000,
      hardLimitMs: cfg.streamHardLimitMs || 900000,
    });

    if (session) {
      session.log({
        type: 'model_response',
        turn,
        ok: resp.ok,
        error: resp.error || null,
        text: (resp.text || '').slice(0, 2000),
        toolCalls: (resp.toolCalls || []).map((c) => ({ name: c.name, args: c.args })),
        usage: resp.usage || null,
      });
    }

    if (!resp.ok) {
      stopReason = STOP.MODEL_ERROR;
      finalText = `模型调用失败，任务中断：${resp.error}`;
      if (io.onError) io.onError(resp.error);
      break;
    }

    if (resp.usage) {
      stats.usage.promptTokens += resp.usage.prompt_tokens || 0;
      stats.usage.completionTokens += resp.usage.completion_tokens || 0;
    }

    // 把模型的这一轮话记进历史（含它要求的工具调用）。
    const assistantMsg = { role: 'assistant', content: resp.text || '' };
    if (resp.toolCalls && resp.toolCalls.length) {
      assistantMsg.tool_calls = resp.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      }));
    }
    conversation.messages.push(assistantMsg);

    if (resp.text && io.onAssistantText) io.onAssistantText(resp.text);

    if (!resp.toolCalls || !resp.toolCalls.length) {
      stopReason = STOP.MODEL_DONE;
      finalText = resp.text || '';
      break;
    }

    // 一个模型回合里可能要求多个工具，并发做，再按顺序贴回结果。
    const results = await Promise.all(resp.toolCalls.map(async (call) => {
      stats.toolCalls += 1;
      const r = await executeToolCall({ call, registry, safety, ctx, io });
      return { call, r };
    }));

    for (const { call, r } of results) {
      conversation.messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: r.output,
      });
      if (session) {
        session.log({
          type: 'tool_result',
          turn,
          tool: call.name,
          args: call.args,
          ok: r.ok,
          output: String(r.output).slice(0, 2000),
        });
      }
      recentFailures.push(r.ok ? 'ok' : call.name);
      if (recentFailures.length > 6) recentFailures.shift();
    }

    // 同一个工具连续失败太多次，说明卡死了，别让它空转烧钱。
    const lastFive = recentFailures.slice(-5);
    if (lastFive.length === 5 && lastFive.every((x) => x !== 'ok' && x === lastFive[0])) {
      stopReason = STOP.TOOL_FAILURE_STORM;
      finalText = `连续多次 ${lastFive[0]} 都失败，已停下，建议换思路或人工介入。`;
      break;
    }
  }

  if (session) {
    session.log({ type: 'run_end', stopReason, stats, text: finalText.slice(0, 2000) });
    session.flush();
  }

  return { text: finalText, stopReason, stats, todo: ctx.todo, audit: safety.audit };
}

module.exports = { runTask, createConversation, executeToolCall, STOP, previewDiff };
