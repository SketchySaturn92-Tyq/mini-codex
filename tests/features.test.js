'use strict';
/**
 * 第二批测试：模型路由、会话续跑、设置读写、新工具、Web 接口。
 * 同样不联网、不花钱。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { chooseModel } = require('../src/router');
const { buildDigest, resumeSeed, latestSessionFile } = require('../src/resume');
const { readSettings, writeSettings } = require('../src/settings');
const { defaultRegistry } = require('../src/tools');
const { Safety, POLICY, assertPublicUrl } = require('../src/safety');
const { executeToolCall } = require('../src/loop');
const { createSession } = require('../src/session');
const { startServer } = require('../src/server');

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

const makeRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'minicodex-f-'));
const ctxOf = (root, policy = POLICY.AUTO) => ({
  root,
  safety: new Safety({ root, policy }),
  toolTimeoutMs: 10000,
  todo: [],
});

async function main() {
  console.log('\n【四】模型路由：简单问答走小模型，干活走主力模型】');
  await test('没配快速模型时永远用主力模型', async () => {
    const cfg = { model: 'big', fastModel: '' };
    assert.strictEqual(chooseModel({ cfg, input: '你好' }).model, 'big');
  });

  await test('短问答走快速模型，复杂任务走主力模型', async () => {
    const cfg = { model: 'big', fastModel: 'small' };
    assert.strictEqual(chooseModel({ cfg, input: '你好' }).tier, 'fast');
    assert.strictEqual(chooseModel({ cfg, input: '帮我把 src/loop.js 里的压缩逻辑重构一下' }).tier, 'main');
    assert.strictEqual(chooseModel({ cfg, input: 'a'.repeat(200) }).tier, 'main');
  });

  await test('已经动过工具后回到主力模型', async () => {
    const cfg = { model: 'big', fastModel: 'small' };
    const conversation = { messages: [{ role: 'system', content: 's' }, { role: 'tool', content: 'x' }] };
    assert.strictEqual(chooseModel({ cfg, input: '继续', conversation }).tier, 'main');
  });

  console.log('\n【五】会话续跑：把上次日志压成前情提要】');
  await test('能生成摘要并拼成注入消息', async () => {
    const root = makeRoot();
    const s = createSession({ root, meta: { test: 1 } });
    s.log({ type: 'user', text: '把登录按钮改成蓝色' });
    s.log({ type: 'tool_result', tool: 'edit_file', ok: true, output: '已修改 src/login.css\n第二行' });
    s.log({ type: 'model_response', text: '改好了' });
    s.log({ type: 'run_end', stopReason: 'model_done', text: '登录按钮已经是蓝色。' });
    s.flush();

    const digest = buildDigest(s.file);
    assert.ok(/把登录按钮改成蓝色/.test(digest.text));
    assert.ok(/edit_file/.test(digest.text));
    assert.ok(/登录按钮已经是蓝色/.test(digest.text));

    const seed = resumeSeed(s.file);
    assert.strictEqual(seed.role, 'user');
    assert.ok(/上次会话摘要/.test(seed.content));
    assert.strictEqual(latestSessionFile(root), s.file);
  });

  console.log('\n【六】设置读写：白名单、校验、不覆盖空值】');
  await test('只写白名单字段，且空值不覆盖已有配置', async () => {
    const root = makeRoot();
    writeSettings(root, { model: 'gpt-4o-mini', policy: 'ask', 乱写字段: 'x' });
    const after = writeSettings(root, { apiKey: '', model: 'deepseek-chat' });
    assert.strictEqual(after.model, 'deepseek-chat');
    assert.strictEqual(after.policy, 'ask');
    assert.strictEqual(after.乱写字段, undefined);
    assert.strictEqual(readSettings(root).model, 'deepseek-chat');
  });

  await test('非法权限档位会被拒绝', async () => {
    const root = makeRoot();
    assert.throws(() => writeSettings(root, { policy: 'yolo' }), /权限档位/);
  });

  console.log('\n【七】新工具：改名、删除、git 查询】');
  await test('move_file 能改名，且拒绝覆盖已有文件', async () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, 'a.txt'), '1');
    fs.writeFileSync(path.join(root, 'b.txt'), '2');
    const tool = defaultRegistry().get('move_file');
    const okMove = await tool.run({ from: 'a.txt', to: 'c.txt' }, ctxOf(root));
    assert.strictEqual(okMove.ok, true);
    assert.ok(fs.existsSync(path.join(root, 'c.txt')));

    const clash = await tool.run({ from: 'c.txt', to: 'b.txt' }, ctxOf(root));
    assert.strictEqual(clash.ok, false);
    assert.ok(/已存在/.test(clash.output));
  });

  await test('delete_file 拒绝删根目录与非空目录', async () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'sub/x.txt'), 'x');
    fs.writeFileSync(path.join(root, 'one.txt'), 'x');
    const tool = defaultRegistry().get('delete_file');

    assert.strictEqual((await tool.run({ path: '.' }, ctxOf(root))).ok, false);
    const notEmpty = await tool.run({ path: 'sub' }, ctxOf(root));
    assert.strictEqual(notEmpty.ok, false);
    assert.ok(/非空/.test(notEmpty.output));

    const done = await tool.run({ path: 'one.txt' }, ctxOf(root));
    assert.strictEqual(done.ok, true);
    assert.ok(!fs.existsSync(path.join(root, 'one.txt')));
  });

  await test('git_info 在非仓库里如实报错，不假装成功', async () => {
    const root = makeRoot();
    const r = await defaultRegistry().get('git_info').run({ action: 'status' }, ctxOf(root));
    assert.strictEqual(r.ok, false);
    assert.ok(/退出码/.test(r.output));
  });

  await test('run_shell 退出码非零时标记为失败', async () => {
    const root = makeRoot();
    const good = await defaultRegistry().get('run_shell').run({ command: 'true' }, ctxOf(root));
    const bad = await defaultRegistry().get('run_shell').run({ command: 'exit 3' }, ctxOf(root));
    assert.strictEqual(good.ok, true);
    assert.strictEqual(bad.ok, false);
    assert.ok(/退出码 3/.test(bad.output));
  });

  console.log('\n【八】Web 服务：状态、设置、静态文件】');
  await test('本地服务能起来并返回状态与页面', async () => {
    const root = makeRoot();
    const { server, port } = await startServer({ root, port: 0 });
    const base = `http://127.0.0.1:${port}`;
    try {
      const state = await (await fetch(`${base}/api/state`)).json();
      assert.strictEqual(state.ok, true);
      assert.ok(state.tools.includes('run_shell'));
      assert.ok(state.tools.includes('git_info'));
      assert.strictEqual(state.root, root);

      const page = await fetch(`${base}/`);
      assert.strictEqual(page.status, 200);
      assert.ok(/mini-codex/.test(await page.text()), '首页应包含标题');

      const saved = await (await fetch(`${base}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test-model', policy: 'readonly' }),
      })).json();
      assert.strictEqual(saved.ok, true);
      assert.strictEqual(saved.state.model, 'test-model');
      assert.strictEqual(saved.state.policy, 'readonly');

      const bad = await (await fetch(`${base}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy: 'yolo' }),
      })).json();
      assert.strictEqual(bad.ok, false);

      const sessions = await (await fetch(`${base}/api/sessions`)).json();
      assert.strictEqual(sessions.ok, true);
      assert.ok(Array.isArray(sessions.sessions));

      // 会话日志接口不允许读项目外的任意文件
      const escape = await fetch(`${base}/api/session?file=${encodeURIComponent('/etc/passwd')}`);
      assert.strictEqual(escape.status, 404);

      const missing = await fetch(`${base}/api/nope`);
      assert.strictEqual(missing.status, 404);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  console.log('\n【九】联网与桌面：开关默认关，护栏常开】');
  await test('网址体检挡住本机、内网与非 http 协议', async () => {
    assert.strictEqual(assertPublicUrl('https://example.com/a'), 'https://example.com/a');
    assert.throws(() => assertPublicUrl('http://127.0.0.1:8080/x'), /本机或内网/);
    assert.throws(() => assertPublicUrl('http://localhost/x'), /本机或内网/);
    assert.throws(() => assertPublicUrl('http://192.168.1.1/'), /本机或内网/);
    assert.throws(() => assertPublicUrl('http://10.0.0.5/'), /本机或内网/);
    assert.throws(() => assertPublicUrl('http://172.16.3.4/'), /本机或内网/);
    assert.throws(() => assertPublicUrl('file:///etc/passwd'), /http 或 https/);
  });

  await test('两项开关默认关闭，联网与桌面动作直接被拦', async () => {
    const root = makeRoot();
    const safety = new Safety({ root, policy: POLICY.AUTO });
    assert.strictEqual(safety.evaluate({ kind: 'network', detail: 'x' }).blocked, true);
    assert.strictEqual(safety.evaluate({ kind: 'desktop', detail: 'x' }).blocked, true);

    const registry = defaultRegistry();
    const r = await executeToolCall({
      call: { id: 'n1', name: 'fetch_url', args: { url: 'https://example.com' } },
      registry,
      safety,
      ctx: { root, safety, toolTimeoutMs: 5000, todo: [] },
      io: {},
    });
    assert.strictEqual(r.ok, false);
    assert.ok(/联网能力当前是关闭的/.test(r.output), r.output);
  });

  await test('打开开关后：询问档要确认，全自动放行，只读档仍拒', async () => {
    const root = makeRoot();
    const ask = new Safety({ root, policy: POLICY.ASK, allowNetwork: true });
    assert.strictEqual(ask.evaluate({ kind: 'network', detail: 'x' }).needAsk, true);

    const auto = new Safety({ root, policy: POLICY.AUTO, allowNetwork: true, allowDesktop: true });
    assert.strictEqual(auto.evaluate({ kind: 'network', detail: 'x' }).allow, true);
    assert.strictEqual(auto.evaluate({ kind: 'desktop', detail: 'x' }).allow, true);

    const ro = new Safety({ root, policy: POLICY.READONLY, allowDesktop: true });
    assert.strictEqual(ro.evaluate({ kind: 'desktop', detail: 'x' }).allow, false);
  });

  await test('AppleScript 禁止 do shell script，打开操作不许越界', async () => {
    const root = makeRoot();
    const safety = new Safety({ root, policy: POLICY.AUTO, allowDesktop: true });
    const registry = defaultRegistry();
    const ctx = { root, safety, toolTimeoutMs: 5000, todo: [] };

    const bad = await executeToolCall({
      call: { id: 'a1', name: 'applescript', args: { script: 'do shell script "rm -rf /"' } },
      registry, safety, ctx, io: {},
    });
    assert.strictEqual(bad.ok, false);
    assert.ok(/do shell script/.test(bad.output));

    const outside = await executeToolCall({
      call: { id: 'o1', name: 'open_item', args: { target: '../secret.txt' } },
      registry, safety, ctx, io: {},
    });
    assert.strictEqual(outside.ok, false);
    assert.ok(/越界/.test(outside.output));
  });

  await test('工具清单里已包含联网与桌面工具', async () => {
    const names = defaultRegistry().tools.map((t) => t.name);
    ['fetch_url', 'web_search', 'open_item', 'screenshot', 'clipboard', 'notify', 'applescript']
      .forEach((n) => assert.ok(names.includes(n), `缺少工具 ${n}`));
  });

  await test('剪贴板读取可用，非法动作被拒', async () => {
    const root = makeRoot();
    const safety = new Safety({ root, policy: POLICY.AUTO, allowDesktop: true });
    const ctx = { root, safety, toolTimeoutMs: 8000, todo: [] };
    const tool = defaultRegistry().get('clipboard');
    assert.strictEqual((await tool.run({ action: 'read' }, ctx)).ok, true);
    assert.strictEqual((await tool.run({ action: '乱来' }, ctx)).ok, false);
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
