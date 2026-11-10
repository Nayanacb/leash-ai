import { z } from 'zod';
import { TaskStatusSchema } from '../enums.js';
import { CurrencySchema, MoneyInputSchema } from '../money.js';
import { MerchantCategorySchema } from './merchants.js';
import { IsoDateTimeSchema, plainText } from './common.js';

/** Tasks may run for at most this long. */
export const MAX_TASK_DURATION_DAYS = 90;

export const CreateTaskInputSchema = z.object({
  instruction: plainText(1, 2000),
  budget: MoneyInputSchema,
  agentId: z.uuid(),
  allowedMerchantIds: z
    .array(z.uuid())
    .min(1, 'Choose at least one merchant')
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length, 'Merchants must be unique'),
  expiresAt: IsoDateTimeSchema,
});
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

export const TaskListQuerySchema = z.object({
  status: TaskStatusSchema.optional(),
});

export const TaskMerchantDtoSchema = z.object({
  id: z.uuid(),
  displayName: z.string(),
  category: MerchantCategorySchema,
  archived: z.boolean(),
});

export const TaskDtoSchema = z.object({
  id: z.uuid(),
  instruction: z.string(),
  budgetMinor: z.number().int(),
  currency: CurrencySchema,
  committedMinor: z.number().int(),
  remainingMinor: z.number().int(),
  agent: z.object({ id: z.uuid(), name: z.string() }),
  allowedMerchants: z.array(TaskMerchantDtoSchema),
  /** Effective status: an ACTIVE task past its expiry is reported as EXPIRED. */
  status: TaskStatusSchema,
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TaskDto = z.infer<typeof TaskDtoSchema>;

export const TaskListResponseSchema = z.object({ tasks: z.array(TaskDtoSchema) });

/** What an agent sees: no payee details, no other agents, nothing it could use to change the mandate. */
export const AgentTaskDtoSchema = z.object({
  id: z.uuid(),
  instruction: z.string(),
  budgetMinor: z.number().int(),
  remainingMinor: z.number().int(),
  currency: CurrencySchema,
  status: TaskStatusSchema,
  expiresAt: z.string().nullable(),
  allowedMerchants: z.array(
    z.object({ id: z.uuid(), displayName: z.string(), category: MerchantCategorySchema }),
  ),
});
export type AgentTaskDto = z.infer<typeof AgentTaskDtoSchema>;
