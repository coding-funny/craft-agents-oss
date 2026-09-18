import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { CurrencySchema, IdentifierSchema, IsoDateTimeSchema, TimeRangeSchema } from '../domain/contracts.ts'
import { CommerceError } from '../domain/errors.ts'

export const InvestigationInputSchema = z.object({
  schemaVersion: z.literal(1),
  question: z.string().trim().min(1).max(8_000),
  scope: z.object({
    shopId: IdentifierSchema.optional(),
    skuIds: z.array(IdentifierSchema).min(1).max(20).transform(values => [...new Set(values)]).optional(),
    baselineWindow: TimeRangeSchema.optional(),
    currentWindow: TimeRangeSchema.optional(),
    currency: CurrencySchema.optional(),
  }).strict().optional(),
}).strict()

export const PrincipalContextSchema = z.object({
  actorId: IdentifierSchema,
  tenantId: IdentifierSchema,
  allowedShopIds: z.array(IdentifierSchema).min(1),
  permissions: z.array(z.enum(['investigate', 'read_evidence', 'read_report'])),
  authSource: z.literal('local-fixture'),
}).strict()

export const ResolvedScopeSchema = z.object({
  shopId: IdentifierSchema,
  skuIds: z.array(IdentifierSchema).min(1).max(20),
  baselineWindow: TimeRangeSchema,
  currentWindow: TimeRangeSchema,
  currency: z.literal('CNY'),
}).strict().superRefine((scope, context) => {
  if (Date.parse(scope.baselineWindow.end) > Date.parse(scope.currentWindow.start)) {
    context.addIssue({ code: 'custom', path: ['currentWindow'], message: 'comparison windows must not overlap' })
  }
  if (scope.baselineWindow.timezone !== scope.currentWindow.timezone) {
    context.addIssue({ code: 'custom', path: ['currentWindow', 'timezone'], message: 'comparison windows must use one timezone' })
  }
})

export type InvestigationInput = z.infer<typeof InvestigationInputSchema>
export type PrincipalContext = z.infer<typeof PrincipalContextSchema>
export type ResolvedScope = z.infer<typeof ResolvedScopeSchema>

export type InvestigationTask = {
  schemaVersion: 1
  taskId: string
  version: number
  tenantId: string
  requestedBy: string
  input: InvestigationInput
  resolvedScope?: ResolvedScope
  asOf: string
  fixtureDigest: string
  createdAt: string
}

export type ClarificationRequest = {
  requestId: string
  expectedTaskVersion: number
  fields: string[]
  question: string
}

export function resolveScope(input: InvestigationInput, principal: PrincipalContext): {
  scope?: ResolvedScope
  missing: string[]
} {
  const scope = input.scope
  const missing: string[] = []
  if (!scope?.shopId) missing.push('scope.shopId')
  if (!scope?.skuIds?.length) missing.push('scope.skuIds')
  if (!scope?.baselineWindow) missing.push('scope.baselineWindow')
  if (!scope?.currentWindow) missing.push('scope.currentWindow')
  if (missing.length > 0) return { missing }
  const completeScope = scope!
  if (!principal.permissions.includes('investigate')) {
    throw new CommerceError('SCOPE_DENIED', 'Principal cannot investigate')
  }
  if (!principal.allowedShopIds.includes(completeScope.shopId!)) {
    throw new CommerceError('SCOPE_DENIED', 'Shop is outside principal scope')
  }
  return {
    missing,
    scope: ResolvedScopeSchema.parse({
      shopId: completeScope.shopId,
      skuIds: completeScope.skuIds,
      baselineWindow: completeScope.baselineWindow,
      currentWindow: completeScope.currentWindow,
      currency: completeScope.currency ?? 'CNY',
    }),
  }
}

export function createInvestigationTask(inputValue: unknown, options: {
  principal: PrincipalContext
  asOf: string
  fixtureDigest: string
  now?: () => Date
  taskId?: string
}): InvestigationTask {
  const input = InvestigationInputSchema.parse(inputValue)
  const principal = PrincipalContextSchema.parse(options.principal)
  const { scope } = resolveScope(input, principal)
  const createdAt = (options.now ?? (() => new Date()))().toISOString()
  const taskId = options.taskId ?? `task_${randomUUID()}`
  return {
    schemaVersion: 1,
    taskId,
    version: 1,
    tenantId: principal.tenantId,
    requestedBy: principal.actorId,
    input,
    resolvedScope: scope,
    asOf: IsoDateTimeSchema.parse(options.asOf),
    fixtureDigest: options.fixtureDigest,
    createdAt,
  }
}

export function stableFixtureDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
