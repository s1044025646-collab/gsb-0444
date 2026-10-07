import { OscError } from './errors.js';
import { LIMITS } from './limits.js';
import type { OscArg, OscNode } from './types.js';
import { encodeUtf8Strict } from './utf8.js';

class Writer {
  private chunks: Uint8Array[] = [];
  private len = 0;

  get length(): number {
    return this.len;
  }

  push(data: Uint8Array): void {
    this.chunks.push(data);
    this.len += data.length;
  }

  private pad4(currentLen: number): number {
    return (4 - (currentLen % 4)) % 4;
  }

  writeI32(v: number, path: string): void {
    if (!Number.isInteger(v) || v < -2147483648 || v > 2147483647) {
      throw new OscError('INT_OUT_OF_RANGE', `有符号 32 位整数越界: ${v}`, {
        path,
        details: { value: v },
      });
    }
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, v, false);
    this.push(b);
  }

  writeF32(v: number, path: string): void {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new OscError('FLOAT_NOT_FINITE', `浮点必须为有限数: ${String(v)}`, {
        path,
        details: { value: String(v) },
      });
    }
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, false);
    const back = new DataView(b.buffer).getFloat32(0, false);
    if (!Number.isFinite(back)) {
      throw new OscError('FLOAT32_OVERFLOW', `数值转换为 float32 后溢出: ${v}`, {
        path,
        details: { value: v },
      });
    }
    this.push(b);
  }

  writeString(s: string, path: string): void {
    const bytes = encodeUtf8Strict(s, path);
    if (bytes.length > LIMITS.maxStringBytes) {
      throw new OscError('STRING_TOO_LONG', `字符串长度 ${bytes.length} 超过上限 ${LIMITS.maxStringBytes}`, {
        path,
      });
    }
    const pad = this.pad4(bytes.length + 1);
    const out = new Uint8Array(bytes.length + 1 + pad);
    out.set(bytes, 0);
    this.push(out);
  }

  writeBlob(data: Uint8Array, path: string): void {
    if (data.length > LIMITS.maxBlobSize) {
      throw new OscError('BLOB_TOO_LARGE', `blob 长度 ${data.length} 超过上限 ${LIMITS.maxBlobSize}`, {
        path,
      });
    }
    this.writeI32(data.length, path);
    const pad = this.pad4(data.length);
    if (pad === 0 && data.length > 0) {
      this.push(data);
      return;
    }
    const out = new Uint8Array(data.length + pad);
    out.set(data, 0);
    this.push(out);
  }

  toBytes(): Uint8Array {
    const all = new Uint8Array(this.len);
    let o = 0;
    for (const c of this.chunks) {
      all.set(c, o);
      o += c.length;
    }
    return all;
  }
}

