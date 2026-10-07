import { test } from "node:test";
import assert from "node:assert/strict";
import { encodePacket } from "../src/osc/encode.js";
import { decodePacketBytes, decodePacketSafe } from "../src/osc/decode.js";
import { treeToInput } from "../src/osc/tree.js";
import { LIMITS } from "../src/osc/limits.js";
import type { PacketInput } from "../src/osc/types.js";

// ---- 手工字节向量（独立构造，不经过本项目编码器） ----

// /x ,i 7  —— 逐字节手写
const KNOWN_MSG_HEX = "2f7800002c69000000000007";

// 立即 bundle 包裹上面的消息：#bundle\0 + 8 字节时间标签 1 + 长度 12 + 消息
const KNOWN_BUNDLE_HEX =
  "2362756e646c6500" + "0000000000000001" + "0000000c" + KNOWN_MSG_HEX;

// 中文消息 /文本 ,s "你好"：地址 7 字节 utf8 + NUL = 8（已对齐）；",s" + NUL = 4；"你好" 6 字节 + NUL + 1 填充 = 8
const CN_MSG_HEX =
  "2fe69687e69cac00" + "2c730000" + "e4bda0e5a5bd0000";

test("已知消息编码为期望 hex，总长 12", () => {
  const buf = encodePacket({ type: "message", address: "/x", args: [{ type: "i", value: 7 }] });
  assert.equal(buf.toString("hex"), KNOWN_MSG_HEX);
  assert.equal(buf.length, 12);
});

test("手工向量解码：地址 /x、类型 ,i、参数 7", () => {
  const tree = decodePacketBytes(Buffer.from(KNOWN_MSG_HEX, "hex"));
  assert.equal(tree.kind, "message");
  assert.equal(tree.address, "/x");
  assert.deepEqual(tree.args, [{ type: "i", value: 7 }]);
  assert.equal(tree.length, 12);
  const addr = tree.fields.find((f) => f.name === "address")!;
  assert.deepEqual([addr.offset, addr.length, addr.padding], [0, 4, 2]);
  const arg = tree.fields.find((f) => f.name === "arg0.i")!;
  assert.deepEqual([arg.offset, arg.length], [8, 4]);
});

test("立即标签单元素 bundle 总长 32", () => {
  const buf = encodePacket({ type: "bundle", timetag: "1", elements: [
    { type: "message", address: "/x", args: [{ type: "i", value: 7 }] },
  ] });
  assert.equal(buf.length, 32);
  assert.equal(buf.toString("hex"), KNOWN_BUNDLE_HEX);
  const tree = decodePacketBytes(Buffer.from(KNOWN_BUNDLE_HEX, "hex"));
  assert.equal(tree.kind, "bundle");
  assert.equal(tree.timetag, "1");
  assert.equal(tree.children!.length, 1);
  assert.equal(tree.children![0].offset, 20);
});

test("中文字符串手工向量往返", () => {
  const tree = decodePacketBytes(Buffer.from(CN_MSG_HEX, "hex"));
  assert.equal(tree.address, "/文本");
  assert.deepEqual(tree.args, [{ type: "s", value: "你好" }]);
  const re = encodePacket(treeToInput(tree));
  assert.equal(re.toString("hex"), CN_MSG_HEX);
});

test("负整数与 int32 边界", () => {
  const buf = encodePacket({ type: "message", address: "/n", args: [
    { type: "i", value: -2147483648 }, { type: "i", value: 2147483647 }, { type: "i", value: -1 },
  ] });
  const tree = decodePacketBytes(buf);
  assert.deepEqual(tree.args!.map((a) => a.value), [-2147483648, 2147483647, -1]);
  assert.throws(() => encodePacket({ type: "message", address: "/n", args: [{ type: "i", value: 2147483648 }] }),
    /OSC_INT_RANGE|超出/);
});

test("float32 的 0.1 舍入按实际位模式报告", () => {
  const buf = encodePacket({ type: "message", address: "/f", args: [{ type: "f", value: 0.1 }] });
  assert.equal(buf.subarray(8, 12).toString("hex"), "3dcccccd");
  const tree = decodePacketBytes(buf);
  const v = tree.args![0].value as number;
  assert.notEqual(v, 0.1);
  assert.equal(v, 0.10000000149011612);
});

test("非有限浮点与 float32 溢出被拒绝", () => {
  for (const bad of [NaN, Infinity, -Infinity, 1e39]) {
    assert.throws(() => encodePacket({ type: "message", address: "/f", args: [{ type: "f", value: bad }] }));
  }
});

test("空 blob 与零字节 blob", () => {
  const buf = encodePacket({ type: "message", address: "/b", args: [
    { type: "b", value: "" }, { type: "b", value: "00ff" },
  ] });
  const tree = decodePacketBytes(buf);
  assert.deepEqual(tree.args, [
    { type: "b", value: "" },
    { type: "b", value: "00ff" },
  ]);
  assert.equal(encodePacket(treeToInput(tree)).toString("hex"), buf.toString("hex"));
});

test("空 bundle 合法", () => {
  const buf = encodePacket({ type: "bundle", timetag: "18446744073709551615", elements: [] });
  assert.equal(buf.length, 16);
  const tree = decodePacketBytes(buf);
  assert.equal(tree.timetag, "18446744073709551615");
  assert.deepEqual(tree.children, []);
});

