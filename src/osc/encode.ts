import { OscError } from "./errors.js";
import { LIMITS } from "./limits.js";
import type { ArgInput, BundleInput, MessageInput, PacketInput } from "./types.js";

function align4(n: number): number {
  return (n + 3) & ~3;
}

function isWellFormed(s: string): boolean {
  return typeof (s as unknown as { isWellFormed?: () => boolean }).isWellFormed === "function"
    ? (s as unknown as { isWellFormed: () => boolean }).isWellFormed()
    : !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

export function encodeOscString(s: string, what: string): Buffer {
  if (s.includes(String.fromCharCode(0))) {
    throw new OscError("OSC_STRING_NUL", `${what} 不允许包含嵌入的零字符`);
  }
  if (!isWellFormed(s)) {
    throw new OscError("OSC_STRING_UNICODE", `${what} 含非法 Unicode（孤立代理项）`);
  }
  const body = Buffer.from(s, "utf8");
  if (body.length > LIMITS.MAX_STRING_BYTES) {
    throw new OscError("OSC_LIMIT_EXCEEDED", `${what} 长度 ${body.length} 超过上限 ${LIMITS.MAX_STRING_BYTES}`);
  }
  const total = align4(body.length + 1);
  const out = Buffer.alloc(total);
  body.copy(out, 0);
  return out;
}

export function parseHex(hex: string, what = "hex"): Buffer {
  const clean = hex.replace(/[\s]/g, "");
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new OscError("OSC_BAD_HEX", `${what} 不是合法的十六进制字符串`);
  }
  return Buffer.from(clean, "hex");
}

function encodeInt32(v: number): Buffer {
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new OscError("OSC_ARG_TYPE", `i 类型参数必须是整数，收到 ${String(v)}`);
  }
  if (v < -2147483648 || v > 2147483647) {
    throw new OscError("OSC_INT_RANGE", `i 类型参数 ${v} 超出 int32 范围`);
  }
  const b = Buffer.alloc(4);
  b.writeInt32BE(v, 0);
  return b;
}

function encodeFloat32(v: number): Buffer {
  if (typeof v !== "number" || Number.isNaN(v) || !Number.isFinite(v)) {
    throw new OscError("OSC_FLOAT_NONFINITE", `f 类型参数必须是有限数值，收到 ${String(v)}`);
  }
  const b = Buffer.alloc(4);
  b.writeFloatBE(v, 0);
  const round = b.readFloatBE(0);
  if (!Number.isFinite(round)) {
    throw new OscError("OSC_FLOAT_OVERFLOW", `f 类型参数 ${v} 转换为 float32 后溢出`);
  }
  return b;
}

function encodeBlob(hex: string): Buffer {
  const data = parseHex(hex, "blob 参数");
  if (data.length > LIMITS.MAX_BLOB_BYTES) {
    throw new OscError("OSC_LIMIT_EXCEEDED", `blob 长度 ${data.length} 超过上限 ${LIMITS.MAX_BLOB_BYTES}`);
  }
  const total = align4(data.length);
  const out = Buffer.alloc(4 + total);
  out.writeInt32BE(data.length, 0);
  data.copy(out, 4);
  return out;
}

function encodeArg(arg: ArgInput): { tag: string; bytes: Buffer } {
  switch (arg.type) {
    case "i":
      return { tag: "i", bytes: encodeInt32(arg.value) };
    case "f":
      return { tag: "f", bytes: encodeFloat32(arg.value) };
    case "s":
      return { tag: "s", bytes: encodeOscString(arg.value, "s 类型参数") };
    case "b":
      return { tag: "b", bytes: encodeBlob(arg.value) };
    default:
      throw new OscError("OSC_UNKNOWN_TYPE", `未知参数类型 ${JSON.stringify(arg)}`);
  }
}

export function encodeMessage(msg: MessageInput): Buffer {
  if (typeof msg.address !== "string" || msg.address.length === 0 || !msg.address.startsWith("/")) {
    throw new OscError("OSC_INVALID_ADDRESS", `消息地址必须是以 / 开头的非空字符串，收到 ${JSON.stringify(msg.address)}`);
  }
  if (!Array.isArray(msg.args)) {
    throw new OscError("OSC_BAD_INPUT", "消息缺少 args 数组");
  }
  const parts: Buffer[] = [encodeOscString(msg.address, "消息地址")];
  const argParts: Buffer[] = [];
  let tags = ",";
  for (const arg of msg.args) {
    const { tag, bytes } = encodeArg(arg);
    tags += tag;
    argParts.push(bytes);
  }
  parts.push(encodeOscString(tags, "类型标记"));
  parts.push(...argParts);
  return Buffer.concat(parts);
}

export function parseTimetag(t: string): bigint {
  if (typeof t !== "string" || !/^(0|[1-9][0-9]*)$/.test(t)) {
    throw new OscError("OSC_BAD_TIMETAG", `时间标签必须是非负十进制整数字符串，收到 ${JSON.stringify(t)}`);
  }
  const v = BigInt(t);
  if (v > 0xffffffffffffffffn) {
    throw new OscError("OSC_BAD_TIMETAG", `时间标签 ${t} 超出 uint64 范围`);
  }
  return v;
}

export function encodeBundle(b: BundleInput, depth = 1): Buffer {
  if (depth > LIMITS.MAX_DEPTH) {
    throw new OscError("OSC_DEPTH_EXCEEDED", `bundle 嵌套深度超过上限 ${LIMITS.MAX_DEPTH}`);
  }
  if (!Array.isArray(b.elements)) {
    throw new OscError("OSC_BAD_INPUT", "bundle 缺少 elements 数组");
  }
  if (b.elements.length > LIMITS.MAX_ELEMENTS) {
    throw new OscError("OSC_LIMIT_EXCEEDED", `bundle 元素数超过上限 ${LIMITS.MAX_ELEMENTS}`);
  }
  const head = Buffer.alloc(16);
  head.write("#bundle\0", 0, "ascii");
  head.writeBigUInt64BE(parseTimetag(b.timetag), 8);
  const parts: Buffer[] = [head];
  for (const el of b.elements) {
    const body = encodePacketInner(el, depth + 1);
    const len = Buffer.alloc(4);
    len.writeInt32BE(body.length, 0);
    parts.push(len, body);
  }
  return Buffer.concat(parts);
}

function encodePacketInner(p: PacketInput, depth: number): Buffer {
  if (p === null || typeof p !== "object") {
    throw new OscError("OSC_BAD_INPUT", "包必须是对象");
  }
  if (p.type === "message") return encodeMessage(p);
  if (p.type === "bundle") return encodeBundle(p, depth);
  throw new OscError("OSC_BAD_INPUT", `未知包类型 ${JSON.stringify((p as { type?: unknown }).type)}`);
}

export function encodePacket(p: PacketInput): Buffer {
  const out = encodePacketInner(p, 1);
  if (out.length > LIMITS.MAX_PACKET_SIZE) {
    throw new OscError("OSC_LIMIT_EXCEEDED", `包大小 ${out.length} 超过上限 ${LIMITS.MAX_PACKET_SIZE}`);
  }
  return out;
}
