import fs from 'fs';
import { login, doQRLogin, clearToken } from './ilink/auth';
import { ILinkClient } from './ilink/client';
import { Monitor } from './ilink/monitor';
import { Sender } from './ilink/sender';
import { SessionStore } from './claude/store';
import { Router } from './router';
import { WorkspaceManager } from './workspace';
import { CONFIG } from './config';

async function main() {
  const args = process.argv.slice(2);
  console.log('🦞 Heinu1 WeChat Bot');
  console.log(`   数据目录: ${CONFIG.DATA_DIR}`);
  console.log(`   权限模式: ${CONFIG.CLAUDE_PERMISSION_MODE}\n`);

  fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
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
