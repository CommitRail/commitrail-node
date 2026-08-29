import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rest: string) => path.resolve(here, `src/${rest}`);

/**
 * Read `.env` if there is one, without a dependency for four lines of parsing.
 *
 * A real environment always wins: CI sets DATABASE_URL directly and has no `.env`, and a
 * stale local file must never override what CI is pointed at.
 */
function dotenv(): Record<string, string> {
  const file = path.resolve(here, '.env');
  if (!existsSync(file)) return {};

  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^["']|["']$/g, '')];
      })
      .filter(([key]) => key !== '' && process.env[key] === undefined),
  );
}

export default defineConfig({
  /**
   * Tests import `commitrail` from SOURCE, not from the build output.
   *
   * The package's own `exports` map points at `./dist/*`, which is right for anything that
   * consumes it and wrong for a test: a suite resolving through the exports map asserts
   * against the last build rather than against the code in front of you. Edit a source file,
   * run the tests, watch them pass, and conclude something about code that never ran.
   *
   * The cost of that choice is that nothing here can see a packaging failure — a broken
   * exports map, a file missing from `files`, a CommonJS build that does not load. That is
   * what `pnpm verify:package` is for, and it is a separate job precisely because it needs a
   * current `dist` and this suite never builds one.
   */
  resolve: {
    alias: [
      { find: /^commitrail$/, replacement: src('index.ts') },
      { find: /^commitrail\/(.*)$/, replacement: src('$1.ts') },
    ],
  },
  test: {
    globals: true,
    env: dotenv(),
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 20_000,
    hookTimeout: 20_000,

    // postgres.test.ts truncates shared tables between cases. One file at a time.
    fileParallelism: false,
  },
});
