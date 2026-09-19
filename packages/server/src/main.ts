import { createApp } from './api/app.js';
import { createContext } from './api/context.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';

async function main(): Promise<void> {
  const ctx = await createContext();
  const app = createApp(ctx);

  const server = app.listen(env.port, env.host, () => {
    logger.info('window api listening', {
      url: `http://${env.host}:${env.port}`,
      env: env.nodeEnv,
    });
  });

  // In-flight checkout jobs hold merchant sessions and payment intents, so a
  // shutdown drains rather than severing.
  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutting down', { signal });
    server.close();
    await ctx.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  logger.error('failed to start', { error: (error as Error).message, stack: (error as Error).stack });
  process.exit(1);
});