function blobBytes(value: OscArg & { type: 'b' }, path: string): Uint8Array {
  const v = value.value;
  if (typeof v === 'string') {
    const hex = v.startsWith('0x') || v.startsWith('0X') ? v.slice(2) : v;
    if (hex.length % 2 !== 0 || /^[0-9a-fA-F]*$/.test(hex) === false) {
      throw new OscError('INVALID_REQUEST', 'blob 的 hex 字符串非法（需偶数位十六进制）', { path });
    }
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  const arr = Array.isArray(v) ? Uint8Array.from(v) : v;
  for (const x of arr) {
    if (!Number.isInteger(x) || x < 0 || x > 255) {
      throw new OscError('INVALID_REQUEST', 'blob 字节必须为 0..255 的整数', { path });
    }
  }
  return arr;
}

function encodeArg(arg: OscArg, w: Writer, path: string): void {
  switch (arg.type) {
    case 'i':
      if (typeof arg.value !== 'number' || !Number.isInteger(arg.value)) {
        throw new OscError('ARG_TYPE_MISMATCH', `参数 ${path} 声明为 i 但值不是整数`, { path });
      }
      w.writeI32(arg.value, path);
      return;
    case 'f':
      if (typeof arg.value !== 'number') {
        throw new OscError('ARG_TYPE_MISMATCH', `参数 ${path} 声明为 f 但值不是数字`, { path });
      }
      w.writeF32(arg.value, path);
      return;
    case 's':
      if (typeof arg.value !== 'string') {
        throw new OscError('ARG_TYPE_MISMATCH', `参数 ${path} 声明为 s 但值不是字符串`, { path });
      }
      w.writeString(arg.value, path);
      return;
    case 'b':
      w.writeBlob(blobBytes(arg, path), path);
      return;
    default: {
      const t = (arg as { type?: unknown }).type;
      throw new OscError('UNKNOWN_TYPE', `未知类型标记: ${String(t)}`, { path });
    }
  }
}

function encodeMessage(node: { address: string; args: OscArg[] }, w: Writer, path: string): void {
  if (typeof node.address !== 'string' || node.address.length === 0 || node.address[0] !== '/') {
    throw new OscError('BAD_ADDRESS', `地址必须是以 / 开头的非空文本: ${JSON.stringify(node.address)}`, { path });
  }
  if ([...node.address].some((ch) => ch.charCodeAt(0) === 0)) {
    throw new OscError('STRING_EMBEDDED_NUL', '地址不允许包含零字符', { path });
  }
  if (!Array.isArray(node.args)) {
    throw new OscError('INVALID_REQUEST', '消息 args 必须为数组', { path });
  }
  w.writeString(node.address, `${path}/address`);
  const tag = ',' + node.args.map((a) => a.type).join('');
  if (node.args.some((a) => !['i', 'f', 's', 'b'].includes(a.type))) {
    throw new OscError('UNKNOWN_TYPE', `类型标记字符串含未知类型: ${tag}`, { path });
  }
  w.writeString(tag, `${path}/typeTags`);
  node.args.forEach((arg, idx) => encodeArg(arg, w, `${path}/args[${idx}]`));
}

function encodeBundle(node: { timetag: string; elements: OscNode[] }, w: Writer, path: string, depth: number): void {
  if (depth > LIMITS.maxDepth) {
    throw new OscError('NESTING_TOO_DEEP', `嵌套深度超过上限 ${LIMITS.maxDepth}`, { path });
  }
  let tt: bigint;
  try {
    tt = BigInt(node.timetag);
  } catch {
    throw new OscError('BAD_TIMETAG', `时间标签必须为十进制整数字符串: ${JSON.stringify(node.timetag)}`, { path });
  }
  if (tt < 0n || tt > LIMITS.maxTimeTag) {
    throw new OscError('BAD_TIMETAG', `时间标签超出 64 位无符号范围: ${node.timetag}`, { path });
  }
  if (!Array.isArray(node.elements)) {
    throw new OscError('INVALID_REQUEST', 'bundle elements 必须为数组', { path });
  }
  w.push(new TextEncoder().encode('#bundle'));
  w.push(new Uint8Array([0]));
  const tag = new Uint8Array(8);
  new DataView(tag.buffer).setBigUint64(0, tt, false);
  w.push(tag);

  node.elements.forEach((el, idx) => {
    const cw = new Writer();
    encodeNode(el, cw, `${path}/elements[${idx}]`, depth + 1);
    const bytes = cw.toBytes();
    if (bytes.length === 0 || bytes.length % 4 !== 0) {
      throw new OscError('ELEMENT_NOT_ALIGNED', `元素长度必须为正且四字节对齐: ${bytes.length}`, { path });
    }
    w.writeI32(bytes.length, `${path}/elements[${idx}]/length`);
    w.push(bytes);
  });
}

function encodeNode(node: OscNode, w: Writer, path: string, depth: number): void {
  if (!node || typeof node !== 'object') {
    throw new OscError('INVALID_REQUEST', '节点必须为对象', { path });
  }
  if (node.kind === 'message') {
    encodeMessage(node, w, path);
  } else if (node.kind === 'bundle') {
    encodeBundle(node, w, path, depth);
  } else {
    throw new OscError('INVALID_REQUEST', `节点 kind 必须为 message 或 bundle: ${String((node as { kind?: unknown }).kind)}`, {
      path,
    });
  }
}

export function encode(root: OscNode): { bytes: Uint8Array } {
  const w = new Writer();
  encodeNode(root, w, '', 1);
  if (w.length > LIMITS.maxPacketSize) {
    throw new OscError('PACKET_TOO_LARGE', `编码后包大小 ${w.length} 超过上限 ${LIMITS.maxPacketSize}`);
  }
  if (w.length % 4 !== 0) {
    throw new OscError('ALIGNMENT_ERROR', `编码后包未四字节对齐: ${w.length}`);
  }
  return { bytes: w.toBytes() };
}
