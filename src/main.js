'use strict';
/**
 * 命令行入口：负责跟人打交道（读参数、打印、问确认、开服务器），不掺业务逻辑。
 */

const path = require('path');
const readline = require('readline');
const { execFile } = require('child_process');
const { resolveConfig } = require('./config');
const { Safety, POLICY } = require('./safety');
const { defaultRegistry } = require('./tools');
const { createConversation, runTask, STOP } = require('./loop');
const { createSession, listSessions, readSession } = require('./session');
const { resumeSeed, latestSessionFile } = require('./resume');
const { startServer } = require('./server');
const pkg = require('../package.json');

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c('2', s);
const bold = (s) => c('1', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const red = (s) => c('31', s);
const blue = (s) => c('36', s);

const HELP = `
mini-codex —— 一个最小可用的本地编码助手

用法：
  node bin/mini-codex.js --web              打开图形界面（推荐）
  node bin/mini-codex.js                    进入命令行对话模式
  node bin/mini-codex.js -t "帮我修一个 bug"   直接执行一次任务
  node bin/mini-codex.js --dry-run          只检查环境配置，不调用模型

常用参数：
  -t, --task <文字>      要执行的任务
  -C, --cwd <目录>       项目目录，默认当前目录（也是它能改动的范围）
  --web                  启动本地网页界面（默认 http://127.0.0.1:3333）
  --port <数字>          网页界面的端口
  --no-open              启动网页界面时不自动打开浏览器
  --resume [文件|latest]  接上上次的会话继续（默认 latest）
  --stream               命令行也用流式输出，边想边打
  --model <名字>         主力模型名，例如 gpt-4o-mini / deepseek-chat
  --fast-model <名字>    快速模型名，简单问答走它省钱；不填则不路由
  --base-url <地址>      接口地址（OpenAI 兼容）
  -y, --yes              全自动，不再逐条确认
  --readonly             只读模式，只看不改
  --allow-network        允许联网（抓网页、搜索），默认关闭
  --allow-desktop        允许操作桌面（打开、截屏、剪贴板、通知、AppleScript），默认关闭
  --max-turns <数字>     最多来回多少轮，默认 25
  --no-log               不写会话日志
  --list-sessions        列出历史会话日志
  --replay <文件>        回看某次会话记录
  -h, --help             看这份说明
  -v, --version          版本号

模型密钥放在环境变量里，变量名默认 MINI_CODEX_API_KEY；
用网页界面时也可以直接在「设置」里填，会存到项目内的 config.json。
`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-t': case '--task': out.task = next(); break;
      case '-C': case '--cwd': out.cwd = next(); break;
      case '--web': out.web = true; break;
      case '--port': out.port = Number(next()); break;
      case '--no-open': out.noOpen = true; break;
      case '--resume': {
        const maybe = argv[i + 1];
        if (maybe && !maybe.startsWith('-')) { out.resume = next(); } else { out.resume = 'latest'; }
        break;
      }
      case '--stream': out.stream = true; break;
      case '--model': out.model = next(); break;
      case '--fast-model': out.fastModel = next(); break;
      case '--base-url': out.baseUrl = next(); break;
      case '--api-key': out.apiKey = next(); break;
      case '--max-turns': out.maxTurns = Number(next()); break;
      case '-y': case '--yes': out.yes = true; break;
      case '--readonly': out.readonly = true; break;
      case '--allow-network': out.allowNetwork = true; break;
      case '--allow-desktop': out.allowDesktop = true; break;
      case '--no-log': out.noLog = true; break;
      case '--dry-run': out.dryRun = true; break;
      case '--list-sessions': out.listSessions = true; break;
      case '--replay': out.replay = next(); break;
      case '-h': case '--help': out.help = true; break;
      case '-v': case '--version': out.version = true; break;
      default: out._.push(a);
    }
  }
  return out;
}

/** 需要用户点头时，就用这个问一句话。非交互环境下一律不放行。 */
function makeApprover() {
  const interactive = process.stdin.isTTY;
  const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  return {
    rl,
    async ask({ preview }) {
      if (!interactive) {
        console.log(yellow('  非交互环境，自动拒绝。想放行请加 -y 参数。'));
        return false;
      }
      console.log(dim('  将要执行：'));
      console.log(preview.split('\n').map((l) => `    ${l}`).join('\n'));
      const answer = await new Promise((resolve) => rl.question('  允许吗？(y/N) ', resolve));
      return /^y(es)?$/i.test(answer.trim());
    },
  };
}

