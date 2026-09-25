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
 *
 * This check exists because two of the entries below were reworded after they were released, by
 * an editorial pass over the whole file that had no idea some of it was frozen. Every statement
 * stayed identical and only the prose moved, so nothing that compares schemas could have objected.
 * The hashes are what objects.
 *
 * They hold the reworded text rather than the original, because that is what was published and a
 * frozen record has to say what shipped — undoing it would be the same edit pointed the other way.
 *
 * The list is also one shorter than `0.1.0-alpha.5`, which is otherwise exactly what this refuses.
 * That entry belonged to a feature withdrawn days after it shipped, and keeping it would fix a
 * column shape for a design being reconsidered.
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
