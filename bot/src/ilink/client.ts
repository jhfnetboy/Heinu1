import https from 'https';
import { CONFIG } from '../config';

function makeUin(): string {
  const n = Math.floor(Math.random() * 0xFFFFFFFF);
  return Buffer.from(String(n)).toString('base64');
}

function request(url: string, opts: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   opts.method ?? 'GET',
      headers:  opts.headers ?? {},
      timeout:  opts.timeoutMs ?? 10_000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve(data));
    });

    req.on('timeout', () => {
      req.destroy(new Error('Request timeout'));
    });
    req.on('error', reject);

    if (opts.body) req.write(opts.body);
    req.end();
  });
}

export class ILinkClient {
  constructor(private token: string) {}

  private authHeaders(): Record<string, string> {
    return {
      'Content-Type':       'application/json',
      'AuthorizationType':  'ilink_bot_token',
      'Authorization':      `Bearer ${this.token}`,
      'X-WECHAT-UIN':       makeUin(),
    };
  }

  async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(CONFIG.ILINK_BASE + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const body = await request(url.toString(), { headers: this.authHeaders() });
    return JSON.parse(body);
  }

  async post<T>(path: string, payload: unknown, timeoutMs = 10_000): Promise<T> {
    const body = await request(CONFIG.ILINK_BASE + path, {
      method:    'POST',
      headers:   this.authHeaders(),
      body:      JSON.stringify(payload),
      timeoutMs,
    });
    return JSON.parse(body);
  }
}

// Unauthenticated — used only during QR login
export class ILinkPreAuth {
  async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(CONFIG.ILINK_BASE + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const body = await request(url.toString(), {});
    return JSON.parse(body);
  }
}
