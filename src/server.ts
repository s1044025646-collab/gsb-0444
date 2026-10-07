import http from "node:http";
import { readFileSync } from "node:fs";
import { encodePacket, parseHex } from "./osc/encode.js";
import { decodePacketSafe } from "./osc/decode.js";
import { OscError } from "./osc/errors.js";
import { LIMITS, PARSER_VERSION } from "./osc/limits.js";
import { treeToInput } from "./osc/tree.js";
import { OscDb } from "./db.js";
import type { PacketInput } from "./osc/types.js";

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(data);
}
function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) reject(new OscError("OSC_LIMIT_EXCEEDED", "请求体过大"));
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new OscError("OSC_BAD_INPUT", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function errBody(e: unknown): { status: number; body: unknown } {
  if (e instanceof OscError) {
    return { status: 422, body: { ok: false, error: { code: e.code, message: e.message, offset: e.offset } } };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { status: 500, body: { ok: false, error: { code: "INTERNAL", message: msg } } };
}

/** 从请求体取原始字节：hex 或 file 二选一 */
function bytesFromBody(body: Record<string, unknown>): Buffer {
  if (typeof body.hex === "string") return parseHex(body.hex);
  if (typeof body.file === "string") return readFileSync(body.file);
  throw new OscError("OSC_BAD_INPUT", "需要提供 hex 字符串或 file 路径");
}

export function createServer(db: OscDb): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname}`;
    try {
      if (route === "GET /api/health") {
        return json(res, 200, { ok: true, parser: PARSER_VERSION, limits: LIMITS });
      }
      if (route === "POST /api/encode") {
        const body = (await readBody(req)) as { packet?: PacketInput };
        if (!body.packet) throw new OscError("OSC_BAD_INPUT", "缺少 packet 字段");
        const buf = encodePacket(body.packet);
        return json(res, 200, { ok: true, hex: buf.toString("hex"), length: buf.length });
      }
      if (route === "POST /api/decode" || route === "POST /api/validate") {
        const body = (await readBody(req)) as Record<string, unknown>;
        const buf = bytesFromBody(body);
        const result = decodePacketSafe(buf);
        return json(res, result.ok ? 200 : 422, { ...result, length: buf.length });
      }
      if (route === "POST /api/roundtrip") {
        const body = (await readBody(req)) as Record<string, unknown>;
        const buf = bytesFromBody(body);
        const result = decodePacketSafe(buf);
        if (!result.ok || !result.tree) return json(res, 422, { ...result, length: buf.length });
        const re = encodePacket(treeToInput(result.tree));
        return json(res, 200, { ok: true, identical: re.equals(buf), hex: re.toString("hex"), tree: result.tree });
      }
      if (route === "POST /api/packets") {
        const body = (await readBody(req)) as Record<string, unknown>;
        const name = typeof body.name === "string" && body.name ? body.name : "未命名";
        const buf = bytesFromBody(body);
        const result = decodePacketSafe(buf);
        const saved = db.savePacket(name, buf, result.tree ?? null, result.diagnostics, result.ok);
        return json(res, 201, { ok: true, ...saved, decoded: result.ok, diagnostics: result.diagnostics });
      }
      if (route === "GET /api/packets") {
        return json(res, 200, { ok: true, packets: db.listPackets() });
      }
      const mRev = /^\/api\/packets\/(\d+)\/revise$/.exec(url.pathname);
      if (req.method === "POST" && mRev) {
        const body = (await readBody(req)) as Record<string, unknown>;
        const buf = bytesFromBody(body);
        const result = decodePacketSafe(buf);
        const saved = db.revisePacket(Number(mRev[1]), buf, result.tree ?? null, result.diagnostics, result.ok);
        return json(res, 201, { ok: true, ...saved, decoded: result.ok, diagnostics: result.diagnostics });
      }
      const mGet = /^\/api\/packets\/(\d+)$/.exec(url.pathname);
      if (req.method === "GET" && mGet) {
        const v = url.searchParams.get("version");
        const row = db.getVersion(Number(mGet[1]), v == null ? undefined : Number(v));
        if (!row) return json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "算例或版本不存在" } });
        const format = url.searchParams.get("format");
        if (format === "hex") {
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          return res.end(String(row.hex));
        }
        return json(res, 200, { ok: true, packet: row });
      }
      return json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: `未知路由 ${route}` } });
    } catch (e) {
      const { status, body } = errBody(e);
      return json(res, status, body);
    }
  });
}

export async function startServer(port?: number): Promise<{ server: http.Server; port: number }> {
  const db = new OscDb();
  const server = createServer(db);
  const wanted = port ?? (process.env.PORT ? Number(process.env.PORT) : 0);
  await new Promise<void>((resolve) => server.listen(wanted, "127.0.0.1", resolve));
  const addr = server.address();
  const actual = typeof addr === "object" && addr ? addr.port : wanted;
  return { server, port: actual };
}

if (process.argv[1] && /server\.(js|ts)$/.test(process.argv[1])) {
  const portArg = process.argv.find((a: string) => a.startsWith("--port="));
  const port = portArg ? Number(portArg.split("=")[1]) : undefined;
  startServer(port).then(({ port }) => {
    console.log(`OSC 编解码服务已启动: http://127.0.0.1:${port}`);
  });
}
