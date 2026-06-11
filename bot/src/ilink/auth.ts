import fs from 'fs';
import qrcode from 'qrcode-terminal';
import { ILinkPreAuth } from './client';
import { TokenData } from './types';
import { CONFIG } from '../config';

interface QrCodeResponse {
  qrcode:             string;  // polling key
  qrcode_img_content: string;  // URL to display
}

// Note: reference uses 'scaned' (single n) — match exactly
interface QrStatusResponse {
  status:         'wait' | 'scaned' | 'confirmed' | 'expired';
  bot_token?:     string;
  baseurl?:       string;
  ilink_bot_id?:  string;
  ilink_user_id?: string;
}

export interface LoginResult {
  bot_token: string;
  baseurl:   string;  // domain only
}

export async function login(): Promise<LoginResult> {
  if (fs.existsSync(CONFIG.TOKEN_FILE)) {
    const data: TokenData = JSON.parse(fs.readFileSync(CONFIG.TOKEN_FILE, 'utf8'));
    console.log('[auth] 使用已保存的 token');
    return { bot_token: data.bot_token, baseurl: data.baseurl };
  }
  return doQRLogin();
}

export async function doQRLogin(): Promise<LoginResult> {
  const pre     = new ILinkPreAuth(CONFIG.ILINK_DEFAULT_BASE);
  const MAX_TRY = 3;

  for (let attempt = 1; attempt <= MAX_TRY; attempt++) {
    console.log(`[auth] 获取登录二维码 (${attempt}/${MAX_TRY})...`);

    const qr = await pre.get<QrCodeResponse>('/ilink/bot/get_bot_qrcode?bot_type=3');
    if (!qr.qrcode || !qr.qrcode_img_content) {
      throw new Error(`获取二维码失败: ${JSON.stringify(qr).slice(0, 200)}`);
    }

    console.log('\n请用微信扫描以下二维码，添加 ClawBot 为联系人：\n');
    qrcode.generate(qr.qrcode_img_content, { small: true });
    console.log(`\n二维码 URL: ${qr.qrcode_img_content}\n等待扫码...\n`);

    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await sleep(2000);
      try {
        const st = await pre.get<QrStatusResponse>(
          `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}`,
          { 'iLink-App-ClientVersion': '1' },   // only this endpoint needs it
        );

        if (st.status === 'scaned') {
          process.stdout.write('\r[auth] 已扫码，等待手机确认...     ');
        } else if (st.status === 'confirmed') {
          if (!st.bot_token) throw new Error('confirmed 但服务器未返回 bot_token');
          console.log('\n[auth] ✅ 登录成功！');
          const baseurl = st.baseurl || CONFIG.ILINK_DEFAULT_BASE;
          saveToken(st.bot_token, baseurl);
          return { bot_token: st.bot_token, baseurl };
        } else if (st.status === 'expired') {
          console.log('\n[auth] 二维码过期，重新获取...');
          break;
        }
      } catch (err: any) {
        console.warn(`[auth] 轮询出错: ${err.message}`);
      }
    }
  }

  throw new Error('登录失败：已达最大重试次数');
}

function saveToken(bot_token: string, baseurl: string) {
  fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
  const data: TokenData = { bot_token, baseurl, saved_at: Date.now() };
  fs.writeFileSync(CONFIG.TOKEN_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function clearToken() {
  if (fs.existsSync(CONFIG.TOKEN_FILE)) {
    fs.unlinkSync(CONFIG.TOKEN_FILE);
    console.log('[auth] token 已清除');
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
