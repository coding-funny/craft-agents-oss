export const COMMERCE_ERROR_CODES = [
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'UPSTREAM_TIMEOUT',
  'RATE_LIMITED',
  'SCOPE_DENIED',
  'TOOL_NOT_ALLOWED',
  'TOOL_SCHEMA_INVALID',
  'PROVIDER_UNAVAILABLE',
  'MODEL_PROTOCOL_ERROR',
  'CONTEXT_LIMIT',
  'BUDGET_EXCEEDED',
  'LOOP_DETECTED',
  'REPORT_NOT_VALIDATED',
  'STORAGE_UNAVAILABLE',
  'PROCESS_INTERRUPTED',
  'INTERNAL',
] as const

export type CommerceErrorCode = (typeof COMMERCE_ERROR_CODES)[number]

export class CommerceError extends Error {
  readonly code: CommerceErrorCode
  readonly details?: Record<string, unknown>

  constructor(code: CommerceErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'CommerceError'
    this.code = code
    this.details = details
  }
}

export function invalidArgument(message: string, details?: Record<string, unknown>): CommerceError {
  return new CommerceError('INVALID_ARGUMENT', message, details)
}
