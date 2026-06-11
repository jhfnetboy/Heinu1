import { randomUUID } from 'crypto';
import { ILinkClient } from './client';
import { ItemType, SendMessageBody } from './types';
import { BASE_INFO, CONFIG } from '../config';

export class Sender {
  constructor(private client: ILinkClient) {}

  async send(toUserId: string, contextToken: string, text: string) {
    const chunks = splitText(text.trim(), CONFIG.MAX_MSG_LEN);
    for (let i = 0; i < chunks.length; i++) {
      const body: SendMessageBody = {
        msg: {
          from_user_id:  '',
          to_user_id:    toUserId,
          client_id:     `heinu1-${randomUUID()}`,
          message_type:  2,
          message_state: 2,
          context_token: contextToken,
          item_list: [
            { type: ItemType.TEXT, text_item: { text: chunks[i] } },
          ],
        },
        base_info: BASE_INFO,
      };

      const res = await this.client.post<{ ret?: number; errmsg?: string }>(
        '/sendmessage', body,
      );
      // empty object {} is success per protocol docs
      if (res.ret !== undefined && res.ret !== 0) {
        console.error('[sender] send failed:', res.ret, res.errmsg);
      }

      if (chunks.length > 1 && i < chunks.length - 1) await sleep(400);
    }
  }

  // Typing indicator is best-effort; getconfig first, then sendtyping
  async sendTyping(toUserId: string, contextToken: string) {
    try {
      const cfg = await this.client.post<{ typing_ticket?: string }>(
        '/getconfig',
        { ilink_user_id: toUserId, context_token: contextToken, base_info: BASE_INFO },
      );
      if (cfg.typing_ticket) {
        await this.client.post('/sendtyping', {
          ilink_user_id:  toUserId,
          typing_ticket:  cfg.typing_ticket,
          status:         1,
          base_info:      BASE_INFO,
        });
      }
    } catch {
      // typing is best-effort, never block the main flow
    }
  }
}

function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLen) chunks.push(text.slice(i, i + maxLen));
  return chunks;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
