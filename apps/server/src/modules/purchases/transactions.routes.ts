import { IdParamSchema, TransactionListQuerySchema } from '@leash/shared';
import { Router } from 'express';
import type { AppContext } from '../../context.js';
import { currentUser } from '../../middleware/session.js';
import { cancelPurchase } from './purchases.service.js';
import { getTransaction, listTransactions } from './transactions.service.js';

export function transactionsRouter({ db }: AppContext): Router {
  const router = Router();

  router.get('/transactions', async (req, res) => {
    const query = TransactionListQuerySchema.parse(req.query);
    res.json(await listTransactions(db, currentUser(req).id, query));
  });

  router.get('/transactions/:id', async (req, res) => {
    const { id } = IdParamSchema.parse(req.params);
    res.json(await getTransaction(db, currentUser(req).id, id));
  });

  /** The user cancels a purchase that is pending approval, authorized, or still being evaluated. */
  router.post('/transactions/:id/cancel', async (req, res) => {
    const { id } = IdParamSchema.parse(req.params);
    const user = currentUser(req);
    await cancelPurchase(db, {
      userId: user.id,
      transactionId: id,
      actor: { type: 'USER', id: user.id },
    });
    res.json(await getTransaction(db, user.id, id));
  });

  return router;
}
