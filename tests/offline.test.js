'use strict';
/**
 * 离线测试：不联网、不花一分钱，用假模型把主循环、工具、安全策略全跑一遍。
 * 运行：node tests/offline.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Safety, POLICY, classifyCommand, resolveInRoot, isReadOnlyCommand } = require('../src/safety');
const { defaultRegistry } = require('../src/tools');
const { createConversation, runTask } = require('../src/loop');
const { manage, estimateTokens } = require('../src/context');
const { createSession, readSession, listSessions } = require('../src/session');

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  ✗ ${name}\n      ${err.message.split('\n')[0]}`);
  }
}

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'minicodex-'));
}

function baseCfg(over = {}) {
  return {
    baseUrl: 'http://fake',
    apiKey: 'fake',
    model: 'fake-model',
    temperature: 0,
    maxTurns: 8,
    budgetTokens: 24000,
    keepRecent: 8,
    toolTimeoutMs: 5000,
    policy: POLICY.AUTO,
    ...over,
  };
}

function scriptedModel(script) {
  let i = 0;
  const seen = [];
  const fn = async ({ messages }) => {
    seen.push(messages.length);
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    return {
      ok: true,
      text: step.text || '',
      toolCalls: step.toolCalls || [],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
  };
  fn.calls = () => i;
  fn.seen = seen;
  return fn;
}

async function main() {
  console.log('\n【一】主循环：假模型驱动工具，跑通读改写』');
  await test('主循环能按脚本完成 3 次工具调用并正常结束', async () => {
    const root = makeRoot();
    const script = [
      { toolCalls: [{ id: 'c1', name: 'list_dir', args: { path: '.' } }] },
      { toolCalls: [{ id: 'c2', name: 'write_file', args: { path: 'hello.txt', content: '你好\nworld\n' } }] },
      { toolCalls: [{ id: 'c3', name: 'read_file', args: { path: 'hello.txt' } }] },
      { toolCalls: [{ id: 'c4', name: 'read_file', args: { path: 'nope.txt' } }] },
      { text: '完成了' },
    ];
    const callModel = scriptedModel(script);
    const safety = new Safety({ root, policy: POLICY.AUTO });
    const session = createSession({ root, meta: { test: true } });
    const conversation = createConversation({ cfg: baseCfg(), registry: defaultRegistry(), root });

    const result = await runTask({
      input: '创建 hello.txt',
      conversation,
      cfg: baseCfg(),
      registry: defaultRegistry(),
      safety,
      session,
      io: {},
      callModel,
    });

    assert.strictEqual(result.stopReason, 'model_done', `停止原因应为 model_done，实际 ${result.stopReason}`);
    assert.strictEqual(result.text, '完成了');
    assert.strictEqual(result.stats.toolCalls, 4);
    assert.strictEqual(fs.readFileSync(path.join(root, 'hello.txt'), 'utf8'), '你好\nworld\n');

    // 工具失败的结果必须以文本形式回填给模型，而不是抛异常中断
    const toolMsgs = conversation.messages.filter((m) => m.role === 'tool');
    assert.strictEqual(toolMsgs.length, 4);
    assert.ok(/文件不存在/.test(toolMsgs[3].content), '找不到文件时应回填"文件不存在"');

    // 会话日志要落盘，且含 run_end
    const events = readSession(session.file, 100);
    assert.ok(events.some((e) => e.type === 'run_end'), '日志里应有 run_end');
    assert.ok(events.some((e) => e.type === 'tool_result' && e.tool === 'write_file'));
  });

  await test('模型接口报错时优雅停止，不崩溃', async () => {
    const root = makeRoot();
    const callModel = async () => ({ ok: false, error: '401 未授权' });
    const result = await runTask({
      input: '随便做点什么',
      conversation: createConversation({ cfg: baseCfg(), registry: defaultRegistry(), root }),
      cfg: baseCfg(),
      registry: defaultRegistry(),
      safety: new Safety({ root, policy: POLICY.AUTO }),
      callModel,
    });
    assert.strictEqual(result.stopReason, 'model_error');
    assert.ok(/401/.test(result.text));
  });

  await test('达到轮数上限会停下，不会无限转', async () => {
    const root = makeRoot();
    const callModel = async () => ({
      ok: true,
      text: '',
      toolCalls: [{ id: 'x', name: 'list_dir', args: { path: '.' } }],
      usage: null,
    });
    const result = await runTask({
      input: '永远转圈',
      conversation: createConversation({ cfg: baseCfg(), registry: defaultRegistry(), root }),
      cfg: baseCfg({ maxTurns: 3 }),
      registry: defaultRegistry(),
      safety: new Safety({ root, policy: POLICY.AUTO }),
      callModel,
    });
    assert.strictEqual(result.stopReason, 'max_turns');
    assert.strictEqual(result.stats.turns, 3);
  });

  await test('ask 档位下用户拒绝，写操作不会发生', async () => {
    const root = makeRoot();
    const callModel = scriptedModel([
      { toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'secret.txt', content: 'x' } }] },
      { text: '好，我不写了' },
    ]);
    const safety = new Safety({ root, policy: POLICY.ASK, approve: async () => false });
    const conversation = createConversation({ cfg: baseCfg({ policy: POLICY.ASK }), registry: defaultRegistry(), root });
    const result = await runTask({
      input: '写个文件',
      conversation,
      cfg: baseCfg({ policy: POLICY.ASK }),
      registry: defaultRegistry(),
      safety,
      callModel,
    });
    assert.ok(!fs.existsSync(path.join(root, 'secret.txt')), '拒绝后不应创建文件');
    const toolMsg = conversation.messages.find((m) => m.role === 'tool');
    assert.ok(/没有批准/.test(toolMsg.content));
    assert.ok(result.audit.some((a) => a.approved === false), '审计里应记录这次拒绝');
  });

  console.log('\n【二】安全层：越界、危险命令、权限档位】');
  await test('路径越界被拒绝（../ 与绝对路径都挡住）', async () => {
    const root = makeRoot();
    assert.throws(() => resolveInRoot(root, '../etc/passwd'), /越界/);
    assert.throws(() => resolveInRoot(root, '/etc/passwd'), /越界/);
    assert.strictEqual(resolveInRoot(root, './a/b.txt'), path.join(root, 'a/b.txt'));
  });

  await test('文件工具拒绝写项目外的路径', async () => {
    const root = makeRoot();
    const safety = new Safety({ root, policy: POLICY.AUTO });
    const ctx = { root, safety, toolTimeoutMs: 3000, todo: [] };
    const tool = defaultRegistry().get('write_file');
    const r = await tool.run({ path: '../evil.txt', content: 'x' }, ctx);
    assert.strictEqual(r.ok, false);
    assert.ok(/越界/.test(r.output));
    assert.ok(!fs.existsSync(path.join(root, '..', 'evil.txt')));
  });

  await test('命令分级正确', async () => {
    assert.strictEqual(classifyCommand('rm -rf /').level, 'blocked');
    assert.strictEqual(classifyCommand('sudo rm x').level, 'blocked');
    assert.strictEqual(classifyCommand('git push origin main --force').level, 'blocked');
    assert.strictEqual(classifyCommand('npm install lodash').level, 'risky');
    assert.strictEqual(classifyCommand('mv a b').level, 'risky');
    assert.strictEqual(classifyCommand('ls -la').level, 'safe');
    assert.strictEqual(classifyCommand('git status').level, 'safe');
    // 读项目外的文件、带管道重定向的拼接写法，都不算安全
    assert.strictEqual(classifyCommand('cat /etc/passwd').level, 'risky');
    assert.strictEqual(classifyCommand('cat ~/.ssh/id_rsa').level, 'risky');
    assert.strictEqual(classifyCommand('echo hi > out.txt').level, 'risky');
    assert.strictEqual(classifyCommand('ls\nrm -rf build').level, 'blocked');
  });

  await test('只读模式：查看类命令放行，动手类拦住', async () => {
    assert.strictEqual(isReadOnlyCommand('ls -la'), true);
    assert.strictEqual(isReadOnlyCommand('git status'), true);
    assert.strictEqual(isReadOnlyCommand('ls | rm -rf x'), false);
    // 注入类写法与项目外路径都不再算只读
    assert.strictEqual(isReadOnlyCommand('ls\nrm -rf x'), false);
    assert.strictEqual(isReadOnlyCommand('ls $(touch /tmp/pwn)'), false);
    assert.strictEqual(isReadOnlyCommand('ls `whoami`'), false);
    assert.strictEqual(isReadOnlyCommand('cat /etc/passwd'), false);
    assert.strictEqual(isReadOnlyCommand('cat ~/.ssh/id_rsa'), false);
    assert.strictEqual(isReadOnlyCommand('cat ../secret.txt'), false);
    assert.strictEqual(isReadOnlyCommand('git branch -D main'), false);

    const root = makeRoot();
    const safety = new Safety({ root, policy: POLICY.READONLY });
    assert.strictEqual(safety.evaluate({ kind: 'exec', detail: 'git status' }).allow, true);
    assert.strictEqual(safety.evaluate({ kind: 'exec', detail: 'npm test' }).allow, false);
    assert.strictEqual(safety.evaluate({ kind: 'write', detail: 'a.txt' }).allow, false);
  });

  await test('ask 档位：危险命令必须问人，被拒就不执行', async () => {
    const root = makeRoot();
    let asked = 0;
    const safety = new Safety({ root, policy: POLICY.ASK, approve: async () => { asked += 1; return false; } });
    // rm -rf 属于直接拦截；删单个文件属于"要问人"这一档
    assert.strictEqual(safety.evaluate({ kind: 'exec', detail: 'rm -rf build' }).blocked, true);
    const v = safety.evaluate({ kind: 'exec', detail: 'rm build/old.txt' });
    assert.strictEqual(v.needAsk, true);
    const allowed = await safety.ask({ kind: 'exec', detail: 'rm build/old.txt' });
    assert.strictEqual(allowed, false);
    assert.strictEqual(asked, 1);
  });

  console.log('\n【三】上下文与工具细节】');
  await test('上下文超预算时会压缩早期工具结果', async () => {
    const big = 'x'.repeat(4000);
    const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: '做点事' }];
    for (let i = 0; i < 12; i += 1) {
      messages.push({ role: 'assistant', content: '', tool_calls: [{ id: `t${i}`, type: 'function', function: { name: 'run_shell', arguments: '{}' } }] });
      messages.push({ role: 'tool', tool_call_id: `t${i}`, content: big });
    }
    const before = estimateTokens(JSON.stringify(messages));
    const out = manage(messages, { budgetTokens: 3000, keepRecent: 4 });
    const after = estimateTokens(JSON.stringify(out.messages));
    assert.ok(out.compressed > 0, '应发生压缩');
    assert.ok(after < before, '整理后应更小');
    assert.strictEqual(out.messages[0].role, 'system', 'system 必须保留');
    const tail = out.messages.slice(-4).map((m) => m.content);
    assert.ok(tail.every((t) => t === big || t === ''), '最近的消息应保留原文');
  });

  await test('最近窗口本身就很大时也能压到预算内，且最后四条保留原文', async () => {
    // 病况：连续读大文件 / 抓网页，超大工具输出全落在"最近"这几条里，
    // 老逻辑只压缩更早的部分，于是一路超标（实测曾涨到 46000 tokens）。
    const big = 'y'.repeat(8000);
    const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: '任务' }];
    for (let i = 0; i < 8; i += 1) {
      messages.push({ role: 'assistant', content: '', tool_calls: [{ id: `k${i}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
      messages.push({ role: 'tool', tool_call_id: `k${i}`, content: big });
    }

    const out = manage(messages, { budgetTokens: 6000, keepRecent: 8 });

    assert.ok(out.compressed > 0, '应发生压缩');
    const after = estimateTokens(JSON.stringify(out.messages));
    assert.ok(after <= 6000, `整理后应降到预算内，实际约 ${after} tokens`);

    const lastFour = out.messages.slice(-4);
    assert.ok(
      lastFour.every((m) => m.role !== 'tool' || m.content === big),
      '最后四条里的工具结果必须保留原文，不能刚拿到就被抹掉'
    );

    // 协议完整性：任何 tool 消息都要有对应的 tool_calls
    const declared = new Set();
    out.messages.forEach((m) => (m.tool_calls || []).forEach((tc) => declared.add(tc.id)));
    out.messages.forEach((m) => {
      if (m.role === 'tool') assert.ok(declared.has(m.tool_call_id), `tool ${m.tool_call_id} 成了孤儿`);
    });
  });

  await test('丢消息时不会留下孤儿 tool 结果（模型协议完整性）', async () => {
    const big = 'y'.repeat(3000);
    const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: '任务' }];
    for (let i = 0; i < 10; i += 1) {
      const ids = [`a${i}`, `b${i}`];
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: ids.map((id) => ({ id, type: 'function', function: { name: 'read_file', arguments: '{}' } })),
      });
      ids.forEach((id) => messages.push({ role: 'tool', tool_call_id: id, content: big }));
    }
    const out = manage(messages, { budgetTokens: 1200, keepRecent: 3 });
    assert.ok(out.dropped > 0, '应发生丢弃');

    const declared = new Set();
    out.messages.forEach((m) => (m.tool_calls || []).forEach((tc) => declared.add(tc.id)));
    out.messages.forEach((m) => {
      if (m.role === 'tool') assert.ok(declared.has(m.tool_call_id), `tool ${m.tool_call_id} 成了孤儿`);
    });
    assert.strictEqual(out.messages[0].role, 'system');
    assert.strictEqual(out.messages[1].role, 'user', '第一条用户任务必须保留');
  });

  await test('压缩后新消息仍能进入上下文（不会卡在过期快照上）', async () => {
    const root = makeRoot();
    const script = [
      { toolCalls: [{ id: 's1', name: 'run_shell', args: { command: 'ls' } }] },
      { toolCalls: [{ id: 's2', name: 'write_file', args: { path: 'late.txt', content: 'ok' } }] },
      { toolCalls: [{ id: 's3', name: 'run_shell', args: { command: 'pwd' } }] },
      { text: '收工' },
    ];
    let lastSeenIds = [];
    let i = 0;
    const callModel = async ({ messages }) => {
      lastSeenIds = messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      return { ok: true, text: step.text || '', toolCalls: step.toolCalls || [], usage: null };
    };
    const result = await runTask({
      input: '干两件事',
      conversation: createConversation({ cfg: baseCfg(), registry: defaultRegistry(), root }),
      // 预算压得很低，强制每轮都触发压缩
      cfg: baseCfg({ budgetTokens: 1, keepRecent: 2 }),
      registry: defaultRegistry(),
      safety: new Safety({ root, policy: POLICY.AUTO }),
      callModel,
    });
    assert.strictEqual(result.stopReason, 'model_done');
    assert.ok(fs.existsSync(path.join(root, 'late.txt')), '压缩后写入的文件应存在');
    assert.deepStrictEqual(lastSeenIds, ['s3'], `最后一轮应看到最新的 tool 结果，实际 ${lastSeenIds}`);
  });

  await test('edit_file 要求原文唯一，replace_all 才批量替换', async () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, 'dup.txt'), 'aaa\nbbb\naaa\n');
    const ctx = { root, safety: new Safety({ root, policy: POLICY.AUTO }), toolTimeoutMs: 3000, todo: [] };
    const tool = defaultRegistry().get('edit_file');

    const ambiguous = await tool.run({ path: 'dup.txt', old_string: 'aaa', new_string: 'ccc' }, ctx);
    assert.strictEqual(ambiguous.ok, false);
    assert.ok(/不唯一/.test(ambiguous.output));

    const all = await tool.run({ path: 'dup.txt', old_string: 'aaa', new_string: 'ccc', replace_all: true }, ctx);
    assert.strictEqual(all.ok, true);
    assert.strictEqual(fs.readFileSync(path.join(root, 'dup.txt'), 'utf8'), 'ccc\nbbb\nccc\n');

    const missing = await tool.run({ path: 'dup.txt', old_string: 'zzz', new_string: 'q' }, ctx);
    assert.strictEqual(missing.ok, false);
  });

  await test('read_file 支持分页并标出剩余行数', async () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, 'big.txt'), Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join('\n'));
    const ctx = { root, safety: new Safety({ root, policy: POLICY.AUTO }), toolTimeoutMs: 3000, todo: [] };
    const r = await defaultRegistry().get('read_file').run({ path: 'big.txt', offset: 10, limit: 5 }, ctx);
    assert.strictEqual(r.ok, true);
    assert.ok(/line10/.test(r.output));
    assert.ok(/还有 36 行未显示/.test(r.output), r.output.slice(-120));
  });

  await test('grep 能定位关键词并给出文件行号', async () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/a.js'), 'const x = 1;\n// TODO 修一下\n');
    const ctx = { root, safety: new Safety({ root, policy: POLICY.AUTO }), toolTimeoutMs: 3000, todo: [] };
    const r = await defaultRegistry().get('grep').run({ pattern: 'TODO' }, ctx);
    assert.strictEqual(r.ok, true);
    assert.ok(/src\/a\.js:2/.test(r.output), r.output);
  });

  await test('run_shell 在项目目录执行并回传退出码', async () => {
    const root = makeRoot();
    const ctx = { root, safety: new Safety({ root, policy: POLICY.AUTO }), toolTimeoutMs: 10000, todo: [] };
    const r = await defaultRegistry().get('run_shell').run({ command: 'pwd' }, ctx);
    assert.strictEqual(r.ok, true);
    assert.ok(r.output.includes('退出码 0'));
    assert.ok(r.output.includes(root), '应在项目根目录执行');
  });

  await test('会话日志可列出与回读', async () => {
    const root = makeRoot();
    const s = createSession({ root, meta: { hello: 1 } });
    s.log({ type: 'user', text: '测试' });
    s.flush();
    const list = listSessions(root);
    assert.ok(list.length >= 1);
    const events = readSession(s.file, 10);
    assert.strictEqual(events[0].type, 'session_start');
    assert.strictEqual(events[1].type, 'user');
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n合计 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项。`);
  if (failed.length) {
    failed.forEach((f) => console.log(`  ✗ ${f.name}: ${f.err}`));
    process.exit(1);
  }
  console.log('全部通过。\n');
}

main().catch((err) => {
  console.error('测试运行器异常：', err);
  process.exit(1);
});
