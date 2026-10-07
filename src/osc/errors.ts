export type OscErrorCode =
  | "OSC_INVALID_ADDRESS"
  | "OSC_INVALID_TYPETAG"
  | "OSC_UNKNOWN_TYPE"
  | "OSC_ARG_COUNT"
  | "OSC_ARG_TYPE"
  | "OSC_INT_RANGE"
  | "OSC_FLOAT_NONFINITE"
  | "OSC_FLOAT_OVERFLOW"
  | "OSC_STRING_NUL"
  | "OSC_STRING_UNICODE"
  | "OSC_UTF8_INVALID"
  | "OSC_PADDING_NONZERO"
  | "OSC_TRUNCATED"
  | "OSC_BAD_BUNDLE_HEADER"
  | "OSC_BAD_TIMETAG"
  | "OSC_ELEMENT_SIZE"
  | "OSC_ELEMENT_ALIGN"
  | "OSC_ELEMENT_BOUNDS"
  | "OSC_TRAILING_BYTES"
  | "OSC_DEPTH_EXCEEDED"
  | "OSC_LIMIT_EXCEEDED"
  | "OSC_BAD_HEX"
  | "OSC_BAD_INPUT";

export class OscError extends Error {
  readonly code: OscErrorCode;
  readonly offset?: number;
  constructor(code: OscErrorCode, message: string, offset?: number) {
    super(message);
    this.name = "OscError";
    this.code = code;
    this.offset = offset;
  }
}

export function isOscError(e: unknown): e is OscError {
  return e instanceof OscError;
}
