'use strict';
/**
 * 模型层：把不同厂商的接口统一成一种内部结构。
 * 这里只实现 OpenAI 兼容协议（/chat/completions），
 * DeepSeek、通义、月之暗面、本地 Ollama 等都兼容这一套，换个 baseUrl 就能用。
 *
 * 一次调用的本质：把 messages 发过去，拿回一段文字或若干工具指令。
 * 不抛异常，失败也返回结构化结果，让主循环决定怎么办。
 *
 * 两种模式：
 *   stream=false（默认）—— 等它一次说完，实现简单；
 *   stream=true —— 文字一个字一个字回来，通过 onDelta 回调实时吐出去，界面更跟手。
 */

const DEFAULT_TIMEOUT = 180000;      // 非流式：整次请求的上限
const DEFAULT_IDLE_TIMEOUT = 120000; // 流式：多久没收到任何数据才算卡死
const DEFAULT_HARD_LIMIT = 900000;   // 流式：无论如何不超过这个总时长

/**
 * 计时器：区分"整次请求超时"和"长时间没动静"。
 *
 * 为什么需要两种：流式请求里，模型可能一边推理一边往下吐，
 * 总时长超过 2 分钟是正常的（尤其是推理型模型 + 大上下文）。
 * 用总时长一刀切会把正在正常工作的请求掐掉——这正是之前那次
 * "请求超时（120000ms）"的成因。改成"只要还在吐数据就不算超时"更合理。
 */
function makeTimer({ controller, totalMs = 0, idleMs = 0, hardMs = 0 }) {
  let idleTimer = null;
  let abortedBy = '';

  const clear = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (totalTimer) clearTimeout(totalTimer);
    if (hardTimer) clearTimeout(hardTimer);
  };
  const touch = () => {
    if (!idleMs) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      abortedBy = `空闲超时（${Math.round(idleMs / 1000)}秒没有收到任何数据）`;
      controller.abort();
    }, idleMs);
  };

  const totalTimer = totalMs ? setTimeout(() => {
    abortedBy = `请求超时（${Math.round(totalMs / 1000)}秒）`;
    controller.abort();
  }, totalMs) : null;

  const hardTimer = hardMs ? setTimeout(() => {
    abortedBy = `总时长超过上限（${Math.round(hardMs / 1000)}秒）`;
    controller.abort();
  }, hardMs) : null;

  touch(); // 一开始就进入"等数据"状态
  return { touch, clear, reason: () => abortedBy, startedAt: Date.now() };
}

function normalizeToolCalls(rawCalls) {
  if (!Array.isArray(rawCalls)) return [];
  return rawCalls.map((c, i) => {
    const fn = c.function || {};
    let args = {};
    try {
      args = fn.arguments ? JSON.parse(fn.arguments) : {};
    } catch (err) {
      args = { __parseError: `参数不是合法 JSON：${String(fn.arguments).slice(0, 200)}` };
    }
    return { id: c.id || `call_${i}`, name: fn.name || c.name || 'unknown', args };
  });
}

function buildBody({ model, messages, tools, temperature, stream }) {
  const body = { model, messages, temperature, stream: !!stream };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  return body;
}

/** 把流式回来的碎片按 index 拼成完整的 tool_call。 */
function mergeToolDelta(acc, deltaToolCalls) {
  for (const tc of deltaToolCalls) {
    const idx = typeof tc.index === 'number' ? tc.index : 0;
    const cur = acc.get(idx) || { id: '', name: '', args: '' };
    if (tc.id) cur.id = tc.id;
    if (tc.function && tc.function.name) cur.name += tc.function.name;
    if (tc.function && tc.function.arguments) cur.args += tc.function.arguments;
    acc.set(idx, cur);
  }
}

function accToToolCalls(acc) {
  return [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => {
      let args = {};
      try {
        args = v.args ? JSON.parse(v.args) : {};
      } catch (err) {
        args = { __parseError: `参数不是合法 JSON：${String(v.args).slice(0, 200)}` };
      }
      return { id: v.id || `call_${Math.random().toString(36).slice(2, 8)}`, name: v.name, args };
    });
}

/**
 * 接口形态选择。
 * 大多数服务走 /v1/chat/completions；也有模型（例如中转上的 deepseek-flash）
 * 只提供 /v1/responses。auto 模式下先按 chat 发，遇到"只支持 responses"的报错就自动改道，
 * 并把结果记下来，后续同一个模型不再白试一次。
 */
