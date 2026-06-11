import { randomUUID } from 'crypto';
import { ILinkClient } from './client';
import { MessageItemType, MessageState, MessageType } from './types';
import { BASE_INFO, CONFIG } from '../config';

export class Sender {
  constructor(private client: ILinkClient) {}

  async send(toUserId: string, contextToken: string, text: string) {
    const chunks = splitText(text.trim(), CONFIG.MAX_MSG_LEN);
    for (let i = 0; i < chunks.length; i++) {
      await this.client.post('/ilink/bot/sendmessage', {
        msg: {
          from_user_id:  '',
          to_user_id:    toUserId,
          client_id:     randomUUID(),
          message_type:  MessageType.BOT,
          message_state: MessageState.FINISH,
          context_token: contextToken,
          item_list: [{ type: MessageItemType.TEXT, text_item: { text: chunks[i] } }],
        },
        base_info: BASE_INFO,
      });
      if (i < chunks.length - 1) await sleep(400);
    }
  }

  async sendTyping(toUserId: string, contextToken: string) {
    try {
      const cfg = await this.client.post<{ typing_ticket?: string }>(
        '/ilink/bot/getconfig',
        { ilink_user_id: toUserId, context_token: contextToken, base_info: BASE_INFO },
      );
      if (cfg.typing_ticket) {
        await this.client.post('/ilink/bot/sendtyping', {
          ilink_user_id: toUserId,
          typing_ticket: cfg.typing_ticket,
          status: 1,
          base_info: BASE_INFO,
        });
      }
    } catch { /* best-effort */ }
  }
}

function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLen) chunks.push(text.slice(i, i + maxLen));
  return chunks;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
