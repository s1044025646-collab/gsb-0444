import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

process.env.OSC_DATA_DIR = mkdtempSync(path.join(tmpdir(), "osc-test-"));

const { createServer } = await import("../src/server.js");
const { OscDb } = await import("../src/db.js");

let base = "";
let server: ReturnType<typeof createServer>;
let db: InstanceType<typeof OscDb>;

before(async () => {
  db = new OscDb();
  server = createServer(db);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  db.close();
});

async function post(p: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(base + p, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test("API 编码已知向量", async () => {
  const { status, json } = await post("/api/encode", {
    packet: { type: "message", address: "/x", args: [{ type: "i", value: 7 }] },
  });
  assert.equal(status, 200);
  assert.equal(json.hex, "2f7800002c69000000000007");
  assert.equal(json.length, 12);
});

test("API 解码与错误路径", async () => {
  const ok = await post("/api/decode", { hex: "2f7800002c69000000000007" });
  assert.equal(ok.status, 200);
  assert.equal((ok.json.tree as { address: string }).address, "/x");
  const bad = await post("/api/decode", { hex: "2f7800012c69000000000007" });
  assert.equal(bad.status, 422);
  const diags = bad.json.diagnostics as { code: string; offset: number }[];
  assert.equal(diags[0].code, "OSC_PADDING_NONZERO");
  assert.equal(diags[0].offset, 3);
});

test("API 保存、修订与读回（含错误包）", async () => {
  const saved = await post("/api/packets", { name: "已知消息", hex: "2f7800002c69000000000007" });
  assert.equal(saved.status, 201);
  const id = saved.json.packetId as number;
  assert.equal(saved.json.decoded, true);

  const revised = await post(`/api/packets/${id}/revise`, { hex: "2f7800012c69000000000007" });
  assert.equal(revised.status, 201);
  assert.equal(revised.json.version, 2);
  assert.equal(revised.json.decoded, false);

  const v1 = await fetch(`${base}/api/packets/${id}?version=1`).then((r) => r.json());
  assert.equal(v1.packet.ok, true);
  assert.equal(v1.packet.hex, "2f7800002c69000000000007");
  assert.equal(v1.packet.tree.address, "/x");

  const v2 = await fetch(`${base}/api/packets/${id}?version=2`).then((r) => r.json());
  assert.equal(v2.packet.ok, false);
  assert.equal(v2.packet.hex, "2f7800012c69000000000007");
  assert.equal(v2.packet.diagnostics[0].code, "OSC_PADDING_NONZERO");

  const hexOut = await fetch(`${base}/api/packets/${id}?format=hex`).then((r) => r.text());
  assert.equal(hexOut, "2f7800012c69000000000007");

  const list = await fetch(`${base}/api/packets`).then((r) => r.json());
  assert.ok(list.packets.length >= 1);
});

test("数据库直接读取", () => {
  const row = db.getVersion(1, 1);
  assert.ok(row);
  assert.equal(row!.ok, true);
  assert.equal(row!.parser_version, "osc-codec/1.0.0");
});