const RESPONSES_ONLY = new Set();
const apiKeyOf = (baseUrl, model) => `${String(baseUrl).replace(/\/+$/, '')}|${model}`;

/**
 * 统一入口：把不同厂商的接口统一成一种内部结构。
 * @param {object} p
 * @param {string} p.baseUrl
 * @param {string} p.apiKey
 * @param {string} p.model
 * @param {Array}  p.messages
 * @param {Array}  p.tools        OpenAI 格式的 tools 数组
 * @param {string} [p.apiMode]    auto（默认）/ chat / responses
 * @param {boolean} [p.stream]    是否流式返回
 * @param {Function} [p.onDelta]  流式回调，参数是本次新增的文字片段
 * @returns {Promise<{ok:boolean, text?:string, toolCalls?:Array, usage?:object, error?:string}>}
 */
async function chat(opts) {
  // 瞬时故障（连不上、连接被重置、5xx、429）自动重试一次再放弃。
  // 实测中转偶尔会抽风几秒，重试一次通常就过去了；
  // 密钥错、模型名错这类问题重试也没用，所以只看 retryable 标记。
  const maxAttempts = Math.max(1, Math.min(3, (opts.retries == null ? 1 : opts.retries) + 1));
  let last = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const r = await chatOnce(opts);
    if (r.ok) return r;
    last = r;
    if (!r.retryable) break;
    if (attempt < maxAttempts) await new Promise((res) => setTimeout(res, 700 * attempt));
  }

  if (last && maxAttempts > 1 && last.retryable) {
    last.error = `${last.error}（已自动重试，仍然失败）`;
  }
  return last || { ok: false, error: '调用模型失败：没有拿到任何结果。' };
}

/** 单次调用：决定走哪个接口形态。 */
async function chatOnce(opts) {
  const key = apiKeyOf(opts.baseUrl, opts.model);
  const mode = opts.apiMode || 'auto';

  if (mode === 'responses' || (mode === 'auto' && RESPONSES_ONLY.has(key))) {
    return chatViaResponses(opts);
  }

  const first = await chatViaCompletions(opts);
  if (first.ok) return first;

  const onlyResponses = /responses-only|\/v1\/responses/.test(String(first.error || ''));
  if (mode === 'auto' && onlyResponses) {
    RESPONSES_ONLY.add(key);
    const second = await chatViaResponses(opts);
    // responses 也不通时，把第一次的说明附在后面，方便判断是哪一边的问题
    if (!second.ok) second.error = `${second.error}（另外，chat/completions 也不可用：${first.error}）`;
    return second;
  }
  return first;
}

/** 走 /v1/chat/completions。 */
async function chatViaCompletions({
  baseUrl, apiKey, model, messages, tools, temperature = 0,
  timeoutMs = DEFAULT_TIMEOUT, idleTimeoutMs = DEFAULT_IDLE_TIMEOUT, hardLimitMs = DEFAULT_HARD_LIMIT,
  stream = false, onDelta,
}) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const body = buildBody({ model, messages, tools, temperature, stream });

  const controller = new AbortController();
  const timer = makeTimer(
    stream
      ? { controller, idleMs: idleTimeoutMs, hardMs: hardLimitMs }
      : { controller, totalMs: timeoutMs }
  );
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return {
        ok: false,
        error: explainApiError(resp.status, errText),
        retryable: resp.status >= 500 || resp.status === 429,
      };
    }

    if (stream) return await readStream(resp, onDelta, timer.touch);
    return await readWhole(resp);
  } catch (err) {
    const reason = err.name === 'AbortError'
      ? `${timer.reason() || '请求被中断'}，地址 ${url} 没在时限内完成`
      : explainNetworkError(err, url);
    return { ok: false, error: `调用模型失败：${reason}`, retryable: true };
  } finally {
    timer.clear();
  }
}

/* ==================== /v1/responses 适配层 ====================
   与 chat/completions 的主要差异：
     1. 系统提示词单独放 instructions，不混在消息数组里
     2. 消息数组叫 input，每条内容是 [{type:'input_text'|'output_text', text}]
     3. 工具定义是扁平的 {type,name,description,parameters}，没有 function 包一层
     4. 工具调用与结果都是独立条目：function_call / function_call_output
     5. 返回的 output 里除了 message，还会带 reasoning 条目（模型的思考过程）
*/

