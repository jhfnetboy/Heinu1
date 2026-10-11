import fs from 'fs';
import { login, doQRLogin, clearToken } from './ilink/auth';
import { ILinkClient } from './ilink/client';
import { Monitor } from './ilink/monitor';
import { Sender } from './ilink/sender';
import { SessionStore } from './claude/store';
import { Router } from './router';
import { WorkspaceManager } from './workspace';
import { CONFIG } from './config';
import { AGENT_LABEL } from './agent/runner';

// 全局安全网：任何一个没被 try/catch 接住的 promise 拒绝或异常，默认会让整个
// Node 进程崩溃退出——哪怕只是长轮询之外某个 fetch（比如 KB 抓链接、mp_bridge
// 调用）撞上一次网络抖动（ENETUNREACH 之类）。之前就真的这样崩过一次：机器
// 收到消息、正常处理、只是网络临时不通，结果整个 daemon 直接退出，用户看到
// 的是"消息发了没反应"。
// monitor.ts 自己的长轮询已经有 try/catch + 重连，会一直重试；这里只是兜底
// 接住"漏网"的那些。真正卡死不动的情况仍然交给 config.ts 的
// WATCHDOG_TIMEOUT_MS（180s 无成功轮询）主动退出，让 launchd 重启——那个机制
// 不受影响，这里只是不让"一次性网络错误"直接判死刑。
process.on('uncaughtException', (err) => {
  console.error('[fatal-guard] 未捕获异常，已拦截，进程继续运行:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal-guard] 未处理的 promise 拒绝，已拦截，进程继续运行:', reason);
});

async function main() {
  const args = process.argv.slice(2);
  console.log('🦞 Heinu1 WeChat Bot');
  console.log(`   数据目录: ${CONFIG.DATA_DIR}`);
  console.log(`   执行后端: ${AGENT_LABEL}`);
  console.log(`   模型: ${CONFIG.AGENT_PROVIDER === 'codex' ? CONFIG.CODEX_MODEL || '继承 Codex 本机配置' : CONFIG.CLAUDE_MODEL}`);
  if (CONFIG.AGENT_PROVIDER === 'codex') console.log(`   推理强度: ${CONFIG.CODEX_REASONING_EFFORT}`);
  console.log(`   权限模式: ${CONFIG.AGENT_PROVIDER === 'codex' ? CONFIG.CODEX_SANDBOX_MODE : CONFIG.CLAUDE_PERMISSION_MODE}\n`);

  fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
  fs.mkdirSync(CONFIG.MEDIA_DIR, { recursive: true });
  if (args.includes('--relogin')) clearToken();

  let loginResult: Awaited<ReturnType<typeof login>>;
  try {
    loginResult = await login();
  } catch (err: any) {
    console.error('❌ 登录失败:', err.message);
    process.exit(1);
  }

  console.log(`[main] baseurl: ${loginResult.baseurl}`);

  const client  = new ILinkClient(loginResult.bot_token, loginResult.baseurl);
  const sender  = new Sender(client);
  const store   = new SessionStore();
  const wsm     = new WorkspaceManager();
  const router  = new Router(sender, store, wsm);
  console.log(`[main] 工作区配置: ${CONFIG.WORKSPACES_FILE}`);

  const monitor = new Monitor(client, async (msg) => {
    const preview = msg.item_list?.[0]?.text_item?.text?.slice(0, 40) ?? '(非文字)';
    console.log(`[${ts()}] from=...${msg.from_user_id.slice(-8)} "${preview}"`);
    try {
      await router.handle(msg);
    } catch (err: any) {
      console.error('[main] handle error:', err.message);
    }
  });

  monitor.start();
  console.log('✅ 机器人已启动，在微信里找到 ClawBot 联系人直接发消息\n');

  const shutdown = () => { monitor.stop(); process.exit(0); };
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);
}

function ts() { return new Date().toLocaleTimeString('zh-CN'); }

main();
