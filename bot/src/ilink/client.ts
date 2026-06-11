import https from 'https';
import http  from 'http';

function makeUin(): string {
  const n = Math.floor(Math.random() * 0xFFFFFFFF);
  return Buffer.from(String(n)).toString('base64');
}

interface RawResponse { status: number; body: string; }

function rawRequest(url: string, opts: {
  method?:    string;
  headers?:   Record<string, string>;
  body?:      string;
  timeoutMs?: number;
  _redirects?: number;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || undefined,
      path:     parsed.pathname + parsed.search,
      method:   opts.method ?? 'GET',
      headers:  opts.headers ?? {},
      timeout:  opts.timeoutMs ?? 10_000,
    };

    const req = lib.request(options, (res) => {
      const loc = res.headers.location;
      if (loc && res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
        if ((opts._redirects ?? 0) >= 3) { reject(new Error('重定向次数过多')); return; }
        res.resume();
        const target = loc.startsWith('http') ? loc : `${parsed.origin}${loc}`;
        rawRequest(target, { ...opts, _redirects: (opts._redirects ?? 0) + 1 }).then(resolve, reject);
        return;
      }

      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end',  () => resolve({ status: res.statusCode ?? 0, body: data }));
    });

    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error',   reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function parseJSON<T>(raw: RawResponse, url: string): T {
  const { status, body } = raw;
  if (!body.trim()) {
    throw new Error(
      `iLink API 返回空响应 (HTTP ${status})\n` +
      `  URL: ${url}\n` +
      `  提示: 检查网络是否可达 ilinkai.weixin.qq.com，或账号是否已开通 ClawBot`
    );
  }
  if (status >= 400) {
    throw new Error(`HTTP ${status}: ${body.slice(0, 300)}\n  URL: ${url}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(
      `响应不是合法 JSON (HTTP ${status})\n` +
      `  URL: ${url}\n` +
      `  响应: ${body.slice(0, 200)}`
    );
  }
}

export class ILinkClient {
  constructor(
    private token:   string,
    private baseurl: string,   // from TokenData.baseurl, may differ per account
  ) {}

  private authHeaders(): Record<string, string> {
    return {
      'Content-Type':            'application/json',
      'AuthorizationType':       'ilink_bot_token',
      'Authorization':           `Bearer ${this.token}`,
      'X-WECHAT-UIN':            makeUin(),
      'iLink-App-ClientVersion': '1',
    };
  }

  async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(this.baseurl + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const raw = await rawRequest(url.toString(), { headers: this.authHeaders() });
    return parseJSON<T>(raw, url.toString());
  }

  async post<T>(path: string, payload: unknown, timeoutMs = 10_000): Promise<T> {
    const url = this.baseurl + path;
    const raw = await rawRequest(url, {
      method:    'POST',
      headers:   this.authHeaders(),
      body:      JSON.stringify(payload),
      timeoutMs,
    });
    return parseJSON<T>(raw, url);
  }
}

// No auth — used only during QR login (always hits the default base)
export class ILinkPreAuth {
  constructor(private baseurl: string) {}

  async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(this.baseurl + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const raw = await rawRequest(url.toString(), {});
    return parseJSON<T>(raw, url.toString());
  }
}