/** 把内部消息数组转成 responses 的入参。 */
function toResponsesInput(messages) {
  const instructions = [];
  const input = [];

  for (const m of messages || []) {
    if (m.role === 'system') {
      instructions.push(String(m.content || ''));
      continue;
    }
    if (m.role === 'user') {
      input.push({ role: 'user', content: [{ type: 'input_text', text: String(m.content || '') }] });
      continue;
    }
    if (m.role === 'assistant') {
      const text = String(m.content || '');
      if (text) input.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
      for (const tc of m.tool_calls || []) {
        const fn = tc.function || {};
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: fn.name,
          arguments: fn.arguments || '{}',
        });
      }
      continue;
    }
    if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id,
        output: String(m.content || ''),
      });
    }
  }
  return { instructions: instructions.join('\n\n'), input };
}

/** tools 从 OpenAI 的嵌套格式拍平成 responses 的扁平格式。 */
function toResponsesTools(tools) {
  return (tools || []).map((t) => {
    const fn = t.function || t;
    return {
      type: 'function',
      name: fn.name,
      description: fn.description,
      parameters: fn.parameters,
    };
  });
}

/** responses 的 usage 字段名不同，这里译回内部统一的叫法。 */
function normalizeResponsesUsage(u) {
  if (!u) return null;
  const reasoning = u.output_tokens_details && u.output_tokens_details.reasoning_tokens;
  return {
    prompt_tokens: u.input_tokens,
    completion_tokens: u.output_tokens,
    ...(reasoning != null ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}),
  };
}

function safeParseArgs(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    return { __parseError: `参数不是合法 JSON：${String(raw).slice(0, 200)}` };
  }
}

/** 从一份完整 response 对象里取文字与工具调用。 */
function parseResponsesOutput(data) {
  const items = (data && data.output) || [];
  const text = items
    .filter((i) => i.type === 'message')
    .map((i) => (i.content || []).map((c) => c.text || '').join(''))
    .join('');
  const toolCalls = items
    .filter((i) => i.type === 'function_call')
    .map((i, idx) => ({
      id: i.call_id || i.id || `call_${idx}`,
      name: i.name,
      args: safeParseArgs(i.arguments),
    }));
  return { text, toolCalls };
}

