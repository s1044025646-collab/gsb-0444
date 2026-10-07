/** 结构化 OSC 输入/输出树 */
export type OscArg =
  | { type: 'i'; value: number }
  | { type: 'f'; value: number }
  | { type: 's'; value: string }
  | { type: 'b'; /** hex 字符串或字节数组 */ value: string | Uint8Array | number[] };

export interface OscMessageNode {
  kind: 'message';
  address: string;
  args: OscArg[];
}

export interface OscBundleNode {
  kind: 'bundle';
  /** 十进制整数字符串，保留原始 64 位值；"1" 表示立即 */
  timetag: string;
  elements: OscNode[];
}

export type OscNode = OscMessageNode | OscBundleNode;

/** 单个字段的偏移与核验信息 */
export interface FieldInfo {
  name: string;
  /** 节点路径，如 /bundle[0]/args[1] */
  path: string;
  start: number;
  end: number;
  length: number;
  /** 填充字节数（字符串/blob/对齐） */
  padding: number;
  /** 实际值（字符串为文本，blob 为 hex，整数/浮点为数字，timetag 为十进制字符串） */
  value?: unknown;
}

export interface NodeInfo {
  kind: 'message' | 'bundle';
  path: string;
  depth: number;
  start: number;
  end: number;
  length: number;
  /** 消息地址（消息节点） */
  address?: string;
  /** 时间标签十进制字符串（bundle） */
  timetag?: string;
  children: NodeInfo[];
}

export interface Diagnostic {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  offset?: number;
  path?: string;
}

export interface ParseReport {
  valid: boolean;
  parserVersion: number;
  packetSize: number;
  root: OscNode | null;
  tree: NodeInfo | null;
  fields: FieldInfo[];
  diagnostics: Diagnostic[];
  hex: string;
}
