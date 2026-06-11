import { ILinkClient } from './client';
import { ILinkMessage, UpdateResponse } from './types';
import { CONFIG } from '../config';

type MessageHandler = (msg: ILinkMessage) => void;

export class Monitor {
  private cursor  = '';
  private running = false;

  constructor(
    private client:    ILinkClient,
    private onMessage: MessageHandler,
  ) {}

  start() {
    this.running = true;
    this.loop().catch(err => {
      console.error('[monitor] fatal error:', err.message);
      process.exit(1);
    });
  }

  stop() { this.running = false; }

  private async loop() {
    console.log('[monitor] 开始监听消息（长轮询）...');
    while (this.running) {
      try {
        const res = await this.client.post<UpdateResponse>(
          '/getupdates',
          { get_updates_buf: this.cursor },
          CONFIG.POLL_TIMEOUT_MS + 5_000,
        );

        if (res.ret === -14) {
          console.error('[monitor] ⚠️ Session 过期，需要重新登录');
          process.exit(1); // launchd 会重启，触发重新登录
        }

        if (res.ret !== 0) {
          console.error('[monitor] getupdates error:', res.ret, res.errmsg);
          await sleep(CONFIG.RECONNECT_DELAY_MS);
          continue;
        }

        if (res.next_get_updates_buf) {
          this.cursor = res.next_get_updates_buf;
        }

        for (const msg of res.msg_list ?? []) {
          this.onMessage(msg);
        }
      } catch (err: any) {
        if (err.message === 'Request timeout') continue; // 长轮询正常超时
        console.error('[monitor] error:', err.message, '— 3s 后重连...');
        await sleep(CONFIG.RECONNECT_DELAY_MS);
      }
    }
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
