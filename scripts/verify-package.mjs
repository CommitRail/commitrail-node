/**
 * Prove the published artifact, not the source tree.
 *
 * Every existing suite imports this package through a vitest alias pointing at `src/`, which
 * is deliberate and documented in vitest.config.ts — but it means the whole test suite would
 * stay green with a broken `exports` map, a file missing from `files`, or a CommonJS build
 * that does not load. Those are the failures a dual-published package actually has, and none
 * of them are visible from source.
 *
 * So: pack the tarball npm would publish, install it into throwaway projects, and use it the
 * four ways a customer can.
 *
 *   1. ESM      import  "commitrail", "commitrail/postgres", "commitrail/webhooks"
 *   2. CommonJS require the same three
 *   3. TypeScript  types resolve for every entry point, under node16 and under node10
 *   4. Both at once — the dual-package hazard, checked rather than assumed
 *
 * Run it with `pnpm verify:package`. It needs no network: the package has no
 * runtime dependencies, and the TypeScript fixture uses this repository's own compiler.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const sdk = dirname(dirname(fileURLToPath(import.meta.url)));
const tsc = join(sdk, 'node_modules', '.bin', 'tsc');

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const write = (dir, name, body) => {
  mkdirSync(dirname(join(dir, name)), { recursive: true });
  writeFileSync(join(dir, name), body);
};

const scratch = mkdtempSync(join(tmpdir(), 'commitrail-pack-'));
let failures = 0;

const check = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  ✗ ${name}`);
    console.log(String(error.stdout ?? '').trim());
    console.log(String(error.stderr ?? error.message).trim());
  }
};

try {
  console.log('packing');
  run('npm', ['pack', '--pack-destination', scratch], sdk);
  const tarball = join(
    scratch,
    readdirSync(scratch).find((f) => f.endsWith('.tgz')),
  );
  console.log(`  ${tarball}`);

  // What is actually in it. `files` decides this and npm's default rules are generous.
  console.log('\ntarball contents');
  const listed = run('tar', ['-tzf', tarball])
    .split('\n')
    .filter(Boolean)
    .map((p) => p.replace(/^package\//, ''))
    .sort();
  for (const entry of listed) console.log(`  ${entry}`);

  check('ships both module builds and no build info', () => {
    const required = [
      'package.json',
      'README.md',
      // Apache-2.0. A published package whose licence did not make it into the tarball is
      // a licensing question nobody can answer from what they installed.
      'LICENSE',
      'dist/esm/index.js',
      'dist/esm/index.d.ts',
      'dist/esm/package.json',
      'dist/cjs/index.js',
      'dist/cjs/index.d.ts',
      'dist/cjs/package.json',
      'dist/esm/postgres.js',
      'dist/cjs/postgres.js',
      'dist/esm/webhooks.js',
      'dist/cjs/webhooks.js',
    ];
    const missing = required.filter((f) => !listed.includes(f));
    if (missing.length > 0) throw new Error(`missing from tarball: ${missing.join(', ')}`);

    const junk = listed.filter((f) => f.endsWith('.tsbuildinfo') || f.startsWith('src/'));
    if (junk.length > 0) throw new Error(`should not be published: ${junk.join(', ')}`);
  });

  const project = (name, pkg, files) => {
    const dir = join(scratch, name);
    mkdirSync(dir, { recursive: true });
    write(dir, 'package.json', JSON.stringify({ name, version: '0.0.0', ...pkg }, null, 2));
    for (const [file, body] of Object.entries(files)) write(dir, file, body);
    run('npm', ['install', '--no-audit', '--no-fund', tarball], dir);
    return dir;
  };

  const ASSERTIONS = `
  assert.equal(protocol.SPEC_VERSION, '1');
  assert.equal(typeof protocol.HEADERS, 'object');
  assert.equal(typeof protocol.verifySignatureHeader, 'function');
  assert.equal(typeof protocol.SUBJECT_LIMITS, 'object');
  assert.equal(typeof protocol.InvalidSubjectsError, 'function');
  assert.equal(typeof postgres.emit, 'function');
  assert.equal(typeof postgres.transaction, 'function');
  assert.equal(typeof postgres.OUTBOX_SCHEMA_SQL, 'string');
  assert.equal(typeof postgres.EventIdConflictError, 'function');
  assert.equal(typeof webhooks.verifyRequest, 'function');
  assert.equal(typeof webhooks.InvalidDeliveryError, 'function');

  // The root is what a CUSTOMER needs. CommitRail signs from its own private implementation, so
  // an export appearing here means the public surface grew without anybody deciding to grow it.
  for (const sending of ['sign', 'signatureHeader', 'serialiseEnvelope', 'canonicalPayload', 'normalizeSubjects']) {
    assert.equal(protocol[sending], undefined, sending + ' must not be public');
  }

  // Each subpath names one side, and neither pretends to be the default.
  assert.equal(protocol.verifyRequest, undefined, 'root must not re-export the receiver');
  assert.equal(protocol.emit, undefined, 'root must not re-export the producer');
  assert.equal(postgres.SUBJECT_LIMITS, undefined, '/postgres must not re-export the protocol');
`;

  console.log('\nESM consumer');
  const esm = project(
    'esm-fixture',
    { type: 'module' },
    {
      'index.js': `import assert from 'node:assert/strict';
import * as protocol from 'commitrail';
import * as postgres from 'commitrail/postgres';
import * as webhooks from 'commitrail/webhooks';
${ASSERTIONS}
console.log('esm ok');
`,
    },
  );
  check('import works for all three entry points', () => run('node', ['index.js'], esm));

  console.log('\nCommonJS consumer');
  const cjs = project(
    'cjs-fixture',
    { type: 'commonjs' },
    {
      'index.js': `const assert = require('node:assert/strict');
const protocol = require('commitrail');
const postgres = require('commitrail/postgres');
const webhooks = require('commitrail/webhooks');
${ASSERTIONS}
console.log('cjs ok');
`,
    },
  );
  check('require works for all three entry points', () => run('node', ['index.js'], cjs));

  console.log('\nTypeScript consumer');
  const types = project(
    'ts-fixture',
    { type: 'module' },
    {
      'src/node16.ts': `import { SPEC_VERSION, HEADERS, verifySignatureHeader, SUBJECT_LIMITS, type CommitRailEvent, type EventSubject } from 'commitrail';
import { emit, OUTBOX_SCHEMA_SQL, type OutboxWriter, EventIdConflictError } from 'commitrail/postgres';
import { verifyRequest, InvalidDeliveryError, type InvalidDeliveryCode } from 'commitrail/webhooks';

const version: '1' = SPEC_VERSION;
const sql: string = OUTBOX_SCHEMA_SQL;
const maxSubjects: number = SUBJECT_LIMITS.maxPerEvent;
declare const writer: OutboxWriter;
declare const event: CommitRailEvent<{ orderId: string }>;
declare const subject: EventSubject;
declare const code: InvalidDeliveryCode;

export const uses = [
  verifySignatureHeader,
  emit,
  verifyRequest,
  InvalidDeliveryError,
  EventIdConflictError,
] as const;
export const orderId: string = event.data.orderId;
export const rest = { version, sql, writer, HEADERS, maxSubjects, subject, code };
`,
    },
  );

  check('types resolve under node16 (an ESM consumer)', () =>
    run(
      tsc,
      [
        '--noEmit',
        '--strict',
        '--module',
        'node16',
        '--moduleResolution',
        'node16',
        '--target',
        'es2022',
        'src/node16.ts',
      ],
      types,
    ),
  );

  check('types resolve under the CommonJS condition', () => {
    // A `require`-shaped project resolves the "require" branch of exports, which is a
    // different set of .d.ts files. Nothing else here would notice if one were missing.
    write(types, 'cjs/package.json', JSON.stringify({ type: 'commonjs' }));
    write(
      types,
      'cjs/consume.ts',
      `import { SPEC_VERSION } from 'commitrail';
import { emit } from 'commitrail/postgres';
import { verifyRequest } from 'commitrail/webhooks';
export const uses = [SPEC_VERSION, emit, verifyRequest] as const;
`,
    );
    run(
      tsc,
      [
        '--noEmit',
        '--strict',
        '--module',
        'commonjs',
        '--moduleResolution',
        'node10',
        '--target',
        'es2022',
        '--esModuleInterop',
        'cjs/consume.ts',
      ],
      types,
    );
  });

  console.log('\nThe exports map is the gate');
  const gated = project(
    'gate-fixture',
    { type: 'module' },
    {
      'index.js': `import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// The signing module exists in the tarball and is used by commitrail/webhooks, but it is not an
// entry point. Tests reach it through a bundler alias; a customer must not be able to. If this
// ever resolves, signing has become public API by accident rather than by decision.
for (const path of ['commitrail/signing', 'commitrail/envelope', 'commitrail/subjects', 'commitrail/dist/esm/signing.js']) {
  assert.throws(() => require(path), /ERR_PACKAGE_PATH_NOT_EXPORTED|Cannot find module/, \`\${path} should not be importable\`);
}
console.log('gate ok');
`,
    },
  );
  check('unlisted subpaths are not importable', () => run('node', ['index.js'], gated));

  console.log('\nDual-package hazard');
  const dual = project(
    'dual-fixture',
    { type: 'module' },
    {
      'index.js': `import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { InvalidDeliveryError as Imported } from 'commitrail/webhooks';

const { InvalidDeliveryError: Required } = createRequire(import.meta.url)('commitrail/webhooks');

// Two module systems, two classes. This is the hazard, and it is why the brand exists —
// asserted rather than assumed, because if Node ever stopped doing this the brand would
// look like dead weight to the next person reading it.
assert.notEqual(Imported, Required, 'expected two distinct classes, one per module system');

const thrown = new Required('test');
assert.equal(thrown instanceof Imported, false, 'instanceof is the thing that breaks');
assert.equal(Imported.is(thrown), true, 'the brand must see across copies');
assert.equal(Required.is(new Imported('test')), true, 'and in both directions');
assert.equal(Imported.is(new Error('unrelated')), false);
console.log('dual ok');
`,
    },
  );
  check('the brand survives what instanceof does not', () => run('node', ['index.js'], dual));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed against the packed artifact`);
  process.exit(1);
}
console.log('the packed artifact works from ESM, CommonJS and TypeScript');
