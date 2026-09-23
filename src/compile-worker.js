import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Runs inside a permission-restricted child process owned by compiler.js.
// Reads the uploaded project from buildDir, validates and compiles it with
// the pinned twext package, and writes the verdict to resultPath as JSON.
const [buildDir, entry, resultPath] = process.argv.slice(2);

let result;
try {
  const module = await import(pathToFileURL(entry).href);
  const { validateProject } = module;
  const { loadProduct } = module;
  const { compileExtension } = module;

  const product = loadProduct();
  const validation = await validateProject(path.join(buildDir, 'twext.yml'));
  if (!validation.ok) {
    result = {
      error: 'validation',
      message: (validation.errors ?? []).join(' '),
      detailErrors: validation.errors,
    };
  } else if (!validation.project) {
    result = { error: 'load', message: 'The project could not be loaded.' };
  } else {
    const output = compileExtension(validation.project, product);
    writeFileSync(path.join(buildDir, 'compiled.js'), output);
    result = { output, warnings: validation.warnings ?? [] };
  }
} catch (error) {
  result = { error: 'compile', message: String(error?.message ?? error).slice(0, 4000) };
}

try {
  writeFileSync(resultPath, JSON.stringify(result));
} catch {
  // The result file is only meaningful when the sandbox can write it.
}
process.exit(0);
