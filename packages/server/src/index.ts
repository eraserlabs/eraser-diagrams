import { buildServer } from './boot.js';

export { buildServer } from './boot.js';
export type { BuiltServer } from './boot.js';

/** Entry point when run directly (not when imported by tests). */
async function main(): Promise<void> {
  const { app, config } = await buildServer();
  await app.listen({ host: config.host, port: config.port });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      app.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
