import fs from 'fs';
import qrcode from 'qrcode-terminal';
import { ILinkPreAuth } from './client';
import { QRCodeResponse, QRStatusResponse, TokenData } from './types';
import { CONFIG } from '../config';

export async function login(): Promise<string> {
  if (fs.existsSync(CONFIG.TOKEN_FILE)) {
    const data: TokenData = JSON.parse(fs.readFileSync(CONFIG.TOKEN_FILE, 'utf8'));
    console.log('[auth] 使用已保存的 token');
    return data.bot_token;
  }
  return doQRLogin();
}

export async function doQRLogin(): Promise<string> {
  const pre = new ILinkPreAuth();
  console.log('[auth] 获取二维码...');

  const qrRes = await pre.get<QRCodeResponse>('/get_bot_qrcode', { bot_type: '3' });
  if (qrRes.ret !== 0) throw new Error(`获取二维码失败: ${qrRes.errmsg}`);

  console.log('\n请用微信扫描以下二维码，添加 ClawBot 机器人联系人：\n');
  qrcode.generate(qrRes.qrcode_url, { small: true });
  console.log(`\n（也可直接访问：${qrRes.qrcode_url}）\n等待扫码...\n`);

  while (true) {
    await sleep(2000);
    const st = await pre.get<QRStatusResponse>('/get_qrcode_status', {
      qrcode_key: qrRes.qrcode_key,
    });

    if (st.ret === -14) {
      console.log('[auth] 二维码已过期，重新获取...');
      return doQRLogin();
    }

    if (st.status === 'scanned') {
      process.stdout.write('\r[auth] 已扫码，等待手机确认...     ');
    } else if (st.status === 'confirmed' && st.bot_token) {
      console.log('\n[auth] ✅ 登录成功！');
      saveToken(st.bot_token);
      return st.bot_token;
    }
  }
}

function saveToken(token: string) {
  fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });
  const data: TokenData = { bot_token: token, saved_at: Date.now() };
  fs.writeFileSync(CONFIG.TOKEN_FILE, JSON.stringify(data, null, 2));
}

export function clearToken() {
  if (fs.existsSync(CONFIG.TOKEN_FILE)) {
    fs.unlinkSync(CONFIG.TOKEN_FILE);
    console.log('[auth] token 已清除');
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
