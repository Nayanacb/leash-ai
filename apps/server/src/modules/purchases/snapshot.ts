import { sha256Hex } from '../../lib/crypto.js';
import { canonicalJson } from '../audit/canonicalJson.js';

/**
 * Everything a human approver is shown and is agreeing to. Hashed at
 * escalation; recomputed from the database at approval time. If anything
 * changed in between — most importantly who gets paid — the hashes differ and
 * the approval is refused ("approve what you saw").
 */
export interface PurchaseSnapshot {
  transactionId: string;
  amountMinor: number;
  currency: string;
  merchantId: string | null;
  /** The merchant's PayPal account (the payee) at the time. */
  payee: string | null;
  itemDescription: string;
  quantity: number;
  taskId: string;
  taskInstruction: string;
  decision: string;
  reasonCodes: readonly string[];
}

export function purchaseSnapshotHash(snapshot: PurchaseSnapshot): string {
  return sha256Hex(canonicalJson({ ...snapshot, reasonCodes: [...snapshot.reasonCodes] }));
}