/** 走 /v1/responses。 */
async function chatViaResponses({
  baseUrl, apiKey, model, messages, tools, temperature = 0,
  timeoutMs = DEFAULT_TIMEOUT, idleTimeoutMs = DEFAULT_IDLE_TIMEOUT, hardLimitMs = DEFAULT_HARD_LIMIT,
  stream = false, onDelta,
}) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/responses`;
  const { instructions, input } = toResponsesInput(messages);
  const body = { model, input, temperature, stream: !!stream };
  if (instructions) body.instructions = instructions;
  if (tools && tools.length) body.tools = toResponsesTools(tools);

  const controller = new AbortController();
  // 流式看"有没有动静"，非流式看"总时长"；理由见 makeTimer 上的注释
  const timer = makeTimer(
    stream
      ? { controller, idleMs: idleTimeoutMs, hardMs: hardLimitMs }
      : { controller, totalMs: timeoutMs }
  );
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return {
        ok: false,
        error: explainApiError(resp.status, errText),
        retryable: resp.status >= 500 || resp.status === 429,
      };
    }

    if (stream) return await readResponsesStream(resp, onDelta, timer.touch);

    const raw = await resp.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      // 有些中转不管要不要流式，一律按 SSE 回
      if (/^\s*data:\s*\{/.test(raw)) return readResponsesStream(new Response(raw), onDelta, timer.touch);
      return { ok: false, error: `responses 接口返回不是合法 JSON：${raw.slice(0, 300)}` };
    }
    if (data.error) {
      return { ok: false, error: explainApiError(400, JSON.stringify({ error: data.error })) };
    }
    const parsed = parseResponsesOutput(data);
    return { ok: true, text: parsed.text, toolCalls: parsed.toolCalls, usage: normalizeResponsesUsage(data.usage), finishReason: data.status || '' };
  } catch (err) {
    const reason = err.name === 'AbortError'
      ? `${timer.reason() || '请求被中断'}，地址 ${url} 没在时限内完成`
      : explainNetworkError(err, url);
    return { ok: false, error: `调用模型失败：${reason}`, retryable: true };
  } finally {
    timer.clear();
  }
}

/** 解析 responses 的 SSE 流。 */
async function readResponsesStream(resp, onDelta, touch) {
  let buffer = '';
  let text = '';
  const items = new Map();   // output_index -> { id, name, args }
  let finalResponse = null;
  let failure = '';

  const handleLine = (line) => {
    const t = String(line).trim();
    if (!t.startsWith('data:')) return;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') return;

    let o;
    try {
      o = JSON.parse(payload);
    } catch (err) {
      return; // 半截数据或心跳
    }
    const type = o.type || '';

    if (type === 'response.output_item.added' && o.item) {
      const it = o.item;
      if (it.type === 'function_call') {
        items.set(o.output_index, { id: it.call_id || it.id || '', name: it.name || '', args: '' });
      }
      return;
    }
    if (type === 'response.output_item.done' && o.item && o.item.type === 'function_call') {
      const it = o.item;
      const cur = items.get(o.output_index) || { id: '', name: '', args: '' };
      cur.id = it.call_id || it.id || cur.id;
      cur.name = it.name || cur.name;
      cur.args = it.arguments || cur.args;
      items.set(o.output_index, cur);
      return;
    }
    if (type === 'response.output_text.delta') {
      const piece = o.delta || '';
      text += piece;
      if (piece && typeof onDelta === 'function') onDelta(piece);
      return;
    }
    if (type === 'response.function_call_arguments.delta') {
      const key = o.output_index != null ? o.output_index : o.item_id;
      const cur = items.get(key) || { id: '', name: '', args: '' };
      cur.args += o.delta || '';
      items.set(key, cur);
      return;
    }
    if (type === 'response.completed' && o.response) {
      finalResponse = o.response;
      if (o.response.usage) finalResponse.__usage = o.response.usage;
      return;
    }
    if (type === 'response.failed' || type === 'response.incomplete') {
      failure = (o.response && o.response.error && (o.response.error.message || o.response.error.code))
        || o.response && o.response.incomplete_details && o.response.incomplete_details.reason
        || JSON.stringify(o).slice(0, 300);
      return;
    }
  };

  if (resp.body && typeof resp.body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of resp.body) {
      if (typeof touch === 'function') touch();
      buffer += Buffer.from(chunk).toString('utf8');
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        handleLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf('\n');
      }
    }
    if (buffer) handleLine(buffer);
  } else {
    String(await resp.text()).split('\n').forEach(handleLine);
  }

  if (failure && !finalResponse) {
    return { ok: false, error: `responses 接口执行失败：${failure}` };
  }

  // 优先用 completed 事件里的完整 output（最权威）；
  // 拿不到就用流式过程中拼起来的碎片。
  if (finalResponse && Array.isArray(finalResponse.output) && finalResponse.output.length) {
    const parsed = parseResponsesOutput(finalResponse);
    return { ok: true, text: parsed.text || text, toolCalls: parsed.toolCalls, usage: normalizeResponsesUsage(finalResponse.usage), finishReason: finalResponse.status || '' };
  }

  const toolCalls = [...items.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v], idx) => ({ id: v.id || `call_${idx}`, name: v.name, args: safeParseArgs(v.args) }))
    .filter((c) => c.name);
  return { ok: true, text, toolCalls, usage: null, finishReason: '' };
}

/**
 * 把上游接口返回的错误文本翻译成人话。
 * 各家的措辞五花八门，这里只抓最要紧的几种：没填密钥、密钥无效、没钱、地址错。
 */
function explainApiError(status, bodyText) {
  let msg = '';
  try {
    const j = JSON.parse(bodyText);
    msg = (j.error && (j.error.message || j.error.code)) || j.message || '';
  } catch (err) {
    msg = String(bodyText || '').slice(0, 200);
  }
  const m = String(msg);

  if (/responses-only|use \/v1\/responses/i.test(m)) {
    return '这个模型只提供 /v1/responses 接口，而本程序走的是 /v1/chat/completions，两者不通用。'
      + '请到「设置」里把模型换成支持对话的，例如 deepseek-v4-flash。';
  }
  if (/missing (relay )?api key|no api key|api key is required/i.test(m)) {
    return '还没有填密钥。请到右上角「设置」里填好密钥并点保存。';
  }
  if (/invalid (relay )?key|invalid.*api.?key|incorrect api key|invalid_api_key/i.test(m)) {
    return '密钥无效：服务端不认这把钥匙。请确认复制时没有漏字符、没有多余空格，或者这个 Key 是否已经失效。';
  }
  if (/quota|balance|insufficient|欠费|余额/i.test(m)) {
    return '账户余额不足或额度已用完，请到服务商后台确认。';
  }
  if (status === 404) {
    return '接口地址不对（404）。请确认它是不是 OpenAI 兼容接口，一般以 /v1 结尾。';
  }
  if (status === 429) {
    return '请求太频繁或超出限额（429），等一会儿再试。';
  }
  if (status >= 500) {
    return `服务端出错（${status}），等一会儿再试。`;
  }
  return m ? `${m}（HTTP ${status}）` : `接口返回 ${status}`;
}

/**
 * 把网络层的英文报错翻译成能照着修的提示。
 * 用户看到 "fetch failed" 是没法自救的，必须说清是哪一层断了。
 */
function explainNetworkError(err, url) {
  const cause = (err && err.cause) || {};
  const code = String(cause.code || cause.errno || '');
  const raw = String((err && err.message) || err);

  if (code === 'ENOTFOUND' || /ENOTFOUND/.test(raw)) {
    return `连不上 ${url}：域名解析失败。多半是接口地址写错了，或这台电脑访问不了这个服务。`;
  }
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(raw)) {
    return `连不上 ${url}：对方拒绝连接。地址或端口不对，也可能是本地服务没启动。`;
  }
  if (/TIMEOUT|ETIMEDOUT/i.test(code) || /timeout/i.test(raw)) {
    return `连接 ${url} 超时：网络不通或太慢，如果该服务需要代理，请先开代理。`;
  }
  if (/CERT|TLS|SSL|SELF_SIGNED/i.test(code + raw)) {
    return `连不上 ${url}：HTTPS 证书校验没过。`;
  }
  if (/fetch failed/i.test(raw)) {
    return `网络层连不上 ${url}。常见原因三个：地址填错、这台电脑访问不了该服务（例如在国内直连 api.openai.com）、需要代理而没开。`;
  }
  return raw;
}

/** 流式与非流式共用的解析器：逐行喂 SSE 文本，最后取结果。 */
function makeSseAccumulator(onDelta) {
  let text = '';
  let usage = null;
  const acc = new Map();

  const handleLine = (line) => {
    const trimmed = String(line).trim();
    if (!trimmed.startsWith('data:')) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return;

    let obj;
    try {
      obj = JSON.parse(payload);
    } catch (err) {
      return; // 半截数据或心跳，跳过
    }
    if (obj.usage) usage = obj.usage;
    const delta = obj.choices && obj.choices[0] && obj.choices[0].delta;
    if (!delta) return;

    if (delta.content) {
      text += delta.content;
      if (typeof onDelta === 'function') onDelta(delta.content);
    }
    if (delta.tool_calls) mergeToolDelta(acc, delta.tool_calls);
  };

  return {
    handleLine,
    handleText(chunk) {
      String(chunk).split('\n').forEach(handleLine);
    },
    result: () => ({ ok: true, text, toolCalls: accToToolCalls(acc), usage, finishReason: '' }),
  };
}

/** 非流式：一次拿到完整 JSON。 */
async function readWhole(resp) {
  const text = await resp.text();

  // 有些中转服务不管客户端要不要流式，一律按 SSE 回。
  // 这里先认一下，免得把正常的流式响应误判成"不是合法 JSON"。
  if (/^\s*data:\s*\{/.test(text)) {
    const parser = makeSseAccumulator();
    parser.handleText(text);
    const parsed = parser.result();
    if (parsed.text || parsed.toolCalls.length) return parsed;
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `模型返回不是合法 JSON：${text.slice(0, 300)}` };
  }

  const choice = (data.choices || [])[0];
  if (!choice) return { ok: false, error: '模型没有返回任何候选结果。' };

  const msg = choice.message || {};
  return {
    ok: true,
    text: msg.content || '',
    toolCalls: normalizeToolCalls(msg.tool_calls),
    usage: data.usage || null,
    finishReason: choice.finish_reason || '',
  };
}

/** 流式：逐行解析 SSE，边收边通过 onDelta 推给上层。每收到数据就 touch 一次计时器。 */
async function readStream(resp, onDelta, touch) {
  const parser = makeSseAccumulator(onDelta);
  let buffer = '';

  if (resp.body && typeof resp.body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of resp.body) {
      if (typeof touch === 'function') touch();
      buffer += Buffer.from(chunk).toString('utf8');
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        parser.handleLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf('\n');
      }
    }
    if (buffer) parser.handleLine(buffer);
  } else {
    // 极端情况下没有可读流，退回整段解析
    parser.handleText(await resp.text());
  }

  return parser.result();
}

module.exports = {
  chat,
  normalizeToolCalls,
  accToToolCalls,
  explainNetworkError,
  explainApiError,
  // 供测试使用
  _internal: { toResponsesInput, toResponsesTools, parseResponsesOutput, normalizeResponsesUsage, RESPONSES_ONLY },
};
