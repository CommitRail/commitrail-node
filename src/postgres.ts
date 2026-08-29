import { randomUUID } from 'node:crypto';
import { normalizeSubjects, type EventSubject } from './subjects.js';

/** Registered globally by description, so every copy of this package agrees on it. */
const CONFLICTING_EVENT_BRAND = Symbol.for('commitrail.EventIdConflictError');

/**
 * The minimum CommitRail needs to write a row.
 *
 * Structural on purpose, with no dependency on any driver: a `pg` `PoolClient` satisfies
 * it as-is, and `fromPrisma` adapts a Prisma transaction client. Requiring a particular
 * driver would make adoption a migration.
 */
export interface OutboxWriter {
  query(sql: string, params: unknown[]): Promise<unknown>;
}

export interface EmitEvent<TData = unknown> {
  type: string;
  data: TData;
  version?: number;
  occurredAt?: Date;
  /** Supply one to make emitting idempotent under your own retries. */
  eventId?: string;

  /**
   * The logical operation this event belongs to — an order number, a checkout id, whatever
   * your application already calls it.
   *
   * CommitRail groups events that share one and never invents one. Propagate it into the
   * events your consumers emit in turn, and the chain joins up on its own.
   */
  correlationId?: string;

  /** The event that caused this one, if your application knows. */
  causationId?: string;

  /**
   * The business identities this event concerns — `{ type: 'order', id: 'order_1264' }`.
   *
   * Distinct from everything above: the event type says *what happened*, the correlation id
   * says *which operation it belongs to*, the causation id says *what caused it* — subjects
   * say *what it was about*. Declare every relevant identity; CommitRail indexes them so an
   * investigation can start from an order or customer id rather than an event id. Exact
   * duplicates are dropped; order carries no meaning.
   */
  subjects?: EventSubject[];
}

/**
 * The outbox schema, as an append-only list of migrations.
 *
 * A list rather than one script, because the alternative already caused a problem. A single
 * converge-to-latest constant changes when the package changes, so a customer who pasted it
 * into `001_add_commitrail.sql` finds that migration meaning something different a year later
 * — which is the one thing migrations exist not to do. Pinning a version instead gives them an
 * immutable statement of what they applied.
 *
 * **Every entry here is frozen once released.** A released migration has run against databases
 * we do not own and cannot re-run; editing one changes what a version *means* while leaving
 * every already-migrated database untouched. Fix a mistake by appending, never by amending.
 *
 * Each is written to be safely re-runnable — `IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS` — so
 * applying the whole list to any database converges it, whatever it started from.
 */
export const OUTBOX_MIGRATIONS: readonly { readonly version: number; readonly sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE SCHEMA IF NOT EXISTS commitrail;

CREATE TABLE IF NOT EXISTS commitrail.outbox_events (
    event_id UUID PRIMARY KEY,
    source_sequence BIGINT GENERATED ALWAYS AS IDENTITY,
    transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),
    event_type TEXT NOT NULL,
    event_version INTEGER NOT NULL DEFAULT 1,
    payload JSONB NOT NULL,

    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Which logical operation this event belongs to, and which event caused it.
    --
    -- Supplied by the application or left null; CommitRail never infers either. Chronological
    -- proximity is not causation, and a timeline drawn from a guess is worse than no timeline.
    -- A null correlation groups with nothing rather than with every other null.
    --
    -- Text rather than uuid: a correlation is the customer's own identifier for a business
    -- operation — an order number, a checkout id — and forcing it into a uuid would make them
    -- invent a second one and keep a mapping.
    correlation_id TEXT,
    causation_id TEXT
);

CREATE INDEX IF NOT EXISTS outbox_events_capture_idx
    ON commitrail.outbox_events (transaction_id, source_sequence, event_id);
`,
  },
  {
    version: 2,
    sql: `
-- The business identities an event concerns — a JSON array of {"type","id"} pairs, or null
-- when the event declares none. CommitRail normalises these into its own indexed table at
-- acceptance; they are never queried in the outbox.
--
-- Appended rather than declared in the table above, so that a fresh install and an upgraded
-- one have the same column order rather than merely the same columns.
ALTER TABLE commitrail.outbox_events ADD COLUMN IF NOT EXISTS subjects JSONB;
`,
  },
  {
    version: 3,
    sql: `
-- Finding every event in one logical operation is the correlation timeline's whole query.
CREATE INDEX IF NOT EXISTS outbox_events_correlation_idx
    ON commitrail.outbox_events (correlation_id)
    WHERE correlation_id IS NOT NULL;
