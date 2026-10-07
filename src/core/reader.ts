import { OscError } from './errors.js';

/** 大端只读视图，所有读操作前先做边界检查 */
export class Reader {
  readonly buf: Uint8Array;
  /** 该视图在整个包中的基准偏移（用于元素子视图上报绝对偏移） */
  readonly base: number;
  offset = 0;

  constructor(buf: Uint8Array, base = 0) {
    this.buf = buf;
    this.base = base;
  }

  get length(): number {
    return this.buf.length;
  }

  get absOffset(): number {
    return this.base + this.offset;
  }

  remaining(): number {
    return this.buf.length - this.offset;
  }

  require(n: number, what: string, path: string): void {
    if (this.offset + n > this.buf.length) {
      throw new OscError('TRUNCATED_PACKET', `读取${what}需要 ${n} 字节，但只剩 ${this.remaining()} 字节`, {
        offset: this.absOffset,
        path,
      });
    }
  }

  i32(path = '/'): number {
    this.require(4, 'int32', path);
    const b = this.buf;
    const o = this.offset;
    this.offset += 4;
    return (b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!;
  }

  u32(path = '/'): number {
    return this.i32(path) >>> 0;
  }

  f32(path = '/'): number {
    this.require(4, 'float32', path);
    const o = this.offset;
    this.offset += 4;
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset + o, 4);
    return dv.getFloat32(0, false);
  }

  u64Big(path = '/'): bigint {
    this.require(8, 'timetag/uint64', path);
    const o = this.offset;
    this.offset += 8;
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset + o, 8);
    return dv.getBigUint64(0, false);
  }

  bytes(n: number, path = '/'): Uint8Array {
    this.require(n, '字节序列', path);
    const slice = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return slice;
  }

  /** 读取零终止并四字节对齐的字符串原始字节，返回内容与字段的绝对起止偏移 */
  readStringField(path: string): { contentStart: number; contentEnd: number; fieldEnd: number } {
    const startAbs = this.absOffset;
    let rel = this.offset;
    const b = this.buf;
    while (rel < b.length && b[rel] !== 0) rel++;
    if (rel >= b.length) {
      throw new OscError('TRUNCATED_PACKET', '字符串缺少终止零字节', { offset: startAbs, path });
    }
    const contentEndAbs = this.base + rel;
    const padded = Math.ceil((rel - this.offset + 1) / 4) * 4;
    const fieldEndRel = this.offset + padded;
    if (fieldEndRel > b.length) {
      throw new OscError('TRUNCATED_PACKET', '字符串对齐填充超出包边界', {
        offset: this.base + fieldEndRel - 1,
        path,
      });
    }
    for (let p = rel + 1; p < fieldEndRel; p++) {
      if (b[p] !== 0) {
        throw new OscError(
          'NONZERO_PADDING',
          `字符串填充字节必须为零，在偏移 ${this.base + p} 发现 0x${b[p]!.toString(16).padStart(2, '0')}`,
          { offset: this.base + p, path },
        );
      }
    }
    this.offset = fieldEndRel;
    return { contentStart: startAbs, contentEnd: contentEndAbs, fieldEnd: this.base + fieldEndRel };
  }
}
