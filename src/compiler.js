import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, fieldErrors } from './errors.js';

export const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const WORKER_PATH = path.join(moduleDir, 'compile-worker.js');

export const BUNDLED_TWEXT_DIR = path.join(moduleDir, '..', 'node_modules', '@twext', 'twext');
export const BUNDLED_TWEXT_ENTRY = path.join(BUNDLED_TWEXT_DIR, 'src', 'index.js');

function installedTwextDir(dataDir, version) {
  return path.join(dataDir, 'twext-versions', version, 'node_modules', '@twext', 'twext');
}

function installedTwextEntry(dataDir, version) {
  return path.join(installedTwextDir(dataDir, version), 'src', 'index.js');
}

function installedTwextVersion(dataDir, version) {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(installedTwextDir(dataDir, version), 'package.json'), 'utf8'),
    );
    return pkg.version;
  } catch {
    return null;
  }
}

function isBundledTwextAvailable() {
  try {
    readFileSync(BUNDLED_TWEXT_ENTRY);
    return true;
  } catch {
    return false;
  }
}

export async function ensureTwextVersion(config, { consoleLog = console.log } = {}) {
  const version = config.twext?.version;
  if (!version) {
    if (!isBundledTwextAvailable()) {
      throw new Error(
        'No bundled @twext/twext is installed; run "npm install" or set twext.version in config.',
      );
    }
    return BUNDLED_TWEXT_ENTRY;
  }
  if (installedTwextVersion(config.dataDir, version) === version) {
    return installedTwextEntry(config.dataDir, version);
  }
  const versionsDir = path.join(config.dataDir, 'twext-versions');
  await mkdir(versionsDir, { recursive: true });
  const target = path.join(versionsDir, version);
  consoleLog(
    `Installing @twext/twext@${version} into ${target} (set config twext.version or TWEXTHUB_TWEXT_VERSION to pin a version)...`,
  );
  const result = spawnSync(
    'npm',
    [
      'install',
      `@twext/twext@${version}`,
      '--prefix',
      target,
      '--no-save',
      '--no-audit',
      '--no-fund',
      '--silent',
      '--loglevel=error',
    ],
    { stdio: 'inherit', env: process.env, timeout: 300_000 },
  );
  if (result.status !== 0) {
    throw new Error(
      `Failed to install @twext/twext@${version} (npm exited ${result.status}). Check that the version exists and npm is on PATH.`,
    );
  }
  if (installedTwextVersion(config.dataDir, version) !== version) {
    throw new Error(`@twext/twext@${version} did not install into ${target}.`);
  }
  return installedTwextEntry(config.dataDir, version);
}

const FORBIDDEN_SOURCE_KEYS = new Map([
  ['twext.yml', 'the published manifest'],
  ['package.json', 'a package.json (the registry writes its own)'],
  ['node_modules', 'the node_modules directory'],
]);

export function resolveSourcePath(rel) {
  if (typeof rel !== 'string' || rel.length === 0) {
    throw fieldErrors([{ field: 'sources', message: 'Source paths must be non-empty strings.' }]);
  }
  if (rel.includes('\0') || rel.includes('\r') || rel.includes('\n')) {
    throw fieldErrors([
      { field: 'sources', message: `Source path ${JSON.stringify(rel)} is invalid.` },
    ]);
  }
  const normalized = path.normalize(rel.replace(/\\/g, '/'));
  const firstSegment = normalized.split('/')[0];
  for (const [prefix, label] of FORBIDDEN_SOURCE_KEYS) {
    if (firstSegment === prefix) {
      throw fieldErrors([
        { field: 'sources', message: `${JSON.stringify(rel)} is reserved (${label}).` },
      ]);
    }
  }
  if (
    firstSegment === '.' ||
    firstSegment === '..' ||
    path.isAbsolute(normalized) ||
    normalized.startsWith('..')
  ) {
    throw fieldErrors([
      {
        field: 'sources',
        message: `Source path ${JSON.stringify(rel)} must stay inside the project directory.`,
      },
    ]);
  }
  return normalized;
}

