import { z } from 'zod';

export const summaryResultSchema = z.object({
  summary: z.string().min(1),
  extracted: z.object({
    caller_intent: z.string().default('unknown'),
    destination: z.string().nullable().default(null),
    service: z.string().nullable().default(null),
    documents_mentioned: z.array(z.string()).default([]),
    next_action: z.string().nullable().default(null),
    follow_up_at: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .default(null),
    sentiment: z.enum(['positive', 'neutral', 'negative']).default('neutral'),
  }),
});

export type ParsedSummaryResult = z.infer<typeof summaryResultSchema>;
