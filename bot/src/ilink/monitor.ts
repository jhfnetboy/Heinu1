import { ILinkClient } from './client';
import { GetUpdatesResp, MessageType, MessageItemType, WeixinMessage } from './types';
import { BASE_INFO, CONFIG } from '../config';

type MessageHandler = (msg: WeixinMessage) => void;

export class Monitor {
  private cursor   = '';
  private running  = false;
  private lastOk   = Date.now();                 // last successful getupdates return
  private watchdog: NodeJS.Timeout | null = null;

  constructor(
    private client:    ILinkClient,
    private onMessage: MessageHandler,
  ) {}

  start() {
    this.running = true;
    this.lastOk  = Date.now();
    this.startWatchdog();
    this.loop().catch(err => {
      console.error('[monitor] 致命错误:', err.message);
      process.exit(1);
    });
  }

  stop() {
    this.running = false;
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
  }

  /**
   * Liveness watchdog. The reconnect loop already retries `fetch failed`
   * forever, but a network drop (e.g. laptop sleep) can leave the process
   * alive yet stuck never receiving again. If no getupdates has returned
   * successfully within WATCHDOG_TIMEOUT_MS, exit(1) so launchd's KeepAlive
   * restarts us with a clean long-poll.
   */
  private startWatchdog() {
    this.watchdog = setInterval(() => {
      const stale = Date.now() - this.lastOk;
      if (stale > CONFIG.WATCHDOG_TIMEOUT_MS) {
        console.error(
          `[monitor] 看门狗: ${Math.round(stale / 1000)}s 未成功轮询，判定连接卡死，退出以触发重启`,
        );
        process.exit(1);
      }
    }, CONFIG.WATCHDOG_CHECK_MS);
    // The watchdog alone must not keep the process alive on shutdown.
    this.watchdog.unref?.();
  }

  private async loop() {
    console.log('[monitor] 开始长轮询...');
    while (this.running) {
      try {
        const res = await this.client.post<GetUpdatesResp>(
          '/ilink/bot/getupdates',
          { get_updates_buf: this.cursor, base_info: BASE_INFO },
          CONFIG.POLL_TIMEOUT_MS + 5_000,
        );

        this.lastOk = Date.now();   // round-trip succeeded — connection is healthy

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
