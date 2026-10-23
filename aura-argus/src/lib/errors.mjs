// 统一错误类型与错误码。所有对外抛错都走这里，CLI/HTTP/MCP 各自映射。
export class ArgusError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ArgusError';
    this.code = code;
    this.details = details;
  }
}

export const CODES = {
  BAD_URL: 'BAD_URL',
  BAD_REQUEST: 'BAD_REQUEST',
  TIMEOUT: 'TIMEOUT',
  FETCH_FAILED: 'FETCH_FAILED',
  HTTP_ERROR: 'HTTP_ERROR',
  UNSUPPORTED_CONTENT_TYPE: 'UNSUPPORTED_CONTENT_TYPE',
  TOO_LARGE: 'TOO_LARGE',
  NO_ENTITY: 'NO_ENTITY',
  NO_EVIDENCE: 'NO_EVIDENCE',
  ALL_SOURCES_FAILED: 'ALL_SOURCES_FAILED',
  PRIVATE_ADDRESS: 'PRIVATE_ADDRESS',
  TOO_MANY_REDIRECTS: 'TOO_MANY_REDIRECTS',
  BATCH_BUDGET_EXCEEDED: 'BATCH_BUDGET_EXCEEDED',
  ABORTED: 'ABORTED',
  CACHE_DISABLED: 'CACHE_DISABLED',
};

export function isArgusError(error) {
  return error instanceof ArgusError;
}

export function toErrorPayload(error) {
  if (error instanceof ArgusError) {
    return { ok: false, error: { code: error.code, message: error.message, ...error.details } };
  }
  return { ok: false, error: { code: 'INTERNAL', message: String(error?.message || error) } };
}
