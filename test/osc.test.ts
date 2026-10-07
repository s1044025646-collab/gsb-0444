import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePacket, hexToBytes } from '../src/core/decoder.js';
import { encode } from '../src/core/encoder.js';
import { verifyPacket } from '../src/core/verify.js';
import { KNOWN_MESSAGE_HEX, complexSample } from '../src/core/samples.js';
import { LIMITS } from '../src/core/limits.js';
import { OscError } from '../src/core/errors.js';

/** 手工大端写字节，完全独立于项目编码器 */
function build(parts: (number | number[] | string | Uint8Array)[]): Uint8Array {
  const out: number[] = [];
  const pushN = (n: number, width: number) => {
    for (let i = width - 1; i >= 0; i--) out.push((n >>> (i * 8)) & 0xff);
  };
  for (const p of parts) {
    if (typeof p === 'number') out.push(p);
    else if (p instanceof Uint8Array) out.push(...p);
    else if (Array.isArray(p)) out.push(...p);
    else {
      const u = new TextEncoder().encode(p);
      out.push(...u);
      const pad = (4 - ((u.length + 1) % 4)) % 4;
      out.push(0, ...new Array(pad).fill(0));
    }
  }
  return Uint8Array.from(out);
}

function i32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function bundleHead(timetag: bigint): (number[] | Uint8Array)[] {
  const tb = new Uint8Array(8);
  new DataView(tb.buffer).setBigUint64(0, timetag, false);
  return [new TextEncoder().encode('#bundle'), [0], tb];
}

function f32bits(n: number): number[] {
  const b = new ArrayBuffer(4);
  new DataView(b).setFloat32(0, n, false);
  return [...new Uint8Array(b)];
}

test('已知向量 /x ,i 7 = 12 字节精确匹配', () => {
  const hand = build([0x2f, 0x78, [0, 0], 0x2c, 0x69, [0, 0], i32(7)]);
  assert.equal([...hand].map((b) => b.toString(16).padStart(2, '0')).join(''), KNOWN_MESSAGE_HEX);
  assert.equal(hand.length, 12);
  const r = decodePacket(hand);
  assert.equal(r.valid, true);
  assert.equal(r.tree?.kind, 'message');
  assert.equal((r.root as { args: { value: number }[] }).args[0]!.value, 7);
});

test('立即 bundle 手工向量 = 32 字节', () => {
  const msg = hexToBytes(KNOWN_MESSAGE_HEX);
  const hand = build([...bundleHead(1n), i32(12)]);
  const full = new Uint8Array(hand.length + msg.length);
  full.set(hand, 0);
  full.set(msg, hand.length);
  assert.equal(full.length, 32);
  const r = decodePacket(full);
  assert.equal(r.valid, true);
  assert.equal(r.tree?.kind, 'bundle');
  assert.equal(r.tree?.timetag, '1');
  assert.equal(r.tree?.children[0]?.kind, 'message');
  assert.equal(verifyPacket(full).valid, true);
});

test('手工构造各类型并核对偏移', () => {
  // /a ,ifsb: int=-1, float=1.0, s="AB" (2+nul+1pad), blob len=1 data=42 +3pad
  const hand = new Uint8Array([
    ...build(['/a', ',ifsb']),
    ...i32(-1),
    ...f32bits(1.0),
    0x41, 0x42, 0, 0,
    ...i32(1), 0x42, 0, 0, 0,
  ]);
  const r = decodePacket(hand);
  assert.equal(r.valid, true);
  const root = r.root as { args: { type: string; value: unknown }[] };
  assert.deepEqual(root.args.map((a) => a.type), ['i', 'f', 's', 'b']);
  assert.equal(root.args[0]!.value, -1);
  assert.equal(root.args[1]!.value, 1.0);
  assert.equal(root.args[2]!.value, 'AB');
  assert.equal(root.args[3]!.value, '42');
  const sField = r.fields.find((f) => f.path === '/args[2]')!;
  assert.deepEqual([sField.start, sField.end, sField.padding], [20, 24, 1]);
  const bData = r.fields.find((f) => f.path === '/args[3]/data')!;
  assert.deepEqual([bData.start, bData.end, bData.padding], [28, 32, 3]);
});

test('float32 0.1 按位模式读回，非 double 0.1', () => {
  const hand = new Uint8Array([...build(['/f', ',f']), ...f32bits(0.1)]);
  const r = decodePacket(hand);
  const v = (r.root as { args: { value: number }[] }).args[0]!.value;
  assert.notEqual(v, 0.1);
  assert.ok(Math.abs(v - 0.1) < 1e-8);
  assert.equal(verifyPacket(hand).roundtrip, true);
});

test('空 bundle = 16 字节', () => {
  const hand = build(bundleHead(1n));
  assert.equal(hand.length, 16);
  const r = decodePacket(hand);
  assert.equal(r.valid, true);
  assert.equal(r.tree?.children.length, 0);
});

test('中文字符串严格 UTF-8 与重编码一致', () => {
  const { bytes } = encode(complexSample);
  assert.equal(verifyPacket(bytes).valid, true);
  const r = decodePacket(bytes);
  assert.equal(r.valid, true);
  assert.match(r.hex, /e4bda0e5a5bd/);
});