function buildIO({ stream = false } = {}) {
  return {
    onTurnStart({ turn, maxTurns, tokens }) {
      console.log(dim(`\n[第 ${turn}/${maxTurns} 轮 · 上下文约 ${tokens} tokens]`));
    },
    onDelta(text) {
      if (stream) process.stdout.write(text);
    },
    onAssistantText(text) {
      if (stream) process.stdout.write('\n');
      else console.log(`${blue('助手')} ${text}`);
    },
    onToolStart({ tool, args }) {
      const brief = tool === 'run_shell' ? args.command : (args.path || args.from || '');
      console.log(`  ${dim('▸')} ${tool} ${dim(String(brief).slice(0, 80))}`);
    },
    onToolEnd({ result }) {
      const flag = result.ok ? green('ok') : red('fail');
      const head = String(result.output || '').split('\n')[0].slice(0, 100);
      console.log(`    ${flag} ${dim(head)}`);
    },
    onContext({ compressed, dropped }) {
      console.log(dim(`  （上下文整理：压缩 ${compressed} 条，丢弃 ${dropped} 条）`));
    },
    onError(msg) {
      console.log(red(`  ！${msg}`));
    },
  };
}

function printEnv({ cfg, root, registry }) {
  console.log(bold('\nmini-codex 环境检查'));
  console.log(`  项目目录   ${root}`);
  console.log(`  主力模型   ${cfg.model}`);
  console.log(`  快速模型   ${cfg.fastModel || dim('（未配置，不做路由）')}`);
  console.log(`  接口地址   ${cfg.baseUrl}`);
  console.log(`  密钥       ${cfg.hasApiKey ? green('已配置') : yellow(`未配置（请设置环境变量 ${cfg.apiKeyEnv}，或用网页设置填入）`)}`);
  console.log(`  权限档位   ${cfg.policy}`);
  console.log(`  联网能力   ${cfg.allowNetwork ? green('已开启') : yellow('关闭')}`);
  console.log(`  桌面操作   ${cfg.allowDesktop ? green('已开启') : yellow('关闭')}`);
  console.log(`  最多轮数   ${cfg.maxTurns}`);
  console.log(`  工具       ${registry.tools.map((t) => t.name).join('、')}`);
  console.log('');
}

/** 用系统默认浏览器打开本地页面。 */
function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : (process.platform === 'win32' ? 'start' : 'xdg-open');
  execFile(cmd, [url], () => { /* 打不开就忽略，界面里会打印地址 */ });
}

