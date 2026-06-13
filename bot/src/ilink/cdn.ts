import { createDecipheriv } from 'crypto';
import path from 'path';
import fs from 'fs';
import { CDNMedia, CDN_BASE_URL } from './types';
import { CONFIG } from '../config';

/**
 * Decode an aes_key from the iLink protocol.
 * Three possible encodings from the server:
 *   - 32-char hex string (image_item.aeskey legacy field)
 *   - base64(raw 16 bytes)  → Format A
 *   - base64(hex 32 chars)  → Format B (most file/voice/video keys)
 */
export function decodeAesKey(encoded: string): Buffer {
  if (/^[0-9a-fA-F]{32}$/.test(encoded)) {
    return Buffer.from(encoded, 'hex');
  }
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32) {
    const hex = decoded.toString('ascii');
    if (/^[0-9a-fA-F]{32}$/.test(hex)) return Buffer.from(hex, 'hex');
  }
  throw new Error(`Cannot decode AES key: decoded length ${decoded.length} (expected 16 or 32)`);
}

/** AES-128-ECB decrypt with PKCS7 unpadding (Node crypto handles padding automatically). */
export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Download and decrypt a CDN media item. Returns the plaintext bytes. */
export async function downloadMedia(media: CDNMedia, aeskeyOverride?: string): Promise<Buffer> {
  const url = `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`CDN 下载失败: HTTP ${res.status}`);

  const ciphertext = Buffer.from(await res.arrayBuffer());
  const keySource  = aeskeyOverride ?? media.aes_key;
  if (!keySource) throw new Error('缺少 AES key，无法解密媒体文件');

  return decryptAesEcb(ciphertext, decodeAesKey(keySource));
}

/** Save bytes to MEDIA_DIR/<filename> and return the absolute path. */
export async function saveMedia(data: Buffer, filename: string): Promise<string> {
  fs.mkdirSync(CONFIG.MEDIA_DIR, { recursive: true });
  const dest = path.join(CONFIG.MEDIA_DIR, filename);
  fs.writeFileSync(dest, data);
  return dest;
}

/** Guess a file extension from the first 8 bytes (magic bytes). */
export function guessExt(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return '.png';
  if (buf[0] === 0x47 && buf[1] === 0x49) return '.gif';
  if (buf[0] === 0x25 && buf[1] === 0x50) return '.pdf';  // %PDF
  if (buf[0] === 0x50 && buf[1] === 0x4b) return '.zip';  // PK (also docx/xlsx)
  return '.bin';
}
