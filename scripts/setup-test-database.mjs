/**
 * Prepare the test database: the customer's tables, then CommitRail's outbox.
 *
 * The order is the real one and it matters. A customer's ORM owns their schema; the outbox
 * arrives separately as SQL they apply. Running `db push` second would put Prisma in charge
 * of a database containing a table it does not know about, which is a diff it may offer to
 * resolve by dropping.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Read `.env` if there is one, the same way vitest.config.ts does.
 *
 * Without this, `pnpm test` works from a `.env` and `pnpm db:setup` does not — which is the
 * exact order CONTRIBUTING.md tells a newcomer to run them in, so the first thing they would
 * meet is a setup step failing on a file the next step reads happily.
 *
 * A real environment always wins: CI sets DATABASE_URL directly and has no `.env`.
 */
const envFile = resolve(dirname(dirname(fileURLToPath(import.meta.url))), '.env');

if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const at = trimmed.indexOf('=');
    const key = trimmed.slice(0, at).trim();
    if (key !== '' && process.env[key] === undefined) {
      process.env[key] = trimmed
        .slice(at + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
    }
  }
}

const url = process.env.DATABASE_URL;

if (!url) {
  console.error('DATABASE_URL is not set. See README.md — a real PostgreSQL is required.');
  process.exit(1);
}

// Refuse anything that is not obviously a throwaway. `db push` computes a diff and applies
// it; pointed at something real it is a destructive command with a reassuring name.
if (!/commitrail_sdk_test|localhost|127\.0\.0\.1/.test(url)) {
  console.error(
    `DATABASE_URL does not look like a test database: ${url.replace(/:[^:@]*@/, ':***@')}`,
  );
  process.exit(1);
}

console.log('prisma db push  (the customer half)');
execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--config=prisma.config.ts'], {
  stdio: 'inherit',
});

console.log('prisma generate');
execFileSync('pnpm', ['exec', 'prisma', 'generate', '--config=prisma.config.ts'], {
  stdio: 'inherit',
});

console.log('outbox schema  (the CommitRail half, applied as a customer would)');
const { Pool } = await import('pg');
const { OUTBOX_SCHEMA_SQL } = await import('../dist/esm/postgres.js').catch(() => {
  console.error('dist/ is missing — run `pnpm build` before `pnpm db:setup`.');
  process.exit(1);
});

const pool = new Pool({ connectionString: url, options: '-c timezone=UTC' });
try {
  await pool.query(OUTBOX_SCHEMA_SQL);
} finally {
  await pool.end();
}
console.log('ready');
