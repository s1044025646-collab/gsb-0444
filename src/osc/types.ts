/** 结构化输入：消息 */
export interface MessageInput {
  type: "message";
  address: string;
  args: ArgInput[];
}

/** 结构化输入：bundle */
export interface BundleInput {
  type: "bundle";
  /** 十进制无符号 64 位整数字符串，"1" 表示立即 */
  timetag: string;
  elements: PacketInput[];
}

export type PacketInput = MessageInput | BundleInput;

export type ArgInput =
  | { type: "i"; value: number }
  | { type: "f"; value: number }
  | { type: "s"; value: string }
  | { type: "b"; value: string }; // hex 字符串

/** 解码后的参数值（blob 用 hex 表示） */
export type ArgValue =
  | { type: "i"; value: number }
  | { type: "f"; value: number }
  | { type: "s"; value: string }
  | { type: "b"; value: string };

/** 字段级偏移信息 */
export interface FieldInfo {
  name: string;
  offset: number;
  length: number;
  padding: number;
  value?: string | number;
}

export interface NodeInfo {
  kind: "message" | "bundle";
  offset: number;
  length: number;
  fields: FieldInfo[];
  address?: string;
  args?: ArgValue[];
  timetag?: string;
  children?: NodeInfo[];
}

export interface Diagnostic {
  ok: boolean;
  code?: string;
  message?: string;
  offset?: number;
}

export interface DecodeResult {
  ok: boolean;
  tree?: NodeInfo;
  diagnostics: Diagnostic[];
}
