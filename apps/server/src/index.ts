import 'dotenv/config';
import pkg from '../package.json' with { type: 'json' };
import { createApp } from './app.js';
import { ConfigError, parseConfig, type AppConfig } from './config/env.js';
import { createDatabase } from './db.js';
import { startBackgroundJobs } from './jobs/scheduler.js';
import { createLogger } from './lib/logger.js';
import { paymentProviderFromConfig } from './modules/payments/paypal/checkout.js';

function loadConfigOrExit(): AppConfig {
  try {
    return parseConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      // The logger is not configured yet; print plainly and refuse to start.
      console.error(`\n[leash] Refusing to start. ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

async function main() {
  const config = loadConfigOrExit();
  const logger = createLogger({ level: config.logLevel, pretty: config.nodeEnv === 'development' });
  const db = createDatabase(config.databaseUrl);

  // One provider instance, so the app and the reconciliation sweep share PayPal's OAuth token.
  const paymentProvider = paymentProviderFromConfig(config);
  const app = createApp({ config, logger, db, version: pkg.version, paymentProvider });
  const server = app.listen(config.port, config.host, () => {
    logger.info(
      {
        url: `http://${config.host}:${config.port}`,
        paypal: { environment: config.paypal.environment, configured: config.paypal.configured },
        llm: { configured: config.llm.configured },
      },
      'Leash server listening',
    );
  });

  const jobs = startBackgroundJobs({ db, config, logger, paymentProvider });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const forceExit = setTimeout(() => process.exit(1), 10_000);
    forceExit.unref();
    server.close(async () => {
      await jobs.stop();
      await db.$disconnect();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('[leash] Fatal error during startup', err);
  process.exit(1);
});
