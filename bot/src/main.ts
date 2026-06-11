import fs from 'fs';
import { login, clearToken } from './ilink/auth';
import { ILinkClient } from './ilink/client';
import { Monitor } from './ilink/monitor';
import { Sender } from './ilink/sender';
import { SessionStore } from './claude/store';
import { Router } from './router';
import { CONFIG } from './config';

async function main() {
  const args = process.argv.slice(2);

  console.log('🦞 Heinu1 WeChat Bot');
  console.log(`   数据目录: ${CONFIG.DATA_DIR}`);
  console.log(`   权限模式: ${CONFIG.CLAUDE_PERMISSION_MODE}`);
  console.log('');

  fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });

  if (args.includes('--relogin')) {
    clearToken();
  }

  let token: string;
  try {
    token = await login();
  } catch (err: any) {
    console.error('❌ 登录失败:', err.message);
    process.exit(1);
  }

  const client  = new ILinkClient(token);
  const sender  = new Sender(client);
  const store   = new SessionStore();
  const router  = new Router(sender, store);

  const monitor = new Monitor(client, async (msg) => {
    const preview = (msg.content ?? '').slice(0, 40);
    console.log(`[${new Date().toLocaleTimeString('zh-CN')}] 收到消息 from=${msg.from_user_openid.slice(-6)} type=${msg.msg_type} "${preview}"`);
    try {
      await router.handle(msg);
    } catch (err: any) {
      console.error('[main] handle error:', err.message);
    }
  });

  monitor.start();
  console.log('✅ 机器人已启动，等待微信消息...');
  console.log('   在微信中找到 ClawBot 联系人，直接发消息开始\n');

  const shutdown = () => {
    console.log('\n正在停止...');
    monitor.stop();
    process.exit(0);
  };

  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);
}

main();
