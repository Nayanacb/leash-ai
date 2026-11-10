import type { AppConfig } from '../config/env.js';
import type { Database } from '../db.js';
import type { Logger } from '../lib/logger.js';
import { sweepReservations } from '../modules/budget/recovery.js';
import { reconcileCapturingPayments } from '../modules/payments/checkout.service.js';
import type { PaymentProvider } from '../modules/payments/provider.js';

export interface BackgroundJobs {
  /** Runs one sweep now (also used at startup). Never overlaps a running sweep. */
  runNow(): Promise<void>;
  /** Stops the timer and waits for a sweep in progress to finish. */
  stop(): Promise<void>;
}

/**
 * In-process scheduler for the reservation sweep. Correctness does not depend
 * on it running in only one process: the sweep itself is safe to run
 * concurrently (see modules/budget/recovery.ts). A dedicated job queue can
 * replace this timer later without changing the sweep.
 */
export function startBackgroundJobs(deps: {
  db: Database;
  config: AppConfig;
  logger: Logger;
  paymentProvider?: PaymentProvider | null;
}): BackgroundJobs {
  const { db, config, logger } = deps;
  const provider = deps.paymentProvider ?? null;
  let inFlight: Promise<void> | null = null;

  const runNow = () => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const result = await sweepReservations(db, {
          evaluationTimeoutMs: config.jobs.evaluationTimeoutMs,
          logger,
        });
        if (result.expired.length || result.reconciled.length || result.failed.length) {
          logger.info(
            {
              expired: result.expired.length,
              reconciled: result.reconciled.length,
              failed: result.failed.length,
            },
            'reservation sweep',
          );
        }
      } catch (err) {
        logger.error({ err }, 'reservation sweep failed');
      }
      try {
        // Purchases left in CAPTURING (pending or unknown outcome) — PayPal is read first.
        const payments = await reconcileCapturingPayments({ db, config, provider, logger });
        if (payments.settled.length || payments.failed.length) {
          logger.info(
            { settled: payments.settled.length, failed: payments.failed.length },
            'payment reconciliation',
          );
        }
      } catch (err) {
        logger.error({ err }, 'payment reconciliation failed');
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const timer = setInterval(() => void runNow(), config.jobs.sweepIntervalMs);
  timer.unref();
  void runNow(); // recover anything left over from a previous crash

  return {
    runNow,
    async stop() {
      clearInterval(timer);
      await inFlight;
    },
  };
}
