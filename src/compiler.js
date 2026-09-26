import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_LOG_BYTES = 16384;

// The bundled compiler lives behind @twext/twext's package "exports" watch,
// so it cannot be imported by specifier; spawn it by absolute path instead.
// TWEXTHUB_COMPILER lets an operator substitute their own compiler binary.
export function compilerCommand(config) {
  if (config.compiler?.command) return config.compiler.command;
  return path.join(HERE, '..', 'node_modules', '@twext', 'twext', 'src', 'cli.js');
}

// Uploaded project code runs in this child, so it gets an allowlist rather than
// the server's environment: the database URL and any other credential the host
// passes in stay here. `twext build` needs nothing else to do its job.
const ALLOWED_ENV = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ'];

export function compilerEnv(env = process.env) {
  const allowed = { NO_COLOR: '1' };
  for (const name of ALLOWED_ENV) {
    if (env[name] !== undefined) allowed[name] = env[name];
  }
  return allowed;
}

function capLog(text) {
  const truncated = text.length - 8;
  if (truncated <= MAX_LOG_BYTES) return text;
  return `… (${truncated} more lines cut) ${text.slice(-MAX_LOG_BYTES)}`;
}

// Compile an extracted project in place. Runs `twext build` in a child process
// with filesystem, memory, and wall-time limits; returns the compiled bytes and
// the build log. `outFile` is forced so a twext.yml with outputPath cannot move
// the build outside the sandbox directory.
export function compileProject(config, projectDir, { outFile = null } = {}) {
  return new Promise((resolve) => {
    const cli = compilerCommand(config);
    const output = outFile ?? path.join(projectDir, 'dist', 'extension.js');
    const memoryMb = config.compiler?.memoryMb ?? 192;
    const timeoutMs = config.compiler?.timeoutMs ?? 30_000;

    // The permission model denies reads outside the project and the registry's
    // own dependencies. Node's model does not gate outbound sockets, so egress
    // isolation is left to the deployment boundary (see docs/hosting.md).
    const args = [
      // resourceLimits sets OS rlimits, which cap the process rather than
      // V8's heap, so the heap flag carries the same number: a build that
      // grows past it is reported as an out-of-memory failure instead of
      // being killed mid-write, and buffers outside the heap still hit the
      // rlimit.
      `--max-old-space-size=${memoryMb}`,
      '--permission',
      `--allow-fs-read=${projectDir}`,
      `--allow-fs-read=${path.join(HERE, '..', 'node_modules')}`,
      `--allow-fs-write=${projectDir}`,
      cli,
      'build',
      '-o',
      output,
    ];

    const env = compilerEnv();

    let stdout = '';
    let stderr = '';
    let started = Date.now();

    const child = spawn(process.execPath, args, {
      cwd: projectDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      windowsHide: true,
      resourceLimits: { maxOldGenerationSizeMb: memoryMb },
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      resolve({
        ok: false,
        error: `Could not start the compiler: ${error.message}`,
        log: capLog(`${stdout}\n${stderr}`.trim()),
        durationMs: Date.now() - started,
      });
    });
    child.on('close', async (code, signal) => {
      const log = capLog(`${stdout}${stderr ? `\n${stderr}` : ''}`.trim());
      if (code !== 0 || (signal && signal !== 'SIGTERM')) {
        const reason = signal
          ? `Terminated by ${signal}${signal === 'SIGKILL' ? ' (timed out or out of memory)' : ''}.`
          : `Compiler exited with code ${code}.`;
        resolve({
          ok: false,
          error: reason,
          log,
          durationMs: Date.now() - started,
        });
        return;
      }
      try {
        const codeBuffer = await readFile(output);
        resolve({
          ok: true,
          code: codeBuffer,
          size: codeBuffer.length,
          log,
          durationMs: Date.now() - started,
        });
      } catch (error) {
        resolve({
          ok: false,
          error: `The compiler reported success but produced no output: ${error.message}`,
          log,
          durationMs: Date.now() - started,
        });
      }
    });
  });
}
