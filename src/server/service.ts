import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { decodePacket, hexToBytes } from '../core/decoder.js';
import { encode } from '../core/encoder.js';
import { OscError } from '../core/errors.js';
import { LIMITS } from '../core/limits.js';
import { verifyPacket } from '../core/verify.js';
import type { OscNode, ParseReport } from '../core/types.js';
import { ReportStore } from '../db/store.js';

export interface EncodeResponse {
  hex: string;
  bytes: number[];
  size: number;
  report: ParseReport;
}

function loadInputBytes(input: { hex?: string; file?: string }): Uint8Array {
  if (input.hex !== undefined && input.file !== undefined) {
    throw new OscError('INVALID_REQUEST', 'hex 与 file 只能提供一个');
  }
  if (input.hex !== undefined) return hexToBytes(input.hex);
  if (input.file !== undefined) {
    if (typeof input.file !== 'string' || input.file.length === 0) {
      throw new OscError('INVALID_REQUEST', 'file 必须为非空路径');
    }
    let data: Buffer;
    try {
      data = readFileSync(input.file);
    } catch (e) {
      throw new OscError('FILE_NOT_FOUND', `无法读取文件: ${input.file} (${(e as Error).message})`);
    }
    if (data.length > LIMITS.maxPacketSize) {
      throw new OscError('FILE_TOO_LARGE', `文件大小 ${data.length} 超过上限 ${LIMITS.maxPacketSize}`);
    }
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new OscError('INVALID_REQUEST', '必须提供 hex 或 file');
}

export class OscService {
  constructor(private store: ReportStore) {}

 encodeNode(root: unknown): EncodeResponse {
    const { bytes } = encode(root as OscNode);
    const report = decodePacket(bytes);
    return {
      hex: report.hex,
      bytes: [...bytes],
      size: bytes.length,
      report,
    };
  }

  decode(input: unknown): ParseReport {
    const body = (input ?? {}) as { hex?: string; file?: string };
    return decodePacket(loadInputBytes(body));
  }

  verify(input: unknown) {
    const body = (input ?? {}) as { hex?: string; file?: string };
    return verifyPacket(loadInputBytes(body));
  }

  saveReport(report: ParseReport, opts: { groupId?: number; note?: string }) {
    return this.store.saveReport(report, opts);
  }

  /** 修订：基于已有组保存新输入的新版本 */
  revise(input: unknown, groupId: number, note?: string) {
    const report = this.decode(input);
    return this.store.saveReport(report, { groupId, note });
  }

 getReport(id: number) {
    const row = this.store.get(id);
    if (!row) throw new OscError('FILE_NOT_FOUND', `报告不存在: ${id}`);
    return row;
  }

  listReports(limit?: number) {
    return this.store.listReports(limit);
  }

  listGroup(groupId: number) {
    return this.store.listGroup(groupId);
  }

  exportReport(id: number, format: 'hex' | 'json' | 'bin', outFile?: string): { mime: string; data: string | Buffer; filename?: string } {
    const row = this.getReport(id);
    if (format === 'hex') {
      const data = row.raw_hex;
      if (outFile) writeFileSync(outFile, data, 'utf8');
      return { mime: 'text/plain', data, filename: outFile };
    }
    if (format === 'json') {
      const data = JSON.stringify(JSON.parse(row.report_json), null, 2);
      if (outFile) writeFileSync(outFile, data, 'utf8');
      return { mime: 'application/json', data, filename: outFile };
    }
    const data = Buffer.from(hexToBytes(row.raw_hex));
    if (outFile) writeFileSync(outFile, data);
    return { mime: 'application/octet-stream', data, filename: outFile };
  }

  /** 查询覆盖某偏移的所有字段（逐节点偏移查询） */
  queryOffset(report: ParseReport, offset: number) {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new OscError('INVALID_REQUEST', 'offset 必须为非负整数');
    }
    return report.fields.filter((f) => offset >= f.start && offset < f.end);
  }
}

export function resolveDataPath(p: string): string {
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}
