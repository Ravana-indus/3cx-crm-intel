import { z } from 'zod';

export const DECISION_MODEL_VERSION = 'call-decision-v1';

export const dimensionKeys = [
  'financial_readiness',
  'language_readiness',
  'timeline_urgency',
  'intent_seriousness',
] as const;

export const factFields = [
  'funding_source',
  'language_test',
  'language_score',
  'language_level',
  'language_test_date',
  'has_passport',
  'visa_refusal_details',
  'intake',
] as const;

export const objectionTypes = [
  'cost',
  'timing',
  'family',
  'documents',
  'trust',
  'route',
] as const;

const outcomeSchema = z.enum([
  'connected',
  'callback_requested',
  'not_interested',
  'wrong_number',
]);

const verdictSchema = z.enum(['hot', 'warm', 'cold', 'not_interested']);

const nextActionSchema = z.enum([
  'call_now',
  'book_consultation',
  'request_documents',
  'send_information',
  'nurture_long_term',
]);

const dimensionSchema = z
  .object({
    value: z.number().int().min(0).max(4).nullable(),
    evidence: z.string().min(1).nullable(),
    asked: z.boolean(),
  })
  .superRefine((dimension, context) => {
    if (!dimension.asked) {
      if (dimension.value !== null || dimension.evidence !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'asked=false requires value=null and evidence=null',
        });
      }
      return;
    }

    if (dimension.value !== null && !dimension.evidence?.trim()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a value requires verbatim evidence',
        path: ['evidence'],
      });
    }
    if (dimension.value === null && dimension.evidence !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'evidence without a value is not a scored dimension',
        path: ['value'],
      });
    }
  });

const factValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.record(z.unknown()),
]);

const factSchema = z
  .object({
    field: z.enum(factFields),
    value: factValueSchema,
    confidence: z.number().min(0).max(1),
    evidence: z.string().min(1),
    confirmed_by: z.enum(['customer', 'agent', 'document']),
  })
  .superRefine((fact, context) => {
    const fail = (message: string) =>
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message,
        path: ['value'],
      });

    switch (fact.field) {
      case 'funding_source':
        if (
          typeof fact.value !== 'string' ||
          ![
            'self_funded',
            'family_sponsored',
            'loan',
            'employer_sponsored',
            'other',
          ].includes(fact.value)
        ) {
          fail('funding_source must be a closed funding enum');
        }
        break;
      case 'language_test':
        if (
          typeof fact.value !== 'string' ||
          !['ielts', 'pte', 'toefl', 'duolingo', 'none', 'other'].includes(
            fact.value,
          )
        ) {
          fail('language_test must be a closed test enum');
        }
        break;
      case 'language_score':
        if (typeof fact.value !== 'string' && typeof fact.value !== 'number') {
          fail('language_score must be a string or number');
        }
        break;
      case 'language_level':
        if (
          typeof fact.value !== 'string' ||
          !['a1', 'a2', 'b1', 'b2', 'c1', 'c2', 'native'].includes(fact.value)
        ) {
          fail('language_level must be a CEFR level');
        }
        break;
      case 'language_test_date':
        if (
          typeof fact.value !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}$/.test(fact.value)
        ) {
          fail('language_test_date must be YYYY-MM-DD');
        }
        break;
      case 'has_passport':
        if (typeof fact.value !== 'boolean') {
          fail('has_passport must be a boolean');
        }
        break;
      case 'visa_refusal_details':
        if (typeof fact.value !== 'string') {
          fail('visa_refusal_details must be a string');
        }
        break;
      case 'intake':
        if (
          typeof fact.value !== 'string' &&
          (fact.value === null ||
            typeof fact.value !== 'object' ||
            Array.isArray(fact.value))
        ) {
          fail('intake must be a string or object');
        }
        break;
    }
  });

const objectionSchema = z.object({
  type: z.enum(objectionTypes),
  quote: z.string().min(1),
  resolved: z.boolean(),
});

const callbackSchema = z.object({
  requested: z.boolean(),
  at: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), 'at must be ISO time')
    .nullable(),
  spoken_as: z.string().nullable(),
});

export const decisionSchema = z
  .object({
    call_id: z.string().min(1),
    model_version: z.string().min(1),
    outcome: outcomeSchema.nullable(),
    outcome_confidence: z.number().min(0).max(1).default(0),
    verdict: verdictSchema.nullable(),
    verdict_reason: z.string().max(140).nullable(),
    dimension_signals: z.object({
      financial_readiness: dimensionSchema,
      language_readiness: dimensionSchema,
      timeline_urgency: dimensionSchema,
      intent_seriousness: dimensionSchema,
    }),
    facts: z.array(factSchema).default([]),
    objections: z.array(objectionSchema).default([]),
    competitors: z.array(z.string().min(1)).default([]),
    next_action: nextActionSchema.nullable(),
    next_action_confidence: z.number().min(0).max(1).default(0),
    callback: callbackSchema,
  })
  .superRefine((decision, context) => {
    if (decision.verdict !== null && !decision.verdict_reason?.trim()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'verdict requires verdict_reason',
        path: ['verdict_reason'],
      });
    }
    if (decision.verdict === null && decision.verdict_reason !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'verdict=null requires verdict_reason=null',
        path: ['verdict_reason'],
      });
    }
    if (decision.callback.requested && !decision.callback.at) {
      // spoken_as is allowed as a softer callback commitment, but a requested
      // callback with no time must be explicit in the model output.
      if (!decision.callback.spoken_as?.trim()) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'requested callback needs at or spoken_as',
          path: ['callback'],
        });
      }
    }
  });

export type DecisionPayload = z.infer<typeof decisionSchema>;
