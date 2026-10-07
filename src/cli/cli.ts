#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodePacket, hexToBytes } from '../core/decoder.js';
import { encode } from '../core/encoder.js';
import { OscError } from '../core/errors.js';
import { LIMITS } from '../core/limits.js';
import { verifyPacket } from '../core/verify.js';
import type { FieldInfo, NodeInfo } from '../core/types.js';
import { ReportStore } from '../db/store.js';

const DATA_DIR = process.env.OSC_DATA_DIR ?? join(process.cwd(), 'data');
mkdirSync(DATA_DIR, { recursive: true });

function usage(): void {
  console.log(`osc-lab — 离线 OSC 编解码核验 CLI

用法:
  osc-lab encode --node <file.json|-> [--save] [--note <文本>] [--out <file.bin|.hex>]
  osc-lab decode --hex <十六进制> | --file <路径> [--save] [--note <文本>]
  osc-lab verify --hex <十六进制> | --file <路径>
  osc-lab offset --hex <十六进制> | --file <路径> --at <偏移>
  osc-lab save --hex <十六进制> | --file <路径> [--group <id>] [--note <文本>]
  osc-lab reports [--limit <n>]
  osc-lab get <id>
  osc-lab group <groupId>
  osc-lab export <id> --format hex|json|bin [--out <路径>]
  osc-lab limits

限制: 包<=1MiB, 字符串<=64KiB, blob<=64KiB, 嵌套深度<=16
`);
}

