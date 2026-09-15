import { loadConfig } from './config.js';
import { createDb, ensureDataDirs, runMigrations, seedLegalDocuments } from './db.js';

const configPath = process.argv[2];
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
