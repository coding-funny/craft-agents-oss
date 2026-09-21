const sensitiveKey = /(authorization|cookie|password|secret|token|api.?key|credential)/i

export function redactForLog(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]'
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redactForLog(item, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, sensitiveKey.test(key) ? '[REDACTED]' : redactForLog(child, depth + 1)]))
  if (typeof value === 'string') return value.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, '$1[REDACTED]').slice(0, 8_000)
  return value
}
