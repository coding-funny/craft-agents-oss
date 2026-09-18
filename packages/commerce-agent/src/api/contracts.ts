import { z } from 'zod'
import { InvestigationInputSchema } from '../contracts/task.ts'

export const CreateTaskRequestSchema = z.object({ input: InvestigationInputSchema }).strict()
export const ApprovalDecisionRequestSchema = z.object({
  reason: z.string().trim().min(3).max(2_000),
  confirmHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

export type ApiSuccess<T> = { ok: true; data: T; traceId: string }
export type ApiFailure = { ok: false; error: { code: string; message: string }; traceId: string }
