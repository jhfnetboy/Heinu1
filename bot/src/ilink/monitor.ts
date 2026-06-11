import { ILinkClient } from './client';
import { GetUpdatesResp, MessageType, MessageItemType, WeixinMessage } from './types';
import { BASE_INFO, CONFIG } from '../config';

type MessageHandler = (msg: WeixinMessage) => void;

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
        const res = await this.client.post<GetUpdatesResp>(
          '/ilink/bot/getupdates',
          { get_updates_buf: this.cursor, base_info: BASE_INFO },
          CONFIG.POLL_TIMEOUT_MS + 5_000,
        );

        if (res.get_updates_buf) this.cursor = res.get_updates_buf;

        for (const msg of res.msgs ?? []) {
          // Skip bot's own outgoing messages
          if (msg.message_type === MessageType.BOT) continue;
          this.onMessage(msg);
        }
      } catch (err: any) {
        if (err.name === 'TimeoutError' || err.message?.includes('timeout')) continue;
        console.error('[monitor] 错误:', err.message, '— 3s 后重连...');
        await sleep(CONFIG.RECONNECT_DELAY_MS);
      }
    }
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
