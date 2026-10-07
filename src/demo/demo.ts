import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { encode } from '../core/encoder.js';
import { decodePacket, hexToBytes } from '../core/decoder.js';
import { verifyPacket } from '../core/verify.js';
import { KNOWN_MESSAGE_HEX, complexSample, emptyBundle, floatSample, knownImmediateBundle, knownMessage } from '../core/samples.js';
import { ReportStore } from '../db/store.js';

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function line(t: string): void {
  console.log(`\n=== ${t} ===`);
}

const dataDir = join(process.cwd(), 'data');
mkdirSync(dataDir, { recursive: true });
const store = new ReportStore(join(dataDir, 'osc-demo.db'));

line('1. 已知向量 /x ,i 7');
const m = encode(knownMessage);
console.log('编码:', hex(m.bytes), '长度:', m.bytes.length);
console.log('断言:', hex(m.bytes) === KNOWN_MESSAGE_HEX ? '通过' : '失败');

line('2. 立即执行单元素 bundle（应为 32 字节）');
const b = encode(knownImmediateBundle);
console.log('编码:', hex(b.bytes), '长度:', b.bytes.length, b.bytes.length === 32 ? '通过' : '失败');

line('3. 综合样例：中文 + 空 blob + 两层嵌套');
const c = encode(complexSample);
console.log('长度:', c.bytes.length, '字节');
const rep = decodePacket(c.bytes);
console.log('valid:', rep.valid, '字段数:', rep.fields.length);
console.log('重编码一致:', verifyPacket(c.bytes).roundtrip ? '是' : '否');

line('4. float32 0.1 舍入（读回值不承诺等于 double 0.1）');
const f = encode(floatSample);
const fr = decodePacket(f.bytes);
console.log('hex:', fr.hex, '读回:', (fr.root as { args: { value: number }[] }).args[0]!.value);

line('5. 空 bundle（16 字节）');
const eb = encode(emptyBundle);
console.log('长度:', eb.bytes.length, eb.bytes.length === 16 ? '通过' : '失败');

line('6. 篡改：非零填充（应被拒绝并定位偏移）');
const tampered = new Uint8Array(m.bytes);
tampered[3] = 0x41; // /x 字段的对齐填充字节（内容后终止零位于偏移 2）
const tr = decodePacket(tampered);
console.log('valid:', tr.valid, '诊断:', tr.diagnostics.map((d) => `${d.code}@${d.offset}`).join(', '));

line('7. 篡改：截断元素长度');
const cut = b.bytes.slice(0, 24);
const cutPadded = new Uint8Array(24);
cutPadded.set(cut, 0);
const cr = decodePacket(cutPadded);
console.log('valid:', cr.valid, '诊断:', cr.diagnostics.map((d) => `${d.code}@${d.offset}`).join(', '));

line('8. ASCII 伪装头部不能误判为 bundle');
const fakeMsg = encode({ kind: 'message', address: '/x', args: [{ type: 's', value: '#bundle' }] });
const fakeReport = decodePacket(fakeMsg.bytes);
console.log('根类型:', fakeReport.tree?.kind, '(应为 message)');

line('9. 数据库保存与复查（含错误包）');
const ok = store.saveReport(rep, { note: '综合样例' });
const bad = store.saveReport(tr, { note: '非零填充错误包' });
console.log(`成功包 id=${ok.id} valid=${ok.valid}; 错误包 id=${bad.id} valid=${bad.valid}`);
const reread = store.get(ok.id)!;
const parsed = JSON.parse(reread.report_json);
console.log('重启后复查 valid:', parsed.valid, '字段数:', parsed.fields.length);
writeFileSync(join(dataDir, 'complex-sample.hex'), rep.hex, 'utf8');
console.log('已导出 data/complex-sample.hex');

line('10. 从十六进制串解析（手工向量直接输入）');
const manual = decodePacket(hexToBytes(KNOWN_MESSAGE_HEX));
console.log('手工向量 valid:', manual.valid, '大小:', manual.packetSize, '地址:', manual.tree?.address);

store.close();
console.log('\n演示完成。');