test("两层嵌套 bundle 往返一致", () => {
  const pkt: PacketInput = { type: "bundle", timetag: "1", elements: [
    { type: "message", address: "/a", args: [{ type: "s", value: "外层" }] },
    { type: "bundle", timetag: "42", elements: [
      { type: "message", address: "/inner", args: [{ type: "b", value: "00" }] },
    ] },
  ] };
  const buf = encodePacket(pkt);
  const tree = decodePacketBytes(buf);
  assert.equal(tree.children![1].kind, "bundle");
  assert.equal(encodePacket(treeToInput(tree)).toString("hex"), buf.toString("hex"));
});

test("非零填充被拒绝并定位", () => {
  // 地址 "/x" 后第二填充字节改为 0x01
  const bad = Buffer.from("2f7800012c69000000000007", "hex");
  const r = decodePacketSafe(bad);
  assert.equal(r.ok, false);
  assert.equal(r.diagnostics[0].code, "OSC_PADDING_NONZERO");
  assert.equal(r.diagnostics[0].offset, 3);
});

test("截断长度被拒绝并定位", () => {
  // bundle 声明元素长度 12 但只给 8 字节
  const bad = Buffer.from("2362756e646c6500" + "0000000000000001" + "0000000c" + "2f7800002c690000", "hex");
  const r = decodePacketSafe(bad);
  assert.equal(r.ok, false);
  assert.equal(r.diagnostics[0].code, "OSC_ELEMENT_BOUNDS");
  assert.equal(r.diagnostics[0].offset, 16);
});

test("元素长度未四字节对齐被拒绝", () => {
  const bad = Buffer.from("2362756e646c6500" + "0000000000000001" + "0000000e" + KNOWN_MSG_HEX + "0000", "hex");
  const r = decodePacketSafe(bad);
  assert.equal(r.diagnostics[0].code, "OSC_ELEMENT_ALIGN");
});

test("元素带未解释尾部字节被拒绝", () => {
  // 元素声明 16 字节，但消息只占 12
  const bad = Buffer.from("2362756e646c6500" + "0000000000000001" + "00000010" + KNOWN_MSG_HEX + "00000000", "hex");
  const r = decodePacketSafe(bad);
  assert.equal(r.diagnostics[0].code, "OSC_TRAILING_BYTES");
  assert.equal(r.diagnostics[0].offset, 32);
});

test("未知类型标记被拒绝", () => {
  const bad = Buffer.from("2f7800002c7a000000000000", "hex"); // ,z
  const r = decodePacketSafe(bad);
  assert.equal(r.diagnostics[0].code, "OSC_UNKNOWN_TYPE");
});

test("损坏 UTF-8 被拒绝", () => {
  const bad = Buffer.from("2fff00002c000000", "hex"); // 地址含 0xff
  const r = decodePacketSafe(bad);
  assert.equal(r.diagnostics[0].code, "OSC_UTF8_INVALID");
});

test("超深嵌套被拒绝", () => {
  let pkt: PacketInput = { type: "message", address: "/x", args: [] };
  for (let i = 0; i < LIMITS.MAX_DEPTH + 1; i++) {
    pkt = { type: "bundle", timetag: "1", elements: [pkt] };
  }
  assert.throws(() => encodePacket(pkt), /OSC_DEPTH_EXCEEDED|深度/);
  // 解码方向：手工构造 MAX_DEPTH+1 层
  let hex = "2f7800002c000000";
  for (let i = 0; i < LIMITS.MAX_DEPTH + 1; i++) {
    const len = (hex.length / 2).toString(16).padStart(8, "0");
    hex = "2362756e646c6500" + "0000000000000001" + len + hex;
  }
  const r = decodePacketSafe(Buffer.from(hex, "hex"));
  assert.equal(r.diagnostics[0].code, "OSC_DEPTH_EXCEEDED");
});

test("字符串内容中的 #bundle 文本不被误判为容器", () => {
  const buf = encodePacket({ type: "message", address: "/s", args: [{ type: "s", value: "#bundle 不是容器" }] });
  const tree = decodePacketBytes(buf);
  assert.equal(tree.kind, "message");
  assert.equal(tree.args![0].value, "#bundle 不是容器");
});

test("时间标签保留原始 64 位值", () => {
  const big = "18446744073709551615";
  const buf = encodePacket({ type: "bundle", timetag: big, elements: [] });
  assert.equal(buf.subarray(8, 16).toString("hex"), "ffffffffffffffff");
  assert.equal(decodePacketBytes(buf).timetag, big);
});

test("非法输入：地址、嵌入零、孤立代理项、坏时间标签", () => {
  assert.throws(() => encodePacket({ type: "message", address: "x", args: [] }));
  assert.throws(() => encodePacket({ type: "message", address: "/a", args: [{ type: "s", value: "a\0b" }] }));
  assert.throws(() => encodePacket({ type: "message", address: "/a", args: [{ type: "s", value: "\uD800" }] }));
  assert.throws(() => encodePacket({ type: "bundle", timetag: "18446744073709551616", elements: [] }));
  assert.throws(() => encodePacket({ type: "bundle", timetag: "-1", elements: [] }));
});
