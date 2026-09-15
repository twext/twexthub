import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { product } from './product.js';
import { createApp } from './app.js';
import {
  createDb,
  ensureDataDirs,
  reconcileOnBoot,
  runMigrations,
  seedLegalDocuments,
} from './db.js';

export async function bootstrap(config = loadConfig()) {
  ensureDataDirs(config.dataDir);
  const sql = createDb(config);
  await runMigrations(sql);
  await seedLegalDocuments(sql);
  await reconcileOnBoot(sql, config);
  const { app } = createApp({ config, sql });
  return { app, sql, config };
}

const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const configPath = process.argv[2] ?? product.defaults?.configFilename ?? 'config.yaml';
  const { app, sql, config } = await bootstrap(loadConfig(configPath));
  const server = app.listen(config.port, () => {
    console.log(`${product.name} v${product.version} listening on http://localhost:${config.port}`);
  });
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const force = setTimeout(() => server.closeAllConnections(), 5000);
    await new Promise((resolve) => server.close(resolve));
    clearTimeout(force);
    await sql.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
