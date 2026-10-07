import { OscError } from "./errors.js";
import { LIMITS } from "./limits.js";
import type { ArgValue, DecodeResult, FieldInfo, NodeInfo } from "./types.js";

const BUNDLE_MAGIC = Buffer.from("#bundle\0", "ascii");
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function align4(n: number): number {
  return (n + 3) & ~3;
}

class Reader {
  readonly buf: Buffer;
  readonly start: number;
  readonly end: number;
  pos: number;
  constructor(buf: Buffer, start: number, end: number) {
    this.buf = buf;
    this.start = start;
    this.end = end;
    this.pos = start;
  }
  remaining(): number {
    return this.end - this.pos;
  }
  need(n: number, what: string): void {
    if (n < 0 || this.pos + n > this.end) {
      throw new OscError("OSC_TRUNCATED", `${what} 需要 ${n} 字节，但容器内仅剩 ${this.remaining()} 字节`, this.pos);
    }
  }
  readInt32(what: string): number {
    this.need(4, what);
    const v = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  readString(what: string, fields: FieldInfo[], name: string): string {
    const strStart = this.pos;
    let nul = -1;
    for (let i = this.pos; i < this.end; i++) {
      if (this.buf[i] === 0) {
        nul = i;
        break;
      }
    }
    if (nul < 0) {
      throw new OscError("OSC_TRUNCATED", `${what} 在容器内找不到零终止字节`, strStart);
    }
    const len = nul - strStart;
    if (len > LIMITS.MAX_STRING_BYTES) {
      throw new OscError("OSC_LIMIT_EXCEEDED", `${what} 长度 ${len} 超过上限 ${LIMITS.MAX_STRING_BYTES}`, strStart);
    }
    let text: string;
    try {
      text = utf8Decoder.decode(this.buf.subarray(strStart, nul));
    } catch {
      throw new OscError("OSC_UTF8_INVALID", `${what} 含损坏的 UTF-8 字节序列`, strStart);
    }
    const total = align4(len + 1);
    this.need(total, `${what}（含终止与填充）`);
    for (let i = nul; i < strStart + total; i++) {
      if (this.buf[i] !== 0) {
        throw new OscError("OSC_PADDING_NONZERO", `${what} 的终止/填充字节在偏移 ${i} 处非零`, i);
      }
    }
    this.pos = strStart + total;
    fields.push({ name, offset: strStart, length: total, padding: total - len, value: text });
    return text;
  }
}
function decodeMessage(r: Reader, depth: number): NodeInfo {
  const nodeStart = r.pos;
  const fields: FieldInfo[] = [];
  const address = r.readString("消息地址", fields, "address");
  if (!address.startsWith("/")) {
    throw new OscError("OSC_INVALID_ADDRESS", `消息地址必须以 / 开头，收到 ${JSON.stringify(address)}`, nodeStart);
  }
  const tagStart = r.pos;
  const tags = r.readString("类型标记", fields, "typetags");
  if (!tags.startsWith(",")) {
    throw new OscError("OSC_INVALID_TYPETAG", `类型标记必须以逗号开头，收到 ${JSON.stringify(tags)}`, tagStart);
  }
  const args: ArgValue[] = [];
  const tagList = tags.slice(1);
  for (let i = 0; i < tagList.length; i++) {
    const tag = tagList[i];
    switch (tag) {
      case "i": {
        const off = r.pos;
        const v = r.readInt32(`参数 ${i} (i)`);
        fields.push({ name: `arg${i}.i`, offset: off, length: 4, padding: 0, value: v });
        args.push({ type: "i", value: v });
        break;
      }
      case "f": {
        const off = r.pos;
        r.need(4, `参数 ${i} (f)`);
        const v = r.buf.readFloatBE(r.pos);
        r.pos += 4;
        fields.push({ name: `arg${i}.f`, offset: off, length: 4, padding: 0, value: v });
        args.push({ type: "f", value: v });
        break;
      }
      case "s": {
        const v = r.readString(`参数 ${i} (s)`, fields, `arg${i}.s`);
        args.push({ type: "s", value: v });
        break;
      }
      case "b": {
        const lenOff = r.pos;
        const len = r.readInt32(`参数 ${i} (b) 长度前缀`);
        if (len < 0) {
          throw new OscError("OSC_ELEMENT_SIZE", `blob 长度前缀为负 ${len}`, lenOff);
        }
        if (len > LIMITS.MAX_BLOB_BYTES) {
          throw new OscError("OSC_LIMIT_EXCEEDED", `blob 长度 ${len} 超过上限 ${LIMITS.MAX_BLOB_BYTES}`, lenOff);
        }
        r.need(len, `参数 ${i} (b) 数据`);
        const dataOff = r.pos;
        const hex = r.buf.subarray(dataOff, dataOff + len).toString("hex");
        r.pos += len;
        const pad = align4(len) - len;
        if (pad > 0) {
          r.need(pad, `参数 ${i} (b) 填充`);
          for (let j = 0; j < pad; j++) {
            if (r.buf[r.pos + j] !== 0) {
              throw new OscError("OSC_PADDING_NONZERO", `blob 填充字节在偏移 ${r.pos + j} 处非零`, r.pos + j);
            }
          }
          r.pos += pad;
        }
        fields.push({ name: `arg${i}.b.len`, offset: lenOff, length: 4, padding: 0, value: len });
        fields.push({ name: `arg${i}.b.data`, offset: dataOff, length: len, padding: pad, value: hex });
        args.push({ type: "b", value: hex });
        break;
      }
      default:
        throw new OscError("OSC_UNKNOWN_TYPE", `未知类型标记 '${tag}'（参数 ${i}）`, tagStart + 1 + i);
    }
  }
  return {
    kind: "message",
    offset: nodeStart,
    length: r.pos - nodeStart,
    fields,
    address,
    args,
  };
}

function decodePacket(r: Reader, depth: number): NodeInfo {
  if (depth > LIMITS.MAX_DEPTH) {
    throw new OscError("OSC_DEPTH_EXCEEDED", `bundle 嵌套深度超过上限 ${LIMITS.MAX_DEPTH}`, r.pos);
  }
  if (r.remaining() >= 8 && r.buf.subarray(r.pos, r.pos + 8).equals(BUNDLE_MAGIC)) {
    return decodeBundle(r, depth);
  }
  return decodeMessage(r, depth);
}

function decodeBundle(r: Reader, depth: number): NodeInfo {
  const nodeStart = r.pos;
  const fields: FieldInfo[] = [];
  r.need(16, "bundle 头");
  fields.push({ name: "magic", offset: r.pos, length: 8, padding: 0, value: "#bundle" });
  r.pos += 8;
  const timetag = r.buf.readBigUInt64BE(r.pos).toString(10);
  fields.push({ name: "timetag", offset: r.pos, length: 8, padding: 0, value: timetag });
  r.pos += 8;
  const children: NodeInfo[] = [];
  let count = 0;
  while (r.pos < r.end) {
    if (++count > LIMITS.MAX_ELEMENTS) {
      throw new OscError("OSC_LIMIT_EXCEEDED", `bundle 元素数超过上限 ${LIMITS.MAX_ELEMENTS}`, r.pos);
    }
    const lenOff = r.pos;
    const len = r.readInt32(`元素 ${count - 1} 长度`);
    if (len <= 0) {
      throw new OscError("OSC_ELEMENT_SIZE", `元素长度必须为正数，收到 ${len}`, lenOff);
    }
    if (len % 4 !== 0) {
      throw new OscError("OSC_ELEMENT_ALIGN", `元素长度 ${len} 不是四字节对齐`, lenOff);
    }
    if (r.pos + len > r.end) {
      throw new OscError(
        "OSC_ELEMENT_BOUNDS",
        `元素长度 ${len} 超出父容器剩余范围 ${r.end - r.pos}（元素起始偏移 ${r.pos}）`,
        lenOff,
      );
    }
    fields.push({ name: `element${count - 1}.size`, offset: lenOff, length: 4, padding: 0, value: len });
    const sub = new Reader(r.buf, r.pos, r.pos + len);
    const child = decodePacket(sub, depth + 1);
    if (sub.pos !== sub.end) {
      throw new OscError(
        "OSC_TRAILING_BYTES",
        `元素在偏移 ${sub.pos} 处解析完毕，但声明长度内仍有 ${sub.end - sub.pos} 个未解释字节`,
        sub.pos,
      );
    }
    children.push(child);
    r.pos += len;
  }
  return {
    kind: "bundle",
    offset: nodeStart,
    length: r.pos - nodeStart,
    fields,
    timetag,
    children,
  };
}

export function decodePacketBytes(buf: Buffer): NodeInfo {
  if (buf.length === 0) {
    throw new OscError("OSC_TRUNCATED", "空输入不是合法 OSC 包", 0);
  }
  if (buf.length > LIMITS.MAX_PACKET_SIZE) {
    throw new OscError("OSC_LIMIT_EXCEEDED", `包大小 ${buf.length} 超过上限 ${LIMITS.MAX_PACKET_SIZE}`, 0);
  }
  const r = new Reader(buf, 0, buf.length);
  const node = decodePacket(r, 1);
  if (r.pos !== r.end) {
    throw new OscError("OSC_TRAILING_BYTES", `包在偏移 ${r.pos} 处解析完毕，仍有 ${r.end - r.pos} 个未解释字节`, r.pos);
  }
  return node;
}

export function decodePacketSafe(buf: Buffer): DecodeResult {
  try {
    const tree = decodePacketBytes(buf);
    return { ok: true, tree, diagnostics: [{ ok: true }] };
  } catch (e) {
    if (e instanceof OscError) {
      return { ok: false, diagnostics: [{ ok: false, code: e.code, message: e.message, offset: e.offset }] };
    }
    throw e;
  }
}
