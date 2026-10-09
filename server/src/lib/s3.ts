/**
 * Minimal client for S3-compatible object storage (AWS S3, Backblaze B2, Cloudflare R2,
 * Wasabi, Hetzner, MinIO, ...): put, get, list and delete, signed with AWS Signature V4.
 *
 * Only what off-site backups need, without the AWS SDK: bodies are small enough to hold in
 * memory and every request carries the SHA-256 of its body, which all providers accept.
 */
import crypto from 'node:crypto';

export interface S3Config {
  /** e.g. https://s3.eu-central-003.backblazeb2.com. Empty: AWS S3 in `region`. */
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Bucket in the path (https://host/bucket/key) instead of the host name. */
  pathStyle?: boolean;
}

export interface S3Object {
  key: string;
  size: number;
  lastModified: string;
}

export class S3Error extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

const sha256 = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => crypto.createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as S3 expects it (keeps unreserved characters, optionally slashes). */
function encode(s: string, keepSlash = false) {
  const e = encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? e.replace(/%2F/g, '/') : e;
}

function xmlValue(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? decodeXml(m[1]) : undefined;
}

function decodeXml(s: string) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

export class S3Client {
  private readonly base: URL;
  private readonly pathStyle: boolean;

  constructor(private readonly cfg: S3Config) {
    const custom = cfg.endpoint?.trim();
    this.base = new URL(custom || `https://s3.${cfg.region}.amazonaws.com`);
    // Custom endpoints: path style works everywhere. AWS: virtual-hosted style.
    this.pathStyle = cfg.pathStyle ?? Boolean(custom);
  }

  /** Host the requests go to (for status screens; no secrets). */
  get host() {
    return this.pathStyle ? this.base.host : `${this.cfg.bucket}.${this.base.host}`;
  }

  private url(key: string, query: Record<string, string> = {}) {
    const keyPath = key ? `/${encode(key, true)}` : '/';
    const basePath = this.base.pathname.replace(/\/$/, '');
    const pathname = this.pathStyle ? `${basePath}/${encode(this.cfg.bucket)}${key ? keyPath : ''}` : `${basePath}${keyPath}`;
    const canonicalQuery = Object.keys(query)
      .sort()
      .map((k) => `${encode(k)}=${encode(query[k])}`)
      .join('&');
    const origin = `${this.base.protocol}//${this.host}`;
    return { href: `${origin}${pathname}${canonicalQuery ? `?${canonicalQuery}` : ''}`, pathname, canonicalQuery };
  }

  private async request(
    method: 'GET' | 'PUT' | 'DELETE' | 'HEAD',
    key: string,
    opts: { query?: Record<string, string>; body?: Buffer; contentType?: string; timeoutMs?: number } = {},
  ): Promise<Response> {
    const body = opts.body ?? Buffer.alloc(0);
    const { href, pathname, canonicalQuery } = this.url(key, opts.query);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const date = amzDate.slice(0, 8);
    const payloadHash = sha256(body);
    const headers: Record<string, string> = {
      host: this.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (opts.contentType) headers['content-type'] = opts.contentType;
    const signed = Object.keys(headers).sort();
    const canonicalRequest = [
      method,
      pathname,
      canonicalQuery,
      signed.map((h) => `${h}:${headers[h].trim()}\n`).join(''),
      signed.join(';'),
      payloadHash,
    ].join('\n');
    const scope = `${date}/${this.cfg.region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
    const kDate = hmac(`AWS4${this.cfg.secretAccessKey}`, date);
    const kSigning = hmac(hmac(hmac(kDate, this.cfg.region), 's3'), 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
    const { host: _host, ...sent } = headers;
    const res = await fetch(href, {
      method,
      headers: {
        ...sent,
        Authorization: `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`,
      },
      body: method === 'PUT' ? new Uint8Array(body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    });
    if (!res.ok) {
      const text = method === 'HEAD' ? '' : await res.text().catch(() => '');
      const code = xmlValue(text, 'Code') ?? `HTTP_${res.status}`;
      const message = xmlValue(text, 'Message') ?? res.statusText;
      throw new S3Error(`${code}: ${message}`, res.status, code);
    }
    return res;
  }

  async putObject(key: string, body: Buffer, contentType = 'application/octet-stream') {
    // Allow about 1 s per 100 kB on top of a minute, for slow office uplinks.
    await this.request('PUT', key, { body, contentType, timeoutMs: 60_000 + Math.ceil(body.length / 100_000) * 1000 });
  }

  async getObject(key: string): Promise<Buffer> {
    const res = await this.request('GET', key, { timeoutMs: 30 * 60_000 });
    return Buffer.from(await res.arrayBuffer());
  }

  async deleteObject(key: string) {
    await this.request('DELETE', key);
  }

  async listObjects(prefix: string): Promise<S3Object[]> {
    const out: S3Object[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix };
      if (token) query['continuation-token'] = token;
      const xml = await (await this.request('GET', '', { query })).text();
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        out.push({
          key: xmlValue(m[1], 'Key') ?? '',
          size: Number(xmlValue(m[1], 'Size') ?? 0),
          lastModified: xmlValue(m[1], 'LastModified') ?? '',
        });
      }
      token = xmlValue(xml, 'IsTruncated') === 'true' ? xmlValue(xml, 'NextContinuationToken') : undefined;
    } while (token);
    return out;
  }
}
