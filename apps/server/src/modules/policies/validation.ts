import { PolicyDocumentSchema, type PolicyDocument } from '@leash/shared';
import { sha256Hex } from '../../lib/crypto.js';
import { canonicalJson } from '../audit/canonicalJson.js';

export interface PolicyValidationError {
  path: string;
  message: string;
}

export type PolicyValidationResult =
  | { valid: true; document: PolicyDocument; rulesHash: string }
  | { valid: false; errors: PolicyValidationError[] };

/**
 * Deterministic validation of a policy document, whatever produced it (the
 * LLM compiler or a person editing JSON): structure via the DSL schema, then
 * references — every merchant ID must be one of the user's own merchants.
 */
export function validatePolicyDocument(
  raw: unknown,
  ownMerchantIds: ReadonlySet<string>,
): PolicyValidationResult {
  const parsed = PolicyDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map((i) => ({
        path: i.path.join('.') || '(root)',
        message: i.message,
      })),
    };
  }
  const errors: PolicyValidationError[] = [];
  parsed.data.rules.forEach((rule, i) => {
    if (rule.type === 'merchant_allowlist' || rule.type === 'merchant_blocklist') {
      rule.merchantIds.forEach((id, j) => {
        if (!ownMerchantIds.has(id)) {
          errors.push({ path: `rules.${i}.merchantIds.${j}`, message: `unknown merchant ${id}` });
        }
      });
    }
  });
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, document: parsed.data, rulesHash: policyRulesHash(parsed.data) };
}

/** SHA-256 of the canonical JSON form; what the user confirms against. */
export function policyRulesHash(document: PolicyDocument): string {
  return sha256Hex(canonicalJson(document));
}
