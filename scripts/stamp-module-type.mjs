/**
 * Tell Node which module system each build directory is.
 *
 * The package is `"type": "module"`, so every `.js` under it is ESM unless something says
 * otherwise — and `dist/cjs` is not. A nearest-package.json marker is how Node is told, and
 * it is why the CommonJS half can keep the `.js` extension rather than needing `.cjs`.
 *
 * These two files are build output. They are written here rather than committed, because a
 * committed marker in a gitignored directory is a file nobody can see and everybody trusts.
 */
import { writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(dirname(fileURLToPath(import.meta.url))), 'dist');

for (const [dir, type] of [
  ['esm', 'module'],
  ['cjs', 'commonjs'],
]) {
  const target = join(dist, dir);

  if (!existsSync(target)) {
    console.error(`stamp-module-type: ${target} does not exist — did the build run?`);
    process.exit(1);
  }

  writeFileSync(join(target, 'package.json'), `${JSON.stringify({ type }, null, 2)}\n`);
}
