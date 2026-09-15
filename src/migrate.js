import { loadConfig } from './config.js';
import { createDb, ensureDataDirs, runMigrations, seedLegalDocuments } from './db.js';

const args = process.argv.slice(2);
const flagIndex = args.indexOf('--config');
const configPath = flagIndex === -1 ? args[0] : args[flagIndex + 1];
const config = loadConfig(configPath);
ensureDataDirs(config.dataDir);
const sql = createDb(config);
try {
  await runMigrations(sql);
  await seedLegalDocuments(sql);
  console.log('Migrations applied.');
} finally {
  await sql.end();
}