export async function compileProject(config, { manifestSource, sources }) {
  const entry = await ensureTwextVersion(config);
  const runtimeId = path.join('builds', `${Date.now()}-${randomBytes(6).toString('hex')}`);
  const buildDir = path.join(config.dataDir, 'tmp', runtimeId);
  await mkdir(buildDir, { recursive: true });
  const resultPath = path.join(buildDir, 'result.json');
  try {
    await writeFile(path.join(buildDir, 'twext.yml'), manifestSource);
    await writeFile(path.join(buildDir, 'package.json'), '{"type":"module","private":true}\n');
    for (const [rel, content] of Object.entries(sources)) {
      const target = path.join(buildDir, resolveSourcePath(rel));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    const output = await spinWorker({ config, entry, buildDir, resultPath });
    return output;
  } finally {
    await rm(buildDir, { recursive: true, force: true });
  }
}

function spinWorker({ config, entry, buildDir, resultPath }) {
  return new Promise((resolve, reject) => {
    const timeoutMs = (config.twext?.compileTimeoutSeconds ?? 20) * 1000;
    const allowRead = [
      `--allow-fs-read=${buildDir}/*`,
      `--allow-fs-read=${realpathSync(entryRoot(entry))}/*`,
      `--allow-fs-read=${realEntryPackage(entry)}/*`,
      `--allow-fs-read=${realpathSync(WORKER_PATH)}`,
      `--allow-fs-read=${realpathSync(path.join(moduleDir, '..', 'package.json'))}`,
    ];
    const args = [
      '--no-warnings',
      '--permission',
      ...allowRead,
      '--allow-fs-write=' + buildDir + '/*',
      '--max-old-space-size=128',
      WORKER_PATH,
      buildDir,
      entry,
      resultPath,
    ];
    const child = spawn(process.execPath, args, {
      env: { PATH: process.env.PATH ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
      killSignal: 'SIGTERM',
      timeout: timeoutMs,
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      reject(new HttpError(502, { detail: `Failed to start the build sandbox: ${error.message}` }));
    });
    child.on('close', (code, signal) => {
      let result;
      try {
        result = JSON.parse(readFileSync(resultPath, 'utf8'));
      } catch {
        if (code !== 0 || signal) {
          reject(
            new HttpError(502, {
              detail: `The build sandbox ${signal ? `was killed by ${signal}` : `exited with code ${code}`}${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
            }),
          );
          return;
        }
        reject(new HttpError(502, { detail: 'The build sandbox produced no output.' }));
        return;
      }
      if (result.error) {
        reject(
          new HttpError(400, {
            title: 'Invalid publish',
            detail: result.message ?? 'The project failed to compile.',
            errors: result.detailErrors ?? undefined,
          }),
        );
        return;
      }
      if (typeof result.output !== 'string' || result.output.length === 0) {
        reject(new HttpError(502, { detail: 'The build sandbox returned empty output.' }));
        return;
      }
      resolve({
        output: Buffer.from(result.output, 'utf8'),
        warnings: Array.isArray(result.warnings) ? result.warnings : [],
      });
    });
  });
}

function entryRoot(entry) {
  // The node_modules directory holding the compiler package, so every
  // dependency the compiler imports resolves under it (permitting reads).
  return path.dirname(path.dirname(path.dirname(entry)));
}

// The compiler package's real directory. npm can install @twext/twext as a
// symlink (e.g. `npm i file:../twext`), and the ESM loader resolves reads
// against real paths, so the sandbox allow-list must too.
function realEntryPackage(entry) {
  const realEntry = realpathSync(entry);
  return realEntry === entry
    ? path.dirname(path.dirname(entry))
    : path.dirname(path.dirname(realEntry));
}