/** 启动网页界面。 */
async function runWeb({ root, args }) {
  let opened = false;
  const { url } = await startServer({
    root,
    port: args.port || 3333,
    onReady: ({ url: readyUrl }) => {
      if (!args.noOpen && !opened) {
        opened = true;
        openBrowser(readyUrl);
      }
    },
  });

  console.log(bold('\nmini-codex 网页界面已启动'));
  console.log(`  地址   ${blue(url)}`);
  console.log(`  目录   ${root}`);
  console.log(dim('  密钥没填的话，点右上角「设置」填一次就能用。'));
  console.log(dim('  这个服务只监听本机，关闭窗口或按 Ctrl+C 就停止。\n'));

  // 一直挂着，直到用户 Ctrl+C
  return new Promise(() => {});
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (args.help) { console.log(HELP); return 0; }
  if (args.version) { console.log(pkg.version); return 0; }

  const root = path.resolve(args.cwd || process.cwd());

  if (args.listSessions) {
    const list = listSessions(root);
    if (!list.length) { console.log('还没有会话记录。'); return 0; }
    list.forEach((s) => console.log(`${s.file}  (${s.size}B)`));
    return 0;
  }

  if (args.replay) {
    const events = readSession(args.replay, 500);
    events.forEach((e) => {
      if (e.type === 'user') console.log(`${blue('用户')} ${e.text}`);
      else if (e.type === 'tool_result') console.log(`  ${e.ok ? '✓' : '✗'} ${e.tool}：${String(e.output).slice(0, 120)}`);
      else if (e.type === 'model_response' && e.text) console.log(`${blue('模型')} ${String(e.text).slice(0, 200)}`);
      else if (e.type === 'run_end') console.log(dim(`  [结束] ${e.stopReason}`));
    });
    return 0;
  }

  const cfg = resolveConfig({ root, argv: args });
  const registry = defaultRegistry();

  if (args.dryRun) {
    printEnv({ cfg, root, registry });
    return 0;
  }

  if (args.web) return runWeb({ root, args });

  const approver = makeApprover();
  const safety = new Safety({
    root,
    policy: cfg.policy,
    approve: approver.ask,
    allowNetwork: cfg.allowNetwork,
    allowDesktop: cfg.allowDesktop,
  });
  cfg.stream = !!args.stream;

  console.log(bold(`\nmini-codex ${pkg.version}`) + dim(`  ·  ${cfg.model}  ·  ${root}  ·  权限 ${cfg.policy}`));
  if (!cfg.hasApiKey) {
    console.log(yellow(`提示：还没有配置密钥。请先执行 export ${cfg.apiKeyEnv}="你的密钥"，或用 --web 在网页里填。`));
  }

  const session = args.noLog ? null : createSession({ root, meta: { model: cfg.model, policy: cfg.policy, cwd: root } });
  const io = buildIO({ stream: cfg.stream });
  const conversation = createConversation({ cfg, registry, root });

  // 接上上次：把上一份日志压成前情提要塞进对话开头
  if (args.resume) {
    const file = args.resume === 'latest' ? latestSessionFile(root) : path.resolve(args.resume);
    if (!file) {
      console.log(yellow('没有找到历史会话，按全新任务开始。'));
    } else {
      try {
        const seed = resumeSeed(file);
        conversation.messages.push(seed);
        console.log(dim(`已接上上次会话：${path.basename(file)}`));
      } catch (err) {
        console.log(yellow(`读取上次会话失败（${err.message}），按全新任务开始。`));
      }
    }
  }

  const runOnce = async (input) => {
    const result = await runTask({ input, conversation, cfg, registry, safety, session, io });
    if (result.text && !cfg.stream) console.log(`\n${bold('结论')} ${result.text}`);
    if (result.stopReason !== STOP.MODEL_DONE) {
      console.log(dim(`  [停止原因] ${result.stopReason}`));
    }
    const u = result.stats.usage;
    console.log(dim(`  [本次：${result.stats.turns} 轮，${result.stats.toolCalls} 次工具调用，tokens ${u.promptTokens}+${u.completionTokens}]`));
    return result;
  };

  if (args.task) {
    const result = await runOnce(args.task);
    if (approver.rl) approver.rl.close();
    return result.stopReason === STOP.MODEL_ERROR ? 1 : 0;
  }

  if (!process.stdin.isTTY) {
    console.log(yellow('当前不是交互终端。请用 -t "任务内容" 或 --web 的方式执行。'));
    if (approver.rl) approver.rl.close();
    return 1;
  }

  console.log(dim('直接说要做什么，回车执行。输入 exit 退出，输入 /reset 清空上下文。\n'));
  const rl = approver.rl;
  const ask = () => new Promise((resolve) => rl.question(bold('› '), resolve));

  for (;;) {
    const line = (await ask()).trim(); // eslint-disable-line no-await-in-loop
    if (!line) continue;
    if (line === 'exit' || line === 'quit') break;
    if (line === '/reset') {
      const fresh = createConversation({ cfg, registry, root });
      conversation.messages.length = 0;
      conversation.messages.push(...fresh.messages);
      console.log(dim('上下文已清空。'));
      continue;
    }
    try {
      await runOnce(line); // eslint-disable-line no-await-in-loop
    } catch (err) {
      console.log(red(`执行出错：${err.message}`));
    }
    console.log('');
  }

  rl.close();
  return 0;
}

module.exports = { main, parseArgs };

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => {
    console.error(red(`启动失败：${err.message}`));
    process.exit(1);
  });
}
