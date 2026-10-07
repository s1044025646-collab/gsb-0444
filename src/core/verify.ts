import { decodePacket } from './decoder.js';
import { encode } from './encoder.js';
import type { Diagnostic, FieldInfo, NodeInfo } from './types.js';

export interface VerifyResult {
  valid: boolean;
  packetSize: number;
  diagnostics: Diagnostic[];
  tree: NodeInfo | null;
  fields: FieldInfo[];
  /** 合法且重编码字节一致 */
  roundtrip: boolean;
  reencodeHex: string | null;
}

/** 包结构核验：解码 + 合法包重编码逐字节一致性检查 */
export function verifyPacket(bytes: Uint8Array): VerifyResult {
  const report = decodePacket(bytes);
  const diagnostics = [...report.diagnostics];
  let roundtrip = false;
  let reencodeHex: string | null = null;
  if (report.valid && report.root) {
    const re = encode(report.root);
    reencodeHex = [...re.bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    roundtrip = re.bytes.length === bytes.length && re.bytes.every((b, i) => b === bytes[i]);
    if (!roundtrip) {
      diagnostics.push({
        severity: 'error',
        code: 'ROUNDTRIP_MISMATCH',
        message: '解码后重新编码的字节与原包不一致',
      });
    }
  }
  return {
    valid: report.valid && roundtrip,
    packetSize: bytes.length,
    diagnostics,
    tree: report.tree,
    fields: report.fields,
    roundtrip,
    reencodeHex,
  };
}
