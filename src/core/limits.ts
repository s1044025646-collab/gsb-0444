export const LIMITS = {
  /** 原始包最大字节数 */
  maxPacketSize: 1 << 20, // 1 MiB
  /** 字符串 UTF-8 编码后的最大字节数（不含终止零） */
  maxStringBytes: 65536,
  /** blob 数据最大字节数 */
  maxBlobSize: 65536,
  /** bundle 嵌套最大深度（消息记为 1，bundle 深度随嵌套层数） */
  maxDepth: 16,
  /** 时间标签最大值（64 位无符号） */
  maxTimeTag: 18446744073709551615n,
  /** 立即执行时间标签 */
  immediatelyTimeTag: 1n,
  /** 解析版本（解析器结构版本号，持久化于数据库） */
  parserVersion: 1,
} as const;

export type Limits = typeof LIMITS;
