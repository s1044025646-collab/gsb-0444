export type OscErrorCode =
  | 'EMPTY_PACKET'
  | 'PACKET_TOO_LARGE'
  | 'ALIGNMENT_ERROR'
  | 'OUT_OF_BOUNDS'
  | 'TRUNCATED_PACKET'
  | 'BAD_BUNDLE_MARKER'
  | 'BAD_ADDRESS'
  | 'BAD_TYPE_TAG_START'
  | 'UNKNOWN_TYPE'
  | 'ARG_COUNT_MISMATCH'
  | 'ARG_TYPE_MISMATCH'
  | 'INT_OUT_OF_RANGE'
  | 'FLOAT_NOT_FINITE'
  | 'FLOAT32_OVERFLOW'
  | 'STRING_EMBEDDED_NUL'
  | 'STRING_TOO_LONG'
  | 'BLOB_TOO_LARGE'
  | 'BAD_UTF8'
  | 'NONZERO_PADDING'
  | 'ELEMENT_NOT_ALIGNED'
  | 'ELEMENT_LENGTH_NONPOSITIVE'
  | 'ELEMENT_OUT_OF_BOUNDS'
  | 'ELEMENT_TRAILING_BYTES'
  | 'MESSAGE_TRAILING_BYTES'
  | 'NESTING_TOO_DEEP'
  | 'BAD_TIMETAG'
  | 'INVALID_HEX'
  | 'FILE_NOT_FOUND'
  | 'FILE_TOO_LARGE'
  | 'INVALID_JSON'
  | 'INVALID_REQUEST';

export class OscError extends Error {
  readonly code: OscErrorCode;
  readonly offset?: number;
  readonly path?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: OscErrorCode,
    message: string,
    fields: { offset?: number; path?: string; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'OscError';
    this.code = code;
    if (fields.offset !== undefined) this.offset = fields.offset;
    if (fields.path !== undefined) this.path = fields.path;
    this.details = fields.details;
  }
}
