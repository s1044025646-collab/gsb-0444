import { OscError } from './errors.js';
import { LIMITS } from './limits.js';
import { Reader } from './reader.js';
import type { Diagnostic, FieldInfo, NodeInfo, OscArg, OscNode } from './types.js';
import { decodeUtf8Strict } from './utf8.js';

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hexInput: string): Uint8Array {
  const hex = hexInput.startsWith('0x') || hexInput.startsWith('0X') ? hexInput.slice(2) : hexInput;
  if (hex.length === 0 || hex.length % 2 !== 0 || /^[0-9a-fA-F]*$/.test(hex) === false) {
    throw new OscError('INVALID_HEX', '十六进制输入非法（需为偶数位的 0-9a-f）');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export interface DecodeResult {
  valid: boolean;
  parserVersion: number;
  packetSize: number;
  root: OscNode | null;
  tree: NodeInfo | null;
  fields: FieldInfo[];
  diagnostics: Diagnostic[];
  hex: string;
}

export function decodePacket(bytes: Uint8Array): DecodeResult {
  const parser = new Parser();
  let root: OscNode | null = null;
  let tree: NodeInfo | null = null;
  let valid = false;
  try {
    const result = parser.parse(bytes);
    root = result.node;
    tree = result.info;
    valid = true;
  } catch (e) {
    const err = e instanceof OscError ? e : new OscError('OUT_OF_BOUNDS', e instanceof Error ? e.message : String(e));
    parser.diagnostics.push({
      severity: 'error',
      code: err.code,
      message: err.message,
      offset: err.offset,
      path: err.path,
    });
  }
  return {
    valid,
    parserVersion: LIMITS.parserVersion,
    packetSize: bytes.length,
    root,
    tree,
    fields: parser.fields,
    diagnostics: parser.diagnostics,
    hex: bytesToHex(bytes),
  };
}

class Parser {
  fields: FieldInfo[] = [];
  diagnostics: Diagnostic[] = [];

  private field(f: FieldInfo): void {
    this.fields.push(f);
  }

  parse(bytes: Uint8Array): { node: OscNode; info: NodeInfo } {
    if (bytes.length === 0) {
      throw new OscError('EMPTY_PACKET', '空包无法解析', { offset: 0 });
    }
    if (bytes.length > LIMITS.maxPacketSize) {
      throw new OscError('PACKET_TOO_LARGE', `包大小 ${bytes.length} 超过上限 ${LIMITS.maxPacketSize}`, { offset: 0 });
    }
    if (bytes.length % 4 !== 0) {
      throw new OscError('ALIGNMENT_ERROR', `包总长度 ${bytes.length} 不是 4 的倍数`, { offset: bytes.length });
    }
    const r = new Reader(bytes, 0);
    if (bytes[0] === 0x23) {
      return this.parseBundle(r, '', 1);
    }
    return this.parseMessage(r, '', 1);
  }

  private parseMessage(r: Reader, path: string, depth: number): { node: OscNode; info: NodeInfo } {
    const start = r.absOffset;

    const addrRange = r.readStringField(`${path}/address`);
    const address = decodeUtf8Strict(
      r.buf.subarray(addrRange.contentStart - r.base, addrRange.contentEnd - r.base),
      addrRange.contentStart,
      `${path}/address`,
    );
    if (address.length === 0 || address[0] !== '/') {
      throw new OscError('BAD_ADDRESS', `地址必须以 / 开头且非空: ${JSON.stringify(address)}`, {
        offset: addrRange.contentStart,
        path: `${path}/address`,
      });
    }
    this.field({
      name: 'address',
      path: `${path}/address`,
      start: addrRange.contentStart,
      end: addrRange.fieldEnd,
      length: addrRange.contentEnd - addrRange.contentStart,
      padding: addrRange.fieldEnd - addrRange.contentEnd - 1,
      value: address,
    });

    const tagRange = r.readStringField(`${path}/typeTags`);
    const tagString = decodeUtf8Strict(
      r.buf.subarray(tagRange.contentStart - r.base, tagRange.contentEnd - r.base),
      tagRange.contentStart,
      `${path}/typeTags`,
    );
    if (tagString.length === 0 || tagString[0] !== ',') {
      throw new OscError('BAD_TYPE_TAG_START', `类型标记字符串必须以逗号开头: ${JSON.stringify(tagString)}`, {
        offset: tagRange.contentStart,
        path: `${path}/typeTags`,
      });
    }
    this.field({
      name: 'typeTags',
      path: `${path}/typeTags`,
      start: tagRange.contentStart,
      end: tagRange.fieldEnd,
      length: tagRange.contentEnd - tagRange.contentStart,
      padding: tagRange.fieldEnd - tagRange.contentEnd - 1,
      value: tagString,
    });

    const argTypes = [...tagString.slice(1)];
    const args: OscArg[] = [];
    for (let idx = 0; idx < argTypes.length; idx++) {
      const t = argTypes[idx]!;
      const ap = `${path}/args[${idx}]`;
      if (t === 'i') {
        const s = r.absOffset;
        const v = r.i32(ap);
        this.field({ name: 'arg:i', path: ap, start: s, end: s + 4, length: 4, padding: 0, value: v });
        args.push({ type: 'i', value: v });
      } else if (t === 'f') {
        const s = r.absOffset;
        const v = r.f32(ap);
        this.field({ name: 'arg:f', path: ap, start: s, end: s + 4, length: 4, padding: 0, value: v });
        args.push({ type: 'f', value: v });
      } else if (t === 's') {
        const sf = r.readStringField(ap);
        const raw = r.buf.subarray(sf.contentStart - r.base, sf.contentEnd - r.base);
        const v = decodeUtf8Strict(raw, sf.contentStart, ap);
        this.field({
          name: 'arg:s',
          path: ap,
          start: sf.contentStart,
          end: sf.fieldEnd,
          length: sf.contentEnd - sf.contentStart,
          padding: sf.fieldEnd - sf.contentEnd - 1,
          value: v,
        });
        args.push({ type: 's', value: v });
      } else if (t === 'b') {
        const lenStart = r.absOffset;
        const n = r.i32(`${ap}/length`);
        if (n < 0) {
          throw new OscError('OUT_OF_BOUNDS', `blob 长度不能为负: ${n}`, { offset: lenStart, path: `${ap}/length` });
        }
        if (n > LIMITS.maxBlobSize) {
          throw new OscError('BLOB_TOO_LARGE', `blob 长度 ${n} 超过上限 ${LIMITS.maxBlobSize}`, {
            offset: lenStart,
            path: `${ap}/length`,
          });
        }
        const dataStart = r.absOffset;
        r.require(n, 'blob 数据', ap);
        const data = r.buf.slice(r.offset, r.offset + n);
        r.offset += n;
        const pad = (4 - (n % 4)) % 4;
        r.require(pad, 'blob 填充', ap);
        for (let p = 0; p < pad; p++) {
          if (r.buf[r.offset + p] !== 0) {
            throw new OscError('NONZERO_PADDING', 'blob 填充字节必须为零', { offset: r.absOffset + p, path: ap });
          }
        }
        r.offset += pad;
        this.field({ name: 'arg:b:length', path: `${ap}/length`, start: lenStart, end: lenStart + 4, length: 4, padding: 0, value: n });
        this.field({
          name: 'arg:b:data',
          path: `${ap}/data`,
          start: dataStart,
          end: dataStart + n + pad,
          length: n,
          padding: pad,
          value: `0x${bytesToHex(data)}`,
        });
        args.push({ type: 'b', value: bytesToHex(data) });
      } else {
        throw new OscError('UNKNOWN_TYPE', `未知类型标记: ${t}`, { offset: r.absOffset, path: ap });
      }
    }

    const end = r.absOffset;
    if (r.remaining() !== 0) {
      throw new OscError('MESSAGE_TRAILING_BYTES', `消息解析后仍有 ${r.remaining()} 个未解释字节`, { offset: end, path });
    }

    const node: OscNode = { kind: 'message', address, args };
    const info: NodeInfo = {
      kind: 'message',
      path,
      depth,
      start,
      end,
      length: end - start,
      address,
      children: [],
    };
    return { node, info };
  }

  private parseBundle(r: Reader, path: string, depth: number): { node: OscNode; info: NodeInfo } {
    const start = r.absOffset;
    if (depth > LIMITS.maxDepth) {
      throw new OscError('NESTING_TOO_DEEP', `嵌套深度超过上限 ${LIMITS.maxDepth}`, { offset: start, path });
    }

    const markerStart = r.absOffset;
    r.require(8, 'bundle 标记', path);
    const marker = r.bytes(8, path);
    const expected = new TextEncoder().encode('#bundle');
    for (let i = 0; i < 7; i++) {
      if (marker[i] !== expected[i]) {
        throw new OscError('BAD_BUNDLE_MARKER', `bundle 必须以 "#bundle" 开头，偏移 ${markerStart + i} 处不匹配`, {
          offset: markerStart + i,
          path,
        });
      }
    }
    if (marker[7] !== 0) {
      throw new OscError('BAD_BUNDLE_MARKER', `bundle 标记后必须紧跟零字节，偏移 ${markerStart + 7} 处非零`, {
        offset: markerStart + 7,
        path,
      });
    }
    this.field({ name: 'bundleMarker', path: `${path}/marker`, start: markerStart, end: markerStart + 8, length: 8, padding: 0, value: '#bundle' });

    const ttStart = r.absOffset;
    r.require(8, '时间标签', path);
    const tt = r.u64Big(`${path}/timetag`);
    this.field({
      name: 'timetag',
      path: `${path}/timetag`,
      start: ttStart,
      end: ttStart + 8,
      length: 8,
      padding: 0,
      value: tt.toString() + (tt === LIMITS.immediatelyTimeTag ? ' (immediately)' : ''),
    });

    const elements: OscNode[] = [];
    const childInfos: NodeInfo[] = [];
    while (r.remaining() > 0) {
      const idx = elements.length;
      const ep = `${path}/elements[${idx}]`;
      const lenStart = r.absOffset;
      const size = r.i32(`${ep}/length`);
      if (size <= 0) {
        throw new OscError('ELEMENT_LENGTH_NONPOSITIVE', `元素长度必须为正整数: ${size}`, {
          offset: lenStart,
          path: `${ep}/length`,
        });
      }
      if (size % 4 !== 0) {
        throw new OscError('ELEMENT_NOT_ALIGNED', `元素长度必须四字节对齐: ${size}`, {
          offset: lenStart,
          path: `${ep}/length`,
        });
      }
      const dataStart = r.absOffset;
      if (r.remaining() < size) {
        throw new OscError('ELEMENT_OUT_OF_BOUNDS', `元素声明长度 ${size} 超出父容器剩余 ${r.remaining()} 字节`, {
          offset: lenStart,
          path: `${ep}/length`,
        });
      }
      this.field({ name: 'elementLength', path: `${ep}/length`, start: lenStart, end: lenStart + 4, length: 4, padding: 0, value: size });

      const sub = new Reader(r.buf.subarray(r.offset, r.offset + size), dataStart);
      const parsed = sub.buf[0] === 0x23
        ? this.parseBundle(sub, ep, depth + 1)
        : this.parseMessage(sub, ep, depth + 1);
      if (sub.remaining() !== 0) {
        throw new OscError('ELEMENT_TRAILING_BYTES', `元素存在 ${sub.remaining()} 个未解释尾部字节`, {
          offset: sub.absOffset,
          path: ep,
        });
      }
      elements.push(parsed.node);
      childInfos.push(parsed.info);
      r.offset += size;
    }

    const end = r.absOffset;
    const node: OscNode = { kind: 'bundle', timetag: tt.toString(), elements };
    const info: NodeInfo = {
      kind: 'bundle',
      path,
      depth,
      start,
      end,
      length: end - start,
      timetag: tt.toString(),
      children: childInfos,
    };
    return { node, info };
  }
}
