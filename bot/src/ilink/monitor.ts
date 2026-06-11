import { ILinkClient } from './client';
import { ILinkMessage, ItemType, UpdateResponse } from './types';
import { BASE_INFO, CONFIG } from '../config';

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
      console.error('[monitor] 致命错误:', err.message);
      process.exit(1);
    });
  }

  stop() { this.running = false; }

  private async loop() {
    console.log('[monitor] 开始长轮询...');
    while (this.running) {
      try {
        const res = await this.client.post<UpdateResponse>(
          '/getupdates',
          { get_updates_buf: this.cursor, base_info: BASE_INFO },
          CONFIG.POLL_TIMEOUT_MS + 5_000,
        );

        // -14 = session expired
        if ((res as any).ret === -14) {
          console.error('[monitor] ⚠️ Session 过期，需重新登录');
          process.exit(1);
        }

        if (res.get_updates_buf) {
          this.cursor = res.get_updates_buf;
        }

        for (const msg of res.msgs ?? []) {
          // Skip messages the bot itself sent (message_type 2)
          if (msg.message_type === 2) continue;

          // Only forward messages that have at least one text item
          const hasText = msg.item_list?.some(
            i => i.type === ItemType.TEXT && i.text_item?.text,
          );
          if (!hasText && !msg.item_list?.length) continue;

          this.onMessage(msg);
        }
      } catch (err: any) {
        if (err.message === '请求超时') continue; // 长轮询正常超时
        console.error('[monitor] 错误:', err.message, '— 3s 后重连...');
        await sleep(CONFIG.RECONNECT_DELAY_MS);
      }
    }
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