test('非零填充被拒绝并定位真实偏移', () => {
  const hand = new Uint8Array(hexToBytes(KNOWN_MESSAGE_HEX));
  hand[3] = 0xff; // /x 的对齐填充位置
  const r = decodePacket(hand);
  assert.equal(r.valid, false);
  assert.equal(r.diagnostics[0]?.code, 'NONZERO_PADDING');
  assert.equal(r.diagnostics[0]?.offset, 3);
});

test('截断长度：元素声明超出父容器', () => {
  const hand = new Uint8Array(build([...bundleHead(1n), i32(1000)]));
  const r = decodePacket(hand);
  assert.equal(r.valid, false);
  assert.equal(r.diagnostics[0]?.code, 'ELEMENT_OUT_OF_BOUNDS');
  assert.equal(r.diagnostics[0]?.offset, 16);
});

test('未知类型标记拒绝，不猜测', () => {
  const hand = new Uint8Array([...build(['/x', ',d']), ...f32bits(1.0)]);
  const r = decodePacket(hand);
  assert.equal(r.diagnostics[0]?.code, 'UNKNOWN_TYPE');
});

test('超深嵌套拒绝', () => {
  const mk = (depth: number): Uint8Array => {
    let inner = hexToBytes(KNOWN_MESSAGE_HEX);
    for (let i = 0; i < depth; i++) {
      const head = new Uint8Array(build([...bundleHead(1n), i32(inner.length)]));
      const next = new Uint8Array(head.length + inner.length);
      next.set(head, 0);
      next.set(inner, head.length);
      inner = next;
    }
    return inner;
  };
  const ok = decodePacket(mk(LIMITS.maxDepth - 1));
  assert.equal(ok.valid, true);
  const deep = decodePacket(mk(LIMITS.maxDepth + 1));
  assert.equal(deep.valid, false);
  assert.equal(deep.diagnostics[0]?.code, 'NESTING_TOO_DEEP');
});

test('损坏 UTF-8 严格拒绝', () => {
  // /addr 后用 0xff 作非法首字节
  const hand = new Uint8Array([0x2f, 0xff, 0x00, 0x00, ...build([','])]);
  const r = decodePacket(hand);
  assert.equal(r.diagnostics[0]?.code, 'BAD_UTF8');
  assert.equal(r.diagnostics[0]?.offset, 1);
});

test('编码校验：声明类型与 JS 值不符 / blob hex 非法', () => {
  assert.throws(
    () => encode({ kind: 'message', address: '/x', args: [{ type: 'i', value: 1.5 }] }),
    (e: OscError) => e.code === 'ARG_TYPE_MISMATCH',
  );
  assert.throws(
    () => encode({ kind: 'message', address: '/x', args: [{ type: 'b', value: 'zz' }] }),
    (e: OscError) => e.code === 'INVALID_REQUEST',
  );
});

test('编码校验：整数越界 / 非有限浮点 / 地址非法', () => {
  assert.throws(() => encode({ kind: 'message', address: '/x', args: [{ type: 'i', value: 2 ** 31 }] }), (e: OscError) => e.code === 'INT_OUT_OF_RANGE');
  assert.throws(() => encode({ kind: 'message', address: '/x', args: [{ type: 'f', value: Infinity }] }), (e: OscError) => e.code === 'FLOAT_NOT_FINITE');
  assert.throws(() => encode({ kind: 'message', address: 'x', args: [] }), (e: OscError) => e.code === 'BAD_ADDRESS');
  assert.throws(() => encode({ kind: 'message', address: '/x', args: [{ type: 's', value: 'a\u0000b' }] }), (e: OscError) => e.code === 'STRING_EMBEDDED_NUL');
});

test('元素带尾部字节被拒绝', () => {
  // 元素长度声明 16，但内部消息只占 12 字节，补零 -> 消息剩余 4 字节未解释
  const hand = new Uint8Array(build([
    ...bundleHead(1n),
    i32(16),
    hexToBytes(KNOWN_MESSAGE_HEX),
    [0, 0, 0, 0],
  ]));
  const r = decodePacket(hand);
  assert.equal(r.valid, false);
  assert.ok(r.diagnostics.some((d) => d.code === 'ELEMENT_TRAILING_BYTES' || d.code === 'MESSAGE_TRAILING_BYTES'));
});

test('ASCII 数据中的 #bundle 文本不被误判为容器', () => {
  const r = decodePacket(build(['/x', ',s', '#bundle']));
  assert.equal(r.valid, true);
  assert.equal(r.tree?.kind, 'message');
});

test('非法十六进制与非四字节对齐包', () => {
  assert.throws(() => decodePacket(hexToBytes('zz')), (e: OscError) => e.code === 'INVALID_HEX');
  const r = decodePacket(new Uint8Array([0x2f, 0x78, 0x00]));
  assert.equal(r.diagnostics[0]?.code, 'ALIGNMENT_ERROR');
});

test('合法包解码后重编码逐字节一致（综合样例）', () => {
  const { bytes } = encode(complexSample);
  const r = decodePacket(bytes);
  const re = encode(r.root!);
  assert.ok(re.bytes.every((v, i) => v === bytes[i]));
});