`,
  },
  {
    version: 4,
    sql: `
-- Which migrations have been applied. Bookkeeping, and only bookkeeping.
--
-- CommitRail never decides what it can read from this number. Capture inspects the actual
-- columns and preflight validates the actual structure, because a marker can be wrong — hand
-- edited, restored from a backup taken mid-migration, or written by a migration that half
-- applied — and a version that outranks reality is worse than no version at all. What this buys
-- is the ability to say "you are on 3 of 4" rather than "something is missing", and to give a
-- customer an immutable thing to pin in their own migration history.
CREATE TABLE IF NOT EXISTS commitrail.outbox_schema (
    -- One row, enforced rather than assumed.
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    version INTEGER NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`,
  },
];

/** The newest schema this package knows how to write. */
export const OUTBOX_SCHEMA_VERSION = OUTBOX_MIGRATIONS[OUTBOX_MIGRATIONS.length - 1]!.version;

/**
 * Record which version has been applied.
 *
 * `GREATEST` so that re-running an older migration cannot walk the marker backwards — applying
 * the whole list to a database that is already current is a supported thing to do, and it must
 * be a no-op rather than a downgrade.
 */
const RECORD_VERSION = (version: number) => `
INSERT INTO commitrail.outbox_schema (version) VALUES (${version})
ON CONFLICT (singleton) DO UPDATE
    SET version = GREATEST(commitrail.outbox_schema.version, EXCLUDED.version),
        applied_at = now();
`;

/** The migration that introduced the marker table; nothing before it can record anything. */
const FIRST_RECORDED_VERSION = 4;

/**
 * Every migration, in order, for a fresh install or to bring an old outbox up to date.
 *
 * Safe to run against any database at any version: every statement is conditional, and the
 * marker only moves forward. This is the convenience; `OUTBOX_MIGRATIONS` is the contract.
 *
 * Versions before the marker table existed record nothing — there is nowhere to record it. The
 * migration that creates the table sets the version to its own, which is sound because the list
 * is ordered and everything before it has just run.
 */
export const OUTBOX_SCHEMA_SQL = OUTBOX_MIGRATIONS.map((m) =>
  m.version < FIRST_RECORDED_VERSION ? m.sql : `${m.sql}${RECORD_VERSION(m.version)}`,
).join('\n');

const INSERT = `
INSERT INTO commitrail.outbox_events
    (event_id, event_type, event_version, payload, occurred_at, correlation_id, causation_id, subjects)
VALUES ($1::uuid, $2, $3, $4::jsonb, COALESCE($5::timestamptz, now()), $6, $7, $8::jsonb)
ON CONFLICT (event_id) DO NOTHING
`;

/**
 * What makes two emissions THE SAME EVENT.
 *
 * Every producer-controlled field participates, because every one of them changes what the event
 * means, where it routes, or how it is ordered:
 *
 *     event_type, event_version, payload, correlation_id, causation_id, subjects
 *     occurred_at — only when the caller supplied one; see below
 *
 * Database-assigned fields never participate: `source_sequence` and `transaction_id` are issued
 * per attempt and can never match, and comparing them would make every retry a conflict.
 *
 * **A new producer-controlled column must be added to `CONFLICTS` in the same change that adds
 * it to the schema.** An ordering key is already planned, and it is exactly the kind of field
 * that changes an event's meaning while being easy to forget here — a forgotten field makes two
 * genuinely different events compare equal, which turns this check back into the silent discard
 * it exists to remove. `tests/integration/sdk/postgres.test.ts` fails if a column appears in the
 * outbox that this comment has not accounted for, so the reminder is a test rather than a hope.
 *
 * Comparison happens in PostgreSQL rather than in JavaScript: `jsonb` equality is semantic, so
 * key order and whitespace do not matter, and `IS DISTINCT FROM` gets NULL right without a
 * special case. Inventing JSON equality rules in JS would mean inventing them twice.
 */

/**
 * Does an event already exist under this id that is not the event being written?
 *
 * Runs only after the INSERT above did nothing, and only inside the caller's transaction.
 * There is no race: the unique index on `event_id` serialises two transactions emitting the
 * same id, so the second one blocks until the first commits or rolls back and then sees a
 * settled answer.
 *
 * `occurred_at` is compared only when the caller supplied one. It defaults to `now()`, so a
 * legitimate retry that omitted it writes a different timestamp every attempt — comparing it
 * unconditionally would report every such retry as a conflict, which is precisely the case
 * `ON CONFLICT DO NOTHING` exists to allow.
 *
 * `transaction_id` and `source_sequence` are excluded for the same reason and more strongly:
 * they are assigned by the database per attempt and can never match.
 *
 * The comparison is on `jsonb`, so key order and whitespace do not matter — two payloads that
 * differ only in serialisation are the same event, which is what a retrying producer produces.
 */
const CONFLICTS = `
SELECT 1
FROM commitrail.outbox_events e
WHERE e.event_id = $1::uuid
  AND (
    (e.event_type, e.event_version, e.payload, e.correlation_id, e.causation_id, e.subjects)
      IS DISTINCT FROM ($2, $3::integer, $4::jsonb, $6, $7, $8::jsonb)
    OR ($5::timestamptz IS NOT NULL AND e.occurred_at IS DISTINCT FROM $5::timestamptz)
  )
`;

/**
 * A different event was already written under this `eventId`.
 *
 * Supplying an `eventId` is a claim that two calls describe the same event. When they do not,
 * one of them is a mistake — a reused id, or a collision — and CommitRail has no way to know
 * which. Discarding the second silently would leave the producer believing it was written.
 *
 * Thrown from inside the caller's transaction. **When the exception is allowed to propagate
 * out of a `transaction()` callback, the transaction rolls back** and nothing half-happens.
 * That is the intended handling and the reason this throws rather than returning a flag.
 *
 * Note what a throw does not do: it does not poison the PostgreSQL transaction by itself. A
 * caller managing `BEGIN`/`COMMIT` themselves can catch this and commit anyway, and would then
 * have committed business state describing an event that was never written. There is no way for
 * an SDK to prevent that; enforcing it against every writer would mean putting the rule in the
 * customer's database, which is a schema-versioning cost not worth paying yet. Catching this and
 * continuing is almost certainly wrong.
 */
export class EventIdConflictError extends Error {
  static readonly brand = CONFLICTING_EVENT_BRAND;

  readonly [CONFLICTING_EVENT_BRAND] = true;

  constructor(readonly eventId: string) {
    super(
      `CommitRail: an event already exists with eventId ${eventId} and different content. ` +
        'An eventId identifies one event; reusing it for a different one is a producer bug.',
    );
    this.name = 'EventIdConflictError';
  }

  static is(error: unknown): error is EventIdConflictError {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as Record<symbol, unknown>)[CONFLICTING_EVENT_BRAND] === true
    );
  }
}

/**
 * How many rows a driver says it affected.
 *
 * `OutboxWriter` is structural and write-only on purpose, so this is the one place that has to
 * know what real drivers return: `pg` gives a result object with `rowCount`, Prisma's
 * `$executeRawUnsafe` gives a bare number. Anything else returns undefined, and an unknown
 * shape must not be read as "no conflict" — see the caller.
 */
function affectedRows(result: unknown): number | undefined {
  if (typeof result === 'number') {
    return result;
  }

  if (typeof result === 'object' && result !== null && 'rowCount' in result) {
    const count = (result as { rowCount: unknown }).rowCount;
    return typeof count === 'number' ? count : undefined;
  }

  return undefined;
}

/**
 * Write an event to the outbox **inside the caller's transaction**.
 *
 * That is the entire point, and the only thing that can go wrong here. Pass a transaction
 * and the event commits with your business state or not at all. Pass a pool — which also
 * has `.query` — and you have written the event on a separate connection, which is the
 * dual write CommitRail exists to eliminate. Nothing at runtime can tell the two apart, so
 * prefer `transaction()` below, which does not give you the chance.
 *
 * If you already manage transactions yourself, call `emit` on your transaction-scoped client.
 * The example is deliberately not a `BEGIN`/`COMMIT` pair: written short it has no rollback
 * path, and `emit` throwing would leave the connection inside a failed transaction.
 *
 * ```ts
 * // `tx` is whatever your code already uses for the surrounding transaction.
 * await emit(tx, { type: 'order.created', data: { orderId } });
 * ```
 */
export async function emit<TData>(writer: OutboxWriter, event: EmitEvent<TData>): Promise<string> {
  if (event.type.trim().length === 0) {
    throw new Error('an event must have a type');
  }

  assertNotAPool(writer);

  const supplied = event.eventId !== undefined;
  const eventId = event.eventId ?? randomUUID();
  const subjects = normalizeSubjects(event.subjects);

  // Normalised before it is written AND before it is compared, so the two are the same value.
  // Comparing raw caller input against a canonicalised row would report a producer that reordered
  // its own subjects as a conflict.
  const params = [
    eventId,
    event.type,
    event.version ?? 1,
    JSON.stringify(event.data),
    event.occurredAt ?? null,
    event.correlationId ?? null,
    event.causationId ?? null,
    subjects === null ? null : JSON.stringify(subjects),
  ];

  const inserted = affectedRows(await writer.query(INSERT, params));

  // Only a caller-supplied id can collide. Without one this is a fresh UUID, so there is nothing
  // to check and nothing to pay for — which also means an exotic writer whose results cannot be
  // interpreted keeps working unless the caller opts into explicit ids.
  if (!supplied || inserted === 1) {
    return eventId;
  }

  const conflicting = affectedRows(await writer.query(CONFLICTS, params));

  if (conflicting === undefined) {
    // Loud, because the alternative is the defect this check exists to remove: an event
    // silently discarded while the caller believes it was written.
    throw new Error(
      'CommitRail: this writer returns a query result the SDK cannot interpret, so the eventId ' +
        'idempotency check cannot be enforced. Return the driver result unchanged — a `pg` result ' +
        'object or an affected-row count — or omit `eventId` and let CommitRail generate one.',
    );
  }

  if (conflicting > 0) {
    throw new EventIdConflictError(eventId);
  }

  return eventId;
}

/**
 * Refuse a connection pool, which is the one mistake this function makes available.
 *
 * `OutboxWriter` is structural so that any driver satisfies it, and a `pg` Pool has the same
 * `.query` method a transaction client does. Passing one writes the event on a whatever
 * connection the pool hands out — a different connection from the business write, outside the
 * transaction. That is the dual write CommitRail exists to eliminate, produced by code that
 * looks correct and behaves correctly until the day a transaction rolls back.
 *
 * The documentation used to say nothing at runtime could tell the two apart. That is true of the
 * interface and false of the object: a `pg` Pool carries `totalCount`, `idleCount` and
 * `waitingCount`, and a client carries none of them. Checking is cheap, catches the exact
 * documented footgun, and cannot produce a false positive on a transaction client.
 *
 * A driver this does not recognise is passed through, so the guard only ever adds safety. It is
 * not a substitute for `transaction()`, which removes the choice instead of policing it.
 */
function assertNotAPool(writer: OutboxWriter): void {
  const pool = writer as { totalCount?: unknown; idleCount?: unknown; waitingCount?: unknown };

  if (
    typeof pool.totalCount === 'number' &&
    typeof pool.idleCount === 'number' &&
    typeof pool.waitingCount === 'number'
  ) {
    throw new Error(
      'CommitRail: emit() was given a connection pool, not a transaction. The event would be ' +
        'written on a different connection from your business write and would survive a ' +
        'rollback — the dual write CommitRail exists to eliminate. Use transaction(pool, tx => ' +
        'tx.emit(...)), or pass the client your own transaction is running on.',
    );
  }
}

export interface TransactionalWriter extends OutboxWriter {
  emit<TData>(event: EmitEvent<TData>): Promise<string>;
}

interface Pool {
  connect(): Promise<OutboxWriter & { release(): void }>;
}

/**
 * Run work in a transaction, with `emit` bound to it.
 *
 * The recommended shape, because it removes the one mistake available: the writer handed
 * to the callback is the transaction, so an event cannot accidentally be written outside
 * it.
 *
 * ```ts
 * await transaction(pool, async (tx) => {
 *   await tx.query('INSERT INTO orders (id, total) VALUES ($1, $2)', [id, total]);
 *   await tx.emit({ type: 'order.created', data: { orderId: id } });
 * });
 * ```
 */
export async function transaction<T>(
  pool: Pool,
  work: (tx: TransactionalWriter) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN', []);

    const tx: TransactionalWriter = {
      query: (sql, params) => client.query(sql, params),
      emit: (event) => emit(client, event),
    };

    const result = await work(tx);

    await client.query('COMMIT', []);

    return result;
  } catch (error) {
    await client.query('ROLLBACK', []);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Adapt a Prisma transaction client.
 *
 * Typed structurally so this package does not depend on Prisma. Uses `$executeRawUnsafe`
 * because the SQL is a constant defined above and the values are parameterised — the
 * "unsafe" in the name refers to interpolating the statement, which never happens here.
 */
export function fromPrisma(tx: {
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
}): OutboxWriter {
  return {
    query: (sql, params) => tx.$executeRawUnsafe(sql, ...params),
  };
}
