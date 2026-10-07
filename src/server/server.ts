import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { OscError } from '../core/errors.js';
import { LIMITS } from '../core/limits.js';
import { ReportStore } from '../db/store.js';
import { OscService } from './service.js';

const DATA_DIR = process.env.OSC_DATA_DIR ?? join(process.cwd(), 'data');
mkdirSync(DATA_DIR, { recursive: true });
const store = new ReportStore(join(DATA_DIR, 'osc-reports.db'));
const service = new OscService(store);

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(json);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 4 * LIMITS.maxPacketSize + 65536) {
      throw new OscError('INVALID_REQUEST', '请求体过大');
    }
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new OscError('INVALID_JSON', '请求体不是合法 JSON');
  }
}

interface Route {
  method: string;
  pattern: RegExp;
  handle: (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray, body: unknown) => unknown;
}

const routes: Route[] = [
  { method: 'GET', pattern: /^\/api\/health$/, handle: () => ({ ok: true, parserVersion: LIMITS.parserVersion, limits: LIMITS }) },
  { method: 'GET', pattern: /^\/api\/limits$/, handle: () => ({ limits: LIMITS }) },
  {
    method: 'POST',
    pattern: /^\/api\/encode$/,
    handle: (_req, _res, _m, body) => service.encodeNode((body as { node?: unknown }).node),
  },
  { method: 'POST', pattern: /^\/api\/decode$/, handle: (_r, _s, _m, body) => service.decode(body) },
  { method: 'POST', pattern: /^\/api\/verify$/, handle: (_r, _s, _m, body) => service.verify(body) },
  {
    method: 'POST',
    pattern: /^\/api\/reports$/,
    handle: (_r, _s, _m, body) => {
      const b = body as { report?: unknown; groupId?: number; note?: string };
      if (!b.report || typeof b.report !== 'object') throw new OscError('INVALID_REQUEST', '需要 report 字段');
      return service.saveReport(b.report as never, { groupId: b.groupId, note: b.note });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/reports\/(\d+)\/revisions$/,
    handle: (_r, _s, m, body) => {
      const b = body as { note?: string };
      return service.revise(body, Number(m[1]), b.note);
    },
  },
  { method: 'GET', pattern: /^\/api\/reports$/, handle: () => service.listReports() },
  {
    method: 'GET',
    pattern: /^\/api\/reports\/(\d+)$/,
    handle: (_r, _s, m) => service.getReport(Number(m[1])),
  },
  {
    method: 'GET',
    pattern: /^\/api\/reports\/groups\/(\d+)$/,
    handle: (_r, _s, m) => service.listGroup(Number(m[1])),
  },
  {
    method: 'POST',
    pattern: /^\/api\/query-offset$/,
    handle: (_r, _s, _m, body) => {
      const b = body as { offset?: number; hex?: string; file?: string };
      const report = service.decode({ hex: b.hex, file: b.file });
      return { offset: b.offset, fields: service.queryOffset(report, Number(b.offset)) };
    },
  },
];

const server: Server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    let body: unknown = {};
    if (req.method === 'POST' || req.method === 'PUT') body = await readBody(req);

    if (req.method === 'GET' && /^\/api\/reports\/(\d+)\/export$/.test(path)) {
      const id = Number(path.split('/')[3]);
      const format = (url.searchParams.get('format') ?? 'json') as 'hex' | 'json' | 'bin';
      if (!['hex', 'json', 'bin'].includes(format)) throw new OscError('INVALID_REQUEST', 'format 必须为 hex|json|bin');
      const out = url.searchParams.get('out') ?? undefined;
      const result = service.exportReport(id, format, out);
      res.writeHead(200, { 'content-type': `${result.mime}; charset=utf-8` });
      res.end(result.data);
      return;
    }

    for (const route of routes) {
      if (route.method !== req.method) continue;
      const m = path.match(route.pattern);
      if (!m) continue;
      send(res, 200, route.handle(req, res, m, body));
      return;
    }
    send(res, 404, { error: { code: 'NOT_FOUND', message: `无此路由: ${req.method} ${path}` } });
  } catch (e) {
    if (e instanceof OscError) {
      const status = e.code === 'FILE_NOT_FOUND' ? 404 : 400;
      send(res, status, { error: { code: e.code, message: e.message, offset: e.offset, path: e.path } });
    } else {
      send(res, 500, { error: { code: 'INTERNAL', message: (e as Error).message } });
    }
  }
});

const preferred = Number(process.env.PORT ?? process.argv[2] ?? 0);

function listen(port: number, retries = 10): void {
  server.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && retries > 0) {
      listen(0, retries - 1);
    } else {
      console.error('服务器启动失败:', err.message);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    const a = server.address();
    const actual = typeof a === 'object' && a ? a.port : port;
    console.log(`OSC 编解码核验服务已启动: http://127.0.0.1:${actual}`);
    console.log(`数据目录: ${DATA_DIR}`);
  });
}

listen(preferred);
