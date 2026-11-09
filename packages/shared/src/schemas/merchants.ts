import { z } from 'zod';
import { EmailSchema } from './auth.js';
import { plainText } from './common.js';

/** Fixed category list, shared with the policy DSL (category allow/block rules). */
export const MERCHANT_CATEGORIES = [
  'electronics',
  'office_supplies',
  'software',
  'books',
  'clothing',
  'home',
  'groceries',
  'food_delivery',
  'travel',
  'services',
  'other',
] as const;
export const MerchantCategorySchema = z.enum(MERCHANT_CATEGORIES);
export type MerchantCategory = z.infer<typeof MerchantCategorySchema>;

/** PayPal merchant (payer) IDs are 13 uppercase alphanumerics. */
export const PayPalMerchantIdSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{13}$/, 'PayPal merchant ID must be 13 letters/digits');

export const DomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?!-)([a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$/, 'Enter a domain like shop.example.com');

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === '' ? null : v), schema.nullable().optional());

export const CreateMerchantInputSchema = z.object({
  displayName: plainText(1, 100),
  paypalEmail: EmailSchema,
  paypalMerchantId: optional(PayPalMerchantIdSchema),
  domain: optional(DomainSchema),
  category: MerchantCategorySchema,
});
export type CreateMerchantInput = z.infer<typeof CreateMerchantInputSchema>;

export const UpdateMerchantInputSchema = z
  .object({
    displayName: plainText(1, 100).optional(),
    paypalEmail: EmailSchema.optional(),
    paypalMerchantId: optional(PayPalMerchantIdSchema),
    domain: optional(DomainSchema),
    category: MerchantCategorySchema.optional(),
    archived: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Provide at least one field');
export type UpdateMerchantInput = z.infer<typeof UpdateMerchantInputSchema>;

export const MerchantDtoSchema = z.object({
  id: z.uuid(),
  displayName: z.string(),
  paypalEmail: z.string(),
  paypalMerchantId: z.string().nullable(),
  domain: z.string().nullable(),
  category: MerchantCategorySchema,
  archived: z.boolean(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MerchantDto = z.infer<typeof MerchantDtoSchema>;

export const MerchantListResponseSchema = z.object({ merchants: z.array(MerchantDtoSchema) });
