import { readFileSync, writeFileSync } from "node:fs";
import { encodePacket, parseHex } from "./osc/encode.js";
import { decodePacketSafe } from "./osc/decode.js";
import { renderOffsets, renderTree, treeToInput } from "./osc/tree.js";
import { OscDb } from "./db.js";
import { startServer } from "./server.js";
import type { PacketInput } from "./osc/types.js";

function readBytes(arg: string): Buffer {
  if (arg.startsWith("@")) return readFileSync(arg.slice(1));
  return parseHex(arg);
}

function printDecode(buf: Buffer): number {
  const r = decodePacketSafe(buf);
  if (!r.ok || !r.tree) {
    for (const d of r.diagnostics) {
      console.error(`拒绝: ${d.code} @${d.offset ?? "?"} ${d.message}`);
    }
    return 1;
  }
  console.log("== 树 ==");
  console.log(renderTree(r.tree));
  console.log("== 偏移表 ==");
  console.log(renderOffsets(r.tree));
  const re = encodePacket(treeToInput(r.tree));
  console.log(`重编码一致: ${re.equals(buf) ? "是" : "否"}`);
  return 0;
}

const DEMO_MESSAGE: PacketInput = { type: "message", address: "/x", args: [{ type: "i", value: 7 }] };
const DEMO_BUNDLE: PacketInput = { type: "bundle", timetag: "1", elements: [DEMO_MESSAGE] };
const DEMO_NESTED: PacketInput = {
  type: "bundle",
  timetag: "1",
  elements: [
    {
      type: "message",
      address: "/文本",
      args: [
        { type: "s", value: "你好，世界" },
        { type: "b", value: "00ff10" },
        { type: "f", value: 0.1 },
        { type: "i", value: -42 },
      ],
    },
    {
      type: "bundle",
      timetag: "18446744073709551615",
      elements: [{ type: "message", address: "/inner/deep", args: [{ type: "s", value: "嵌套" }] }],
    },
  ],
};

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "encode": {
      const src = rest[0];
      const text = src.startsWith("@") ? readFileSync(src.slice(1), "utf8") : src;
      const packet = JSON.parse(text) as PacketInput;
      const buf = encodePacket(packet);
      console.log(buf.toString("hex"));
      console.error(`长度: ${buf.length} 字节`);
      return 0;
    }
    case "decode":
    case "tree":
    case "verify": {
      return printDecode(readBytes(rest[0]));
    }
    case "save": {
      const [name, src] = rest;
      const buf = readBytes(src);
      const r = decodePacketSafe(buf);
      const db = new OscDb();
      const saved = db.savePacket(name ?? "未命名", buf, r.tree ?? null, r.diagnostics, r.ok);
      db.close();
      console.log(`已保存算例 #${saved.packetId} v${saved.version}（解码${r.ok ? "成功" : "失败，仅保留原字节与诊断"}）`);
      return 0;
    }
    case "list": {
      const db = new OscDb();
      console.log(JSON.stringify(db.listPackets(), null, 2));
      db.close();
      return 0;
    }
    case "show": {
      const db = new OscDb();
      const row = db.getVersion(Number(rest[0]), rest[1] ? Number(rest[1]) : undefined);
      db.close();
      if (!row) {
        console.error("算例不存在");
        return 1;
      }
      console.log(JSON.stringify(row, null, 2));
      return 0;
    }
    case "export": {
      const db = new OscDb();
      const row = db.getVersion(Number(rest[0]), rest[1] ? Number(rest[1]) : undefined);
      db.close();
      if (!row) {
        console.error("算例不存在");
        return 1;
      }
      const format = rest.includes("--json") ? "json" : "hex";
      const out = format === "hex" ? String(row.hex) : JSON.stringify(row.tree ?? row.diagnostics, null, 2);
      const outIdx = rest.indexOf("--out");
      if (outIdx >= 0 && rest[outIdx + 1]) {
        writeFileSync(rest[outIdx + 1], out);
        console.log(`已导出到 ${rest[outIdx + 1]}`);
      } else {
        console.log(out);
      }
      return 0;
    }
    case "serve": {
      const portArg = rest.find((a) => a.startsWith("--port="));
      const { port } = await startServer(portArg ? Number(portArg.split("=")[1]) : undefined);
      console.log(`OSC 编解码服务已启动: http://127.0.0.1:${port}`);
      return 0;
    }
    case "demo": {
      const hex1 = encodePacket(DEMO_MESSAGE).toString("hex");
      console.log(`已知消息 /x ,i 7 => ${hex1}（期望 2f7800002c69000000000007）`);
      const hex2 = encodePacket(DEMO_BUNDLE).toString("hex");
      console.log(`立即 bundle（单元素）=> ${hex2}（总长 ${hex2.length / 2} 字节，期望 32）`);
      const hex3 = encodePacket(DEMO_NESTED).toString("hex");
      console.log(`中文 + blob + 两层嵌套 => ${hex3}`);
      console.log("--- 解码嵌套样例 ---");
      return printDecode(Buffer.from(hex3, "hex"));
    }
    default:
      console.log(`用法: node dist/src/cli.js <命令>
  encode <packet.json|@file>     结构化编码为 hex
  decode <hex|@file>             解码并显示树与偏移表
  tree|verify <hex|@file>        同 decode
  save <name> <hex|@file>        保存算例到 SQLite
  list                           列出算例
  show <id> [version]            查看算例版本
  export <id> [version] [--json] [--out file]
  serve [--port=N]               启动 HTTP API（默认空闲端口）
  demo                           运行内置演示向量`);
      return cmd ? 1 : 0;
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`错误: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
