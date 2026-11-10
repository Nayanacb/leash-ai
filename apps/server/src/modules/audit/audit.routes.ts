import {
  AuditListQuerySchema,
  type AuditListResponse,
  type AuditVerifyResponse,
} from '@leash/shared';
import { Router } from 'express';
import type { AppContext } from '../../context.js';
import { currentUser } from '../../middleware/session.js';
import { toAuditEventDto, verifyAuditChain } from './auditLog.js';

export function auditRouter({ db, logger }: AppContext): Router {
  const router = Router();

  /** The signed-in user's own audit trail, newest first. */
  router.get('/audit-events', async (req, res) => {
    const { before, limit, action } = AuditListQuerySchema.parse(req.query);
    const events = await db.auditEvent.findMany({
      where: {
        userId: currentUser(req).id,
        ...(before ? { seq: { lt: BigInt(before) } } : {}),
        ...(action ? { action: { startsWith: action } } : {}),
      },
      orderBy: { seq: 'desc' },
      take: limit + 1,
    });
    const page = events.slice(0, limit);
    const body: AuditListResponse = {
      events: page.map(toAuditEventDto),
      nextBefore: events.length > limit ? page[page.length - 1]!.seq.toString() : null,
    };
    res.json(body);
  });

  /**
   * Verifies the whole chain (it is global, so this covers every user's
   * events). Only the verdict is returned — no counts or details that would
   * reveal anything about other users.
   */
  router.get('/audit-events/verify', async (req, res) => {
    const result = await verifyAuditChain(db);
    if (!result.valid) {
      logger.error(
        { brokenAtSeq: result.brokenAtSeq.toString(), reason: result.reason },
        'AUDIT CHAIN INTEGRITY FAILURE',
      );
    }
    const body: AuditVerifyResponse = { valid: result.valid, verifiedAt: new Date().toISOString() };
    res.json(body);
  });

  return router;
}
