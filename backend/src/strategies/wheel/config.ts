import { z } from 'zod';

/** No ticker or allocation is silently selected for a new account. */
export const wheelConfigSchema = z
  .object({
    symbol: z
      .string()
      .trim()
      .regex(/^[A-Z][A-Z0-9.]{0,15}$/),
    allocation: z.number().finite().positive(),
    maxContracts: z.number().int().min(1).max(10).default(1),
    minDte: z.number().int().min(1).max(90).default(21),
    maxDte: z.number().int().min(1).max(120).default(45),
    targetDelta: z.number().min(0.05).max(0.5).default(0.2),
    minPremium: z.number().finite().min(0.01).default(0.1),
    minOpenInterest: z.number().int().min(1).default(100),
    maxSpreadPercent: z.number().positive().max(1).default(0.25),
    maxQuoteAgeSeconds: z.number().int().min(1).max(120).default(30),
  })
  .strict()
  .refine((c) => c.maxDte >= c.minDte, { message: 'maxDte must be at least minDte' });

export type WheelConfig = z.infer<typeof wheelConfigSchema>;
