export const LIMITS = {
  /** 单个 OSC 包最大字节数 */
  MAX_PACKET_SIZE: 65536,
  /** 单个字符串（地址 / 类型标记 / s 参数）最大 UTF-8 字节数，不含终止零 */
  MAX_STRING_BYTES: 8192,
  /** 单个 blob 最大数据字节数 */
  MAX_BLOB_BYTES: 32768,
  /** bundle 最大嵌套深度（最外层 bundle 深度为 1） */
  MAX_DEPTH: 32,
  /** 单个 bundle 最大元素个数 */
  MAX_ELEMENTS: 1024,
} as const;

export const PARSER_VERSION = "osc-codec/1.0.0";
