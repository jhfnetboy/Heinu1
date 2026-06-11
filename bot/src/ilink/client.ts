import { randomBytes } from 'crypto';

function randomWechatUin(): string {
  const value = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), 'utf8').toString('base64');
}

function buildHeaders(token: string): Record<string, string> {
  return {
    'Content-Type':  'application/json',
    AuthorizationType: 'ilink_bot_token',
    Authorization:   `Bearer ${token}`,
    'X-WECHAT-UIN':  randomWechatUin(),
  };
}

function normalizeBase(base: string): string {
  return base.replace(/\/+$/, '');
}

async function parseResponse<T>(res: Response, label: string): Promise<T> {
  const text = await res.text();
  const payload: any = text ? JSON.parse(text) : {};

  if (!res.ok) {
    const msg = payload?.errmsg ?? `${label} HTTP ${res.status}`;
    throw new Error(`${msg} (HTTP ${res.status})`);
  }
  if (typeof payload?.ret === 'number' && payload.ret !== 0) {
    throw new Error(`${label} ret=${payload.ret}: ${payload.errmsg ?? ''}`);
  }
  return payload as T;
}

export class ILinkClient {
  constructor(
    private token:   string,
    private baseUrl: string,  // domain only, e.g. https://ilinkai.weixin.qq.com
  ) {}

  async post<T>(endpoint: string, body: unknown, timeoutMs = 15_000): Promise<T> {
    const url = new URL(endpoint, normalizeBase(this.baseUrl) + '/');
    const res = await fetch(url, {
      method:  'POST',
      headers: buildHeaders(this.token),
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(timeoutMs),
    });
    return parseResponse<T>(res, endpoint);
  }
}

// Unauthenticated — QR login only
export class ILinkPreAuth {
  constructor(private baseUrl: string) {}

  async get<T>(endpoint: string, extraHeaders: Record<string, string> = {}): Promise<T> {
    const url = new URL(endpoint, normalizeBase(this.baseUrl) + '/');
    const res = await fetch(url, { headers: extraHeaders });
    return parseResponse<T>(res, endpoint);
  }
}
