import { ILinkClient } from './client';
import { MsgType, SendRequest } from './types';
import { CONFIG } from '../config';

export class Sender {
  constructor(private client: ILinkClient) {}

  async send(toUserId: string, contextToken: string, text: string) {
    const chunks = splitText(text.trim(), CONFIG.MAX_MSG_LEN);
    for (let i = 0; i < chunks.length; i++) {
      const req: SendRequest = {
        to_user_openid: toUserId,
        context_token:  contextToken,
        msg_type:       MsgType.TEXT,
        content:        chunks[i],
      };
      const res = await this.client.post<{ ret: number; errmsg?: string }>('/sendmessage', req);
      if (res.ret !== 0) {
        console.error('[sender] send failed:', res.ret, res.errmsg);
      }
      if (chunks.length > 1 && i < chunks.length - 1) await sleep(400);
    }
  }

  async sendTyping(toUserId: string, contextToken: string) {
    this.client.post('/sendtyping', {
      to_user_openid: toUserId,
      context_token:  contextToken,
    }).catch(() => {}); // 打字指示符是 best-effort
  }
}

function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen));
  }
  return chunks;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
