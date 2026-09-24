import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OUTBOX_MIGRATIONS, OUTBOX_SCHEMA_VERSION } from 'commitrail/postgres';

/**
 * A released migration is frozen, including its comments.
 *
 * Each entry in `OUTBOX_MIGRATIONS` has run against databases nobody here can reach, let alone
 * re-run. Editing one changes what a schema version means while every already-migrated outbox
 * stays exactly as it was, so the two stop describing the same thing — and nothing in a customer's
 * database would show it. A mistake in a released migration is corrected by appending another, not
 * by amending it.
 *
 * The hashes below are that freeze, and they cover the whole entry rather than the statements in
 * it. A comment is part of what was published: it is what somebody reads when they inspect the
 * migration that ran, and rewording it silently makes two copies of one version disagree. Adding a
 * migration means adding a line here and changing none of the others.
 */
describe('released outbox migrations', () => {
  const digest = (sql: string) => createHash('sha256').update(sql).digest('hex').slice(0, 16);

  it('are byte for byte what was released', () => {
    expect(OUTBOX_MIGRATIONS.map((m) => `${m.version}:${digest(m.sql)}`)).toEqual([
      '1:3da7659436bfdb2e',
      '2:a6df0eec2ad03385',
      '3:6bb05f93d521a1c0',
      '4:fd31b1fa73e32eee',
      '5:2cce7b55b6e93d75',
      '6:1c6e22a5f60063a4',
    ]);
  });

  it('are numbered from one, in order, with no gaps', () => {
    // A version is a position in this list, so a gap or a repeat would make an outbox's recorded
    // marker mean something different from what it means here.
    expect(OUTBOX_MIGRATIONS.map((m) => m.version)).toEqual(
      OUTBOX_MIGRATIONS.map((_, index) => index + 1),
    );

    expect(OUTBOX_SCHEMA_VERSION).toBe(OUTBOX_MIGRATIONS.length);
  });
});
