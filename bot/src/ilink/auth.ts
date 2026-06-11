import fs from 'fs';
import qrcode from 'qrcode-terminal';
import { ILinkPreAuth } from './client';
import { QRCodeResponse, QRStatusResponse, TokenData } from './types';
import { CONFIG } from '../config';

export interface LoginResult { bot_token: string; baseurl: string; }

export async function login(): Promise<LoginResult> {
  if (fs.existsSync(CONFIG.TOKEN_FILE)) {
    const data: TokenData = JSON.parse(fs.readFileSync(CONFIG.TOKEN_FILE, 'utf8'));
    console.log('[auth] 使用已保存的 token');
    return { bot_token: data.bot_token, baseurl: data.baseurl };
  }
  return doQRLogin();
}

export async function doQRLogin(): Promise<LoginResult> {
  const pre = new ILinkPreAuth(CONFIG.ILINK_DEFAULT_BASE);
  console.log('[auth] 获取登录二维码...');

  const qrRes = await pre.get<QRCodeResponse>('/get_bot_qrcode', { bot_type: '3' });
  if (!qrRes.qrcode) {
    throw new Error(`获取二维码失败: ${JSON.stringify(qrRes)}`);
  }

  // qrcode_img_content is the URL WeChat clients can scan
  // qrcode is the polling key
  console.log('\n请用微信扫描以下二维码，添加 ClawBot 为联系人：\n');
  qrcode.generate(qrRes.qrcode_img_content, { small: true });
  console.log(`\n二维码 URL: ${qrRes.qrcode_img_content}`);
  console.log('等待扫码...\n');

  while (true) {
    await sleep(2000);
    const st = await pre.get<QRStatusResponse>('/get_qrcode_status', {
      qrcode: qrRes.qrcode,   // polling key (not the image URL)
    });

    // -14 means this QR code expired, start over
    if ((st as any).ret === -14 || (st as any).ret === -1) {
      console.log('[auth] 二维码已过期，重新获取...');
      return doQRLogin();
    }

    if (st.status === 'scanned') {
      process.stdout.write('\r[auth] 已扫码，等待手机确认...     ');
    } else if (st.status === 'confirmed' && st.bot_token) {
      console.log('\n[auth] ✅ 登录成功！');
      const baseurl = st.baseurl || CONFIG.ILINK_DEFAULT_BASE;
      saveToken(st.bot_token, baseurl);
      return { bot_token: st.bot_token, baseurl };
    }
  }
}

function saveToken(token: string, baseurl: string) {
  fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
  const data: TokenData = { bot_token: token, baseurl, saved_at: Date.now() };
  fs.writeFileSync(CONFIG.TOKEN_FILE, JSON.stringify(data, null, 2));
}

export function clearToken() {
  if (fs.existsSync(CONFIG.TOKEN_FILE)) {
    fs.unlinkSync(CONFIG.TOKEN_FILE);
    console.log('[auth] token 已清除');
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
