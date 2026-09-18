import { z } from 'zod'

export const FeedbackKindSchema = z.enum([
  'ACCEPT_RECOMMENDATION', 'REJECT_RECOMMENDATION', 'INCORRECT_CONCLUSION', 'MISSING_DATA', 'CORRECTION',
])

export const SubmitFeedbackSchema = z.object({
  taskId: z.string().min(1), reportId: z.string().min(1), reportVersion: z.string().regex(/^[a-f0-9]{64}$/),
  claimId: z.string().min(1).optional(), evidenceId: z.string().min(1).optional(),
  kind: FeedbackKindSchema, notes: z.string().trim().min(3).max(4_000), idempotencyKey: z.string().min(8).max(200),
}).strict()

export type SubmitFeedback = z.infer<typeof SubmitFeedbackSchema>