type Args = { _: string[] } & Record<string, string | boolean | string[]>;

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function inputBytes(args: Args): Uint8Array {
  if (args.hex) return hexToBytes(String(args.hex));
  if (args.file) {
    const data = readFileSync(String(args.file));
    if (data.length > LIMITS.maxPacketSize) throw new OscError('FILE_TOO_LARGE', '文件超过包大小上限');
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new OscError('INVALID_REQUEST', '需要 --hex 或 --file');
}

function renderTree(info: NodeInfo, indent = ''): void {
  if (info.kind === 'message') {
    console.log(`${indent}消息 ${info.path || '/'} [${info.start}..${info.end}) ${info.length}B  地址=${info.address}`);
  } else {
    console.log(`${indent}Bundle ${info.path || '/'} [${info.start}..${info.end}) ${info.length}B  timetag=${info.timetag}${info.timetag === '1' ? ' (立即)' : ''}`);
  }
  for (const c of info.children) renderTree(c, `${indent}  `);
}

function renderFields(fields: FieldInfo[]): void {
  console.log('偏移表:');
  console.log('  start   end  pad  path'.padEnd(70) + 'value');
  for (const f of fields) {
    const v = f.value === undefined ? '' : typeof f.value === 'string' && f.value.length > 32 ? f.value.slice(0, 29) + '...' : String(f.value);
    console.log(
      `${String(f.start).padStart(6)} ${String(f.end).padStart(6)} ${String(f.padding).padStart(4)}  ${f.path}`.padEnd(70) + v,
    );
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] ?? '');
  const store = new ReportStore(join(DATA_DIR, 'osc-reports.db'));
  try {
    switch (cmd) {
      case 'encode': {
        const raw = args.node === '-' || args.node === true ? readFileSync(0, 'utf8') : readFileSync(String(args.node), 'utf8');
        let node: unknown;
        try {
          node = JSON.parse(raw);
        } catch {
          throw new OscError('INVALID_JSON', '节点 JSON 解析失败');
        }
        const { bytes } = encode(node as never);
        const report = decodePacket(bytes);
        console.log('hex:', report.hex);
        console.log('大小:', bytes.length, '字节');
        if (report.tree) renderTree(report.tree);
        renderFields(report.fields);
        if (args.out) {
          const p = String(args.out);
          if (p.endsWith('.hex')) writeFileSync(p, report.hex, 'utf8');
          else writeFileSync(p, bytes);
          console.log('已写出:', p);
        }
        if (args.save) {
          const row = store.saveReport(report, { note: args.note ? String(args.note) : undefined });
          console.log(`已保存报告 id=${row.id} group=${row.group_id} revision=${row.revision}`);
        }
        return;
      }
      case 'decode': {
        const report = decodePacket(inputBytes(args));
        console.log(`valid=${report.valid} 大小=${report.packetSize} 解析版本=${report.parserVersion}`);
        if (report.tree) renderTree(report.tree);
        renderFields(report.fields);
        for (const d of report.diagnostics) {
          console.log(`[${d.severity}] ${d.code} offset=${d.offset ?? '-'} path=${d.path ?? '-'} ${d.message}`);
        }
        if (args.save) {
          const row = store.saveReport(report, { note: args.note ? String(args.note) : undefined });
          console.log(`已保存报告 id=${row.id} group=${row.group_id} revision=${row.revision} valid=${row.valid}`);
        }
        return;
      }
      case 'verify': {
        const r = verifyPacket(inputBytes(args));
        console.log(`valid=${r.valid} roundtrip=${r.roundtrip} 大小=${r.packetSize}`);
        if (r.tree) renderTree(r.tree);
        for (const d of r.diagnostics) console.log(`[${d.severity}] ${d.code} offset=${d.offset ?? '-'} ${d.message}`);
        if (!r.valid) process.exitCode = 2;
        return;
      }
      case 'offset': {
        if (typeof args.at !== 'string') throw new OscError('INVALID_REQUEST', '需要 --at <偏移>');
        const at = Number(args.at);
        const report = decodePacket(inputBytes(args));
        const hits = report.fields.filter((f) => at >= f.start && at < f.end);
        console.log(`偏移 ${at} 落在 ${hits.length} 个字段内:`);
        for (const f of hits) console.log(`  ${f.path} [${f.start}..${f.end}) value=${String(f.value)}`);
        return;
      }
      case 'save': {
        const report = decodePacket(inputBytes(args));
        const row = store.saveReport(report, {
          groupId: args.group ? Number(args.group) : undefined,
          note: args.note ? String(args.note) : undefined,
        });
        console.log(`已保存 id=${row.id} group=${row.group_id} revision=${row.revision} valid=${row.valid}`);
        return;
      }
      case 'reports': {
        const rows = store.listReports(args.limit ? Number(args.limit) : 50);
        for (const r of rows) {
          console.log(`id=${r.id} group=${r.group_id} rev=${r.revision} valid=${r.valid} size=${r.packet_size} note=${r.note ?? ''}`);
        }
        return;
      }
      case 'get': {
        const row = store.get(Number(args._[1]));
        if (!row) throw new OscError('FILE_NOT_FOUND', '报告不存在');
        console.log(JSON.stringify(JSON.parse(row.report_json), null, 2));
        return;
      }
      case 'group': {
        const rows = store.listGroup(Number(args._[1]));
        for (const r of rows) console.log(`id=${r.id} rev=${r.revision} valid=${r.valid} size=${r.packet_size}`);
        return;
      }
      case 'export': {
        const id = Number(args._[1]);
        const format = String(args.format ?? 'json') as 'hex' | 'json' | 'bin';
        const row = store.get(id);
        if (!row) throw new OscError('FILE_NOT_FOUND', '报告不存在');
        if (format === 'json') process.stdout.write(JSON.stringify(JSON.parse(row.report_json), null, 2));
        else if (format === 'hex') process.stdout.write(row.raw_hex);
        else process.stdout.write(Buffer.from(hexToBytes(row.raw_hex)));
        if (args.out) {
          if (format === 'bin') writeFileSync(String(args.out), Buffer.from(hexToBytes(row.raw_hex)));
          else if (format === 'hex') writeFileSync(String(args.out), row.raw_hex, 'utf8');
          else writeFileSync(String(args.out), JSON.stringify(JSON.parse(row.report_json), null, 2), 'utf8');
          console.error('已写出:', args.out);
        }
        return;
      }
      case 'limits':
        console.log(JSON.stringify(LIMITS, null, 2));
        return;
      default:
        usage();
        if (cmd) process.exitCode = 2;
    }
  } catch (e) {
    if (e instanceof OscError) {
      console.error(`错误 [${e.code}]${e.offset !== undefined ? ` offset=${e.offset}` : ''}${e.path ? ` path=${e.path}` : ''}: ${e.message}`);
      process.exitCode = 1;
    } else {
      console.error('错误:', (e as Error).message);
      process.exitCode = 1;
    }
  } finally {
    store.close();
  }
}

main();
