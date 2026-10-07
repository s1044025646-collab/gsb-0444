import { OscError } from './errors.js';

/**
 * 严格 UTF-8 解码（RFC 3629），拒绝超长编码、代理码点、非法首/续字节。
 * 输入中不应再含终止零（调用前已切分）。
 */
export function decodeUtf8Strict(bytes: Uint8Array, offset: number, path: string): string {
  let out = '';
  let i = 0;
  const fail = (rel: number, msg: string): never => {
    throw new OscError('BAD_UTF8', msg, { offset: offset + rel, path });
  };
  while (i < bytes.length) {
    const b0 = bytes[i]!;
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i += 1;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      const b1 = cont(bytes, i + 1) ?? fail(i, 'UTF-8 双字节序列被截断');
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (b1 & 0x3f));
      i += 2;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      const b1 = cont(bytes, i + 1) ?? fail(i, 'UTF-8 三字节序列被截断');
      if (b0 === 0xe0 && b1 < 0xa0) fail(i + 1, 'UTF-8 超长编码');
      if (b0 === 0xed && b1 > 0x9f) fail(i + 1, 'UTF-8 代理码点非法');
      const b2 = cont(bytes, i + 2) ?? fail(i, 'UTF-8 三字节序列被截断');
      const cp = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
      out += String.fromCharCode(cp);
      i += 3;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      const b1 = cont(bytes, i + 1) ?? fail(i, 'UTF-8 四字节序列被截断');
      if (b0 === 0xf0 && b1 < 0x90) fail(i + 1, 'UTF-8 超长编码');
      if (b0 === 0xf4 && b1 > 0x8f) fail(i + 1, 'UTF-8 码点超过 U+10FFFF');
      const b2 = cont(bytes, i + 2) ?? fail(i, 'UTF-8 四字节序列被截断');
      const b3 = cont(bytes, i + 3) ?? fail(i, 'UTF-8 四字节序列被截断');
      const cp = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
      out += String.fromCodePoint(cp);
      i += 4;
    } else {
      fail(i, `非法 UTF-8 首字节 0x${b0.toString(16)}`);
    }
  }
  return out;

  function cont(b: Uint8Array, idx: number): number | undefined {
    if (idx >= b.length) return undefined;
    const v = b[idx]!;
    return (v & 0xc0) === 0x80 ? v : undefined;
  }
}

/** 编码为 UTF-8，并拒绝嵌入 NUL；返回字节（不含终止零） */
export function encodeUtf8Strict(s: string, path: string): Uint8Array {
  if ([...s].some((ch) => ch.charCodeAt(0) === 0)) {
    throw new OscError('STRING_EMBEDDED_NUL', '字符串不允许包含嵌入的零字符', { path });
  }
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}
