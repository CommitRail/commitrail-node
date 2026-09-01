import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  emit,
  transaction,
  OUTBOX_SCHEMA_SQL,
  fromPrisma,
  EventIdConflictError,
} from 'commitrail/postgres';
import { InvalidSubjectsError } from 'commitrail';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * The producer half, against a real database.
 *
 * What matters is not that a row appears — it is that the row and the business state share
 * a transaction. That claim can only be checked by asking PostgreSQL, so these tests do.
 */
describe('outbox writing', () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,

    // Pin the session timezone. Timestamps reach the driver as naive local-time strings, so
    // PostgreSQL interprets them in the session zone — on a machine set to Asia/Jerusalem,
    // writing 05:06:07Z stored 03:06:07Z, and every round-trip assertion still passed because
    // reads applied the same offset in reverse.
    options: '-c timezone=UTC',
  });

  // A customer's ORM, not ours. Used only by the `fromPrisma` cases below.
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  beforeEach(async () => {
    await pool.query('TRUNCATE commitrail.outbox_events RESTART IDENTITY');
    await pool.query('TRUNCATE sdk_widgets');
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await pool.end();
  });

  async function outboxRows() {
    const { rows } = await pool.query(
      `SELECT event_id, event_type, event_version, payload, occurred_at, transaction_id::text AS xid
       FROM commitrail.outbox_events ORDER BY source_sequence`,
    );

    return rows;
  }

  it('writes an event with the fields capture depends on', async () => {
    await transaction(pool, async (tx) => {
      await tx.emit({ type: 'order.created', data: { orderId: 'o-1' } });
    });

    const [row] = await outboxRows();
    expect(row).toMatchObject({ event_type: 'order.created', event_version: 1 });
    expect(row.payload).toEqual({ orderId: 'o-1' });
    expect(row.xid).toMatch(/^\d+$/);
  });

  it('carries a correlation and a causation when the caller supplies them', async () => {
    // Customer-supplied and nothing else. CommitRail never infers a correlation from timing
    // or payload similarity — chronological proximity is not causation, and a timeline drawn
    // from a guess is worse than no timeline. See docs/discussions/web-ui-design-ideas.md.
    const eventId = await transaction(pool, async (tx) =>
      tx.emit({
        type: 'order.created',
        data: { orderId: 'o-1' },
        correlationId: 'checkout_8472',
        causationId: 'evt_upstream',
      }),
    );

    const { rows } = await pool.query(
      'SELECT correlation_id, causation_id FROM commitrail.outbox_events WHERE event_id = $1',
      [eventId],
    );

    expect(rows[0]).toEqual({
      correlation_id: 'checkout_8472',
      causation_id: 'evt_upstream',
    });
  });

  it('writes the subjects the caller declared, deduplicated, and null when there are none', async () => {
    const withSubjects = await transaction(pool, async (tx) =>
      tx.emit({
        type: 'payment.captured',
        data: {},
        subjects: [
          { type: 'payment', id: 'pay_991' },
          { type: 'order', id: 'order_1264' },
          // A duplicate declaration carries no meaning; the canonical form drops it here so
          // every consumer downstream sees one statement of the fact.
          { type: 'payment', id: 'pay_991' },
        ],
      }),
    );
    const without = await transaction(pool, async (tx) =>
      tx.emit({ type: 'order.created', data: {} }),
    );

    const subjectsOf = async (eventId: string) =>
      (
        await pool.query<{ subjects: unknown }>(
          'SELECT subjects FROM commitrail.outbox_events WHERE event_id = $1',
          [eventId],
        )
      ).rows[0]!.subjects;

    expect(await subjectsOf(withSubjects)).toEqual([
      { type: 'payment', id: 'pay_991' },
      { type: 'order', id: 'order_1264' },
    ]);
    // Null, not an empty array: "declared none" stored the same way for every producer.
    expect(await subjectsOf(without)).toBeNull();
  });

  it('rejects malformed subjects before anything reaches the outbox', async () => {
    await expect(
      transaction(pool, async (tx) =>
        tx.emit({
          type: 'order.created',
          data: {},
          subjects: [{ type: 'order', id: '' }],
        }),
      ),
    ).rejects.toThrow(InvalidSubjectsError);
  });

  it('leaves them null when the caller says nothing', async () => {
    const eventId = await transaction(pool, async (tx) =>
      tx.emit({ type: 'order.created', data: {} }),
    );

    const { rows } = await pool.query(
      'SELECT correlation_id, causation_id FROM commitrail.outbox_events WHERE event_id = $1',
      [eventId],
    );

    // Null, not a generated value. An event that belongs to no logical operation must group
    // with nothing rather than with everything else that has no correlation.
    expect(rows[0]).toEqual({ correlation_id: null, causation_id: null });
  });

  it('commits the event with the business state', async () => {
    const widgetId = '11111111-1111-4111-8111-111111111111';

    await transaction(pool, async (tx) => {
      await tx.query('INSERT INTO sdk_widgets (id, name) VALUES ($1::uuid, $2)', [widgetId, 'a']);
      await tx.emit({ type: 'widget.created', data: { widgetId } });
    });

    // Judged by PostgreSQL comparing the widget row's own xmin against the transaction id
    // the event recorded. Two writes that merely happened close together would not match.
    const { rows } = await pool.query<{ same: boolean }>(
      `SELECT (SELECT transaction_id FROM commitrail.outbox_events)
              = (SELECT xmin::text::bigint::text::xid8 FROM sdk_widgets WHERE id = $1::uuid)
              AS same`,
      [widgetId],
    );

    expect(rows[0]!.same).toBe(true);
  });

  it('loses the event when the transaction fails', async () => {
    await expect(
      transaction(pool, async (tx) => {
        await tx.query('INSERT INTO sdk_widgets (id, name) VALUES ($1::uuid, $2)', [
          '22222222-2222-4222-8222-222222222222',
          'b',
        ]);
        await tx.emit({ type: 'widget.created', data: {} });

        throw new Error('business rule violated');
      }),
    ).rejects.toThrow('business rule violated');

    // The event was written and still must not survive, because the state it describes did
    // not. A dual write would have leaked it.
    expect(await outboxRows()).toEqual([]);
    expect((await pool.query('SELECT * FROM sdk_widgets')).rowCount).toBe(0);
  });

  it('releases the connection whether the work succeeds or fails', async () => {
    // A leaked connection per failed transaction exhausts a customer's pool, and the
    // symptom appears far from the cause.
    for (let i = 0; i < 15; i += 1) {
      await transaction(pool, async (tx) => tx.emit({ type: 'ok', data: { i } })).catch(() => {});
      await transaction(pool, async () => {
        throw new Error('nope');
      }).catch(() => {});
    }

    expect(pool.idleCount).toBeGreaterThan(0);
    expect(pool.waitingCount).toBe(0);
  });

  it('is idempotent when the caller supplies an event id', async () => {
    const eventId = '33333333-3333-4333-8333-333333333333';

    await transaction(pool, async (tx) => tx.emit({ type: 'a', data: {}, eventId }));
    await transaction(pool, async (tx) => tx.emit({ type: 'a', data: {}, eventId }));

    // Lets a caller retry its own write without producing two events. The ON CONFLICT is
    // what makes that safe rather than a race.
    expect(await outboxRows()).toHaveLength(1);
  });

  it('honours an explicit occurredAt', async () => {
    const occurredAt = new Date('2026-03-04T05:06:07.891Z');

    await transaction(pool, async (tx) => tx.emit({ type: 'a', data: {}, occurredAt }));

    const [row] = await outboxRows();
    expect((row.occurred_at as Date).toISOString()).toBe(occurredAt.toISOString());
  });

  it('rejects an event with no type', async () => {
    await expect(
      transaction(pool, async (tx) => tx.emit({ type: '  ', data: {} })),
    ).rejects.toThrow(/must have a type/);
  });

  it('works with a caller-managed transaction too', async () => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await emit(client, { type: 'manual', data: { ok: true } });
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    expect(await outboxRows()).toHaveLength(1);
  });

  it('commits an event with Prisma-written business state, in one transaction', async () => {
    // Against the real Prisma client, deliberately. A hand-made object with an
    // `$executeRawUnsafe` method would prove only that `fromPrisma` calls the method it is
    // written to call — it would restate the implementation rather than test it. Prisma is a
    // devDependency for exactly this test and is never a runtime dependency of the SDK.
    const widgetId = '44444444-4444-4444-8444-444444444444';

    await prisma.$transaction(async (tx) => {
      await tx.widget.create({ data: { id: widgetId, name: 'via prisma' } });
      await emit(fromPrisma(tx), {
        type: 'widget.created',
        data: { widgetId },
      });
    });

    // The same judgement as the `pg` case: PostgreSQL compares the row's own xmin against the
    // transaction id the event recorded. Two writes that merely happened close together, or
    // one written on a second connection, would not match.
    const { rows } = await pool.query<{ same: boolean }>(
      `SELECT (SELECT transaction_id FROM commitrail.outbox_events)
              = (SELECT xmin::text::bigint::text::xid8 FROM sdk_widgets WHERE id = $1::uuid)
              AS same`,
      [widgetId],
    );

    expect(rows[0]!.same).toBe(true);
  });

  it('loses a Prisma-written event when its transaction fails', async () => {
    const widgetId = '55555555-5555-4555-8555-555555555555';

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.widget.create({ data: { id: widgetId, name: 'doomed' } });
        await emit(fromPrisma(tx), {
          type: 'widget.created',
          data: { widgetId },
        });

        throw new Error('business rule violated');
      }),
    ).rejects.toThrow('business rule violated');

    // The half that a fake could never have caught: `fromPrisma` returning a writer bound to
    // anything other than the interactive transaction would leave this event behind.
    expect(await outboxRows()).toEqual([]);
    expect((await pool.query('SELECT * FROM sdk_widgets')).rowCount).toBe(0);
  });

  describe('a caller-supplied eventId', () => {
    const eventId = '77777777-7777-4777-8777-777777777777';

    it('is a no-op when the same event is emitted again', async () => {
      // The reason `ON CONFLICT DO NOTHING` exists. A COMMIT can reach PostgreSQL and succeed
      // while the connection dies before the application learns it, so a retry may be retrying
      // something that already committed. That must not be an error.
      await transaction(pool, async (tx) => tx.emit({ eventId, type: 'a', data: { n: 1 } }));
      await transaction(pool, async (tx) => tx.emit({ eventId, type: 'a', data: { n: 1 } }));

      expect(await outboxRows()).toHaveLength(1);
    });

    it('rejects a DIFFERENT event under the same id instead of discarding it', async () => {
      await transaction(pool, async (tx) => tx.emit({ eventId, type: 'a', data: { n: 1 } }));

      // Previously this silently did nothing and returned the id, so the producer committed
      // business state describing an event that was never written.
      await expect(
        transaction(pool, async (tx) => tx.emit({ eventId, type: 'a', data: { n: 2 } })),
      ).rejects.toThrow(EventIdConflictError);
    });

    it("rolls the caller's business write back with it", async () => {
      const widgetId = '88888888-8888-4888-8888-888888888888';
      await transaction(pool, async (tx) => tx.emit({ eventId, type: 'a', data: { n: 1 } }));

      await expect(
        transaction(pool, async (tx) => {
          await tx.query('INSERT INTO sdk_widgets (id, name) VALUES ($1::uuid, $2)', [
            widgetId,
            'should not survive',
          ]);
          await tx.emit({ eventId, type: 'a', data: { n: 2 } });
        }),
      ).rejects.toThrow(EventIdConflictError);

      // The point of throwing rather than returning a flag: nothing half-happens.
      const { rowCount } = await pool.query('SELECT 1 FROM sdk_widgets WHERE id = $1::uuid', [
        widgetId,
      ]);
      expect(rowCount).toBe(0);
    });

    /**
     * One baseline, and each case changes EXACTLY one field.
     *
     * An earlier version of this varied more than one field per case — the subjects case also
     * dropped `correlationId` and `causationId` — and it passed with `subjects` removed from the
     * comparison entirely, because the row still differed elsewhere. A case that can fail for a
     * reason other than the one it names is not evidence about that field.
     */
    const baseline = {
      type: 'a',
      version: 1,
      data: { n: 1 },
      correlationId: 'c',
      causationId: 'k',
      subjects: [{ type: 'order', id: 'o-1' }],
    } as const;

    it.each([
      ['type', { type: 'b' }],
      ['version', { version: 2 }],
      ['payload', { data: { n: 2 } }],
      ['correlationId', { correlationId: 'other' }],
      ['causationId', { causationId: 'other' }],
      ['subjects', { subjects: [{ type: 'order', id: 'o-9' }] }],
    ])('detects a change of %s and nothing else', async (_field, change) => {
      await transaction(pool, async (tx) => tx.emit({ eventId, ...baseline }));

      await expect(
        transaction(pool, async (tx) => tx.emit({ eventId, ...baseline, ...change } as never)),
      ).rejects.toThrow(EventIdConflictError);
    });

    it('is not fooled by payload key order or subject order', async () => {
      // Identity is the normalised event, not the caller's JavaScript. A producer that
      // reassembles its own payload or subjects between retries is emitting the same event.
      await transaction(pool, async (tx) =>
        tx.emit({
          eventId,
          type: 'a',
          data: { a: 1, b: 2 },
          subjects: [
            { type: 'order', id: 'o-1' },
            { type: 'payment', id: 'p-1' },
          ],
        }),
      );

      await expect(
        transaction(pool, async (tx) =>
          tx.emit({
            eventId,
            type: 'a',
            data: { b: 2, a: 1 },
            subjects: [
              { type: 'order', id: 'o-1' },
              { type: 'payment', id: 'p-1' },
              // A duplicate normalises away, so this is still the same event.
              { type: 'order', id: 'o-1' },
            ],
          }),
        ),
      ).resolves.toBeDefined();

      expect(await outboxRows()).toHaveLength(1);
    });

    it('does not treat an omitted occurredAt as a difference', async () => {
      // It defaults to now(), so it differs on every attempt. Comparing it unconditionally
      // would report every ordinary retry as a conflict.
      await transaction(pool, async (tx) => tx.emit({ eventId, type: 'a', data: {} }));
      await new Promise((resolve) => setTimeout(resolve, 5));

      await expect(
        transaction(pool, async (tx) => tx.emit({ eventId, type: 'a', data: {} })),
      ).resolves.toBeDefined();
    });

    it('detects a change of occurredAt when the caller supplied one', async () => {
      await transaction(pool, async (tx) =>
        tx.emit({ eventId, type: 'a', data: {}, occurredAt: new Date('2026-01-01T00:00:00Z') }),
      );

      await expect(
        transaction(pool, async (tx) =>
          tx.emit({ eventId, type: 'a', data: {}, occurredAt: new Date('2026-06-01T00:00:00Z') }),
        ),
      ).rejects.toThrow(EventIdConflictError);
    });

    it('costs nothing when the caller supplies no id', async () => {
      // A generated UUID cannot collide, so the check never runs — which is also what keeps a
      // writer whose results cannot be interpreted working for callers who do not opt in.
      const queries: string[] = [];
      const spy = {
        query: (sql: string, params: unknown[]) => {
          queries.push(sql);
          return pool.query(sql, params);
        },
      };

      await emit(spy, { type: 'a', data: {} });

      expect(queries).toHaveLength(1);
    });
  });

  describe('concurrent emitters of one id', () => {
    const eventId = '99999999-9999-4999-8999-999999999999';

    /** Two genuinely concurrent sessions with interleaved open transactions. */
    async function race(second: { n: number }) {
      const a = await pool.connect();
      const b = await pool.connect();

      try {
        await a.query('BEGIN');
        await b.query('BEGIN');

        await emit(a, { eventId, type: 'a', data: { n: 1 } });

        // B's INSERT blocks on the unique index until A settles, which is what makes the
        // second statement's fresh READ COMMITTED snapshot see a decided answer.
        const blocked = emit(b, { eventId, type: 'a', data: second });

        await a.query('COMMIT');

        return { blocked, finish: async () => b.query('COMMIT') };
      } finally {
        setTimeout(() => {
          a.release();
          b.release();
        }, 0);
      }
    }

    it('lets the loser through when both emit the same event', async () => {
      const { blocked, finish } = await race({ n: 1 });

      await expect(blocked).resolves.toBe(eventId);
      await finish();

      expect(await outboxRows()).toHaveLength(1);
    });

    it('rejects the loser when it emits a different event', async () => {
      const { blocked, finish } = await race({ n: 2 });

      await expect(blocked).rejects.toThrow(EventIdConflictError);
      await finish().catch(() => {});
    });

    it('lets the loser win when the first transaction rolls back', async () => {
      const a = await pool.connect();
      const b = await pool.connect();

      try {
        await a.query('BEGIN');
        await b.query('BEGIN');

        await emit(a, { eventId, type: 'a', data: { n: 1 } });
        const blocked = emit(b, { eventId, type: 'a', data: { n: 2 } });

        // Nothing was written, so there is nothing for B to conflict with.
        await a.query('ROLLBACK');

        await expect(blocked).resolves.toBe(eventId);
        await b.query('COMMIT');
      } finally {
        a.release();
        b.release();
      }

      const [row] = await outboxRows();
      expect(row.payload).toEqual({ n: 2 });
    });
  });

  it('fails when the outbox grows a producer field the identity check does not know about', async () => {
    // A forgotten field makes two genuinely different events compare equal, which turns the
    // conflict check back into the silent discard it exists to remove. An ordering key was
    // planned when this was written and it fired on exactly that, which is the whole of what it
    // was for — two events under one id belonging to different sequences are different events.
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'commitrail' AND table_name = 'outbox_events'`,
    );

    const assignedByDatabase = ['event_id', 'source_sequence', 'transaction_id'];
    const comparedByIdentity = [
      'event_type',
      'event_version',
      'payload',
      'correlation_id',
      'causation_id',
      'subjects',
      'ordering_key',
      // Compared only when the caller supplied one — it defaults to now().
      'occurred_at',
    ];

    expect(rows.map((r) => r.column_name).sort()).toEqual(
      [...assignedByDatabase, ...comparedByIdentity].sort(),
    );
  });

  describe('a caller-supplied eventId', () => {
    const eventId = '77777777-7777-4777-8777-777777777777';

    it('is a no-op when the same event is emitted again', async () => {
      // The reason `ON CONFLICT DO NOTHING` exists. A COMMIT can reach PostgreSQL and succeed
      // while the connection dies before the application learns it, so a retry may be retrying
      // something that already committed. That must not be an error.
      await transaction(pool, async (tx) => tx.emit({ eventId, type: 'a', data: { n: 1 } }));
      await transaction(pool, async (tx) => tx.emit({ eventId, type: 'a', data: { n: 1 } }));

      expect(await outboxRows()).toHaveLength(1);
    });

    it('rejects a DIFFERENT event under the same id instead of discarding it', async () => {
      await transaction(pool, async (tx) => tx.emit({ eventId, type: 'a', data: { n: 1 } }));

      // Previously this silently did nothing and returned the id, so the producer committed
      // business state describing an event that was never written.
      await expect(
        transaction(pool, async (tx) => tx.emit({ eventId, type: 'a', data: { n: 2 } })),
      ).rejects.toThrow(EventIdConflictError);
    });

    it("rolls the caller's business write back with it", async () => {
      const widgetId = '88888888-8888-4888-8888-888888888888';
      await transaction(pool, async (tx) => tx.emit({ eventId, type: 'a', data: { n: 1 } }));

      await expect(
        transaction(pool, async (tx) => {
          await tx.query('INSERT INTO sdk_widgets (id, name) VALUES ($1::uuid, $2)', [
            widgetId,
            'should not survive',
          ]);
          await tx.emit({ eventId, type: 'a', data: { n: 2 } });
        }),
      ).rejects.toThrow(EventIdConflictError);

      // The point of throwing rather than returning a flag: nothing half-happens.
      const { rowCount } = await pool.query('SELECT 1 FROM sdk_widgets WHERE id = $1::uuid', [
        widgetId,
      ]);
      expect(rowCount).toBe(0);
    });

    /**
     * One baseline, and each case changes EXACTLY one field.
     *
     * An earlier version of this varied more than one field per case — the subjects case also
     * dropped `correlationId` and `causationId` — and it passed with `subjects` removed from the
     * comparison entirely, because the row still differed elsewhere. A case that can fail for a
     * reason other than the one it names is not evidence about that field.
     */
    const baseline = {
      type: 'a',
      version: 1,
      data: { n: 1 },
      correlationId: 'c',
      causationId: 'k',
      subjects: [{ type: 'order', id: 'o-1' }],
    } as const;

    it.each([
      ['type', { type: 'b' }],
      ['version', { version: 2 }],
      ['payload', { data: { n: 2 } }],
      ['correlationId', { correlationId: 'other' }],
      ['causationId', { causationId: 'other' }],
      ['subjects', { subjects: [{ type: 'order', id: 'o-9' }] }],
    ])('detects a change of %s and nothing else', async (_field, change) => {
      await transaction(pool, async (tx) => tx.emit({ eventId, ...baseline }));

      await expect(
        transaction(pool, async (tx) => tx.emit({ eventId, ...baseline, ...change } as never)),
      ).rejects.toThrow(EventIdConflictError);
    });

    it('is not fooled by payload key order or subject order', async () => {
      // Identity is the normalised event, not the caller's JavaScript. A producer that
      // reassembles its own payload or subjects between retries is emitting the same event.
      await transaction(pool, async (tx) =>
        tx.emit({
          eventId,
          type: 'a',
          data: { a: 1, b: 2 },
          subjects: [
            { type: 'order', id: 'o-1' },
            { type: 'payment', id: 'p-1' },
          ],
        }),
      );

      await expect(
        transaction(pool, async (tx) =>
          tx.emit({
            eventId,
            type: 'a',
            data: { b: 2, a: 1 },
            subjects: [
              { type: 'order', id: 'o-1' },
              { type: 'payment', id: 'p-1' },
              // A duplicate normalises away, so this is still the same event.
              { type: 'order', id: 'o-1' },
            ],
          }),
        ),
      ).resolves.toBeDefined();

      expect(await outboxRows()).toHaveLength(1);
    });

    it('does not treat an omitted occurredAt as a difference', async () => {
      // It defaults to now(), so it differs on every attempt. Comparing it unconditionally
      // would report every ordinary retry as a conflict.
      await transaction(pool, async (tx) => tx.emit({ eventId, type: 'a', data: {} }));
      await new Promise((resolve) => setTimeout(resolve, 5));

      await expect(
        transaction(pool, async (tx) => tx.emit({ eventId, type: 'a', data: {} })),
      ).resolves.toBeDefined();
    });

    it('detects a change of occurredAt when the caller supplied one', async () => {
      await transaction(pool, async (tx) =>
        tx.emit({ eventId, type: 'a', data: {}, occurredAt: new Date('2026-01-01T00:00:00Z') }),
      );

      await expect(
        transaction(pool, async (tx) =>
          tx.emit({ eventId, type: 'a', data: {}, occurredAt: new Date('2026-06-01T00:00:00Z') }),
        ),
      ).rejects.toThrow(EventIdConflictError);
    });

    it('costs nothing when the caller supplies no id', async () => {
      // A generated UUID cannot collide, so the check never runs — which is also what keeps a
      // writer whose results cannot be interpreted working for callers who do not opt in.
      const queries: string[] = [];
      const spy = {
        query: (sql: string, params: unknown[]) => {
          queries.push(sql);
          return pool.query(sql, params);
        },
      };

      await emit(spy, { type: 'a', data: {} });

      expect(queries).toHaveLength(1);
    });
  });

  describe('concurrent emitters of one id', () => {
    const eventId = '99999999-9999-4999-8999-999999999999';

    /** Two genuinely concurrent sessions with interleaved open transactions. */
    async function race(second: { n: number }) {
      const a = await pool.connect();
      const b = await pool.connect();

      try {
        await a.query('BEGIN');
        await b.query('BEGIN');

        await emit(a, { eventId, type: 'a', data: { n: 1 } });

        // B's INSERT blocks on the unique index until A settles, which is what makes the
        // second statement's fresh READ COMMITTED snapshot see a decided answer.
        const blocked = emit(b, { eventId, type: 'a', data: second });

        await a.query('COMMIT');

        return { blocked, finish: async () => b.query('COMMIT') };
      } finally {
        setTimeout(() => {
          a.release();
          b.release();
        }, 0);
      }
    }

    it('lets the loser through when both emit the same event', async () => {
      const { blocked, finish } = await race({ n: 1 });

      await expect(blocked).resolves.toBe(eventId);
      await finish();

      expect(await outboxRows()).toHaveLength(1);
    });

    it('rejects the loser when it emits a different event', async () => {
      const { blocked, finish } = await race({ n: 2 });

      await expect(blocked).rejects.toThrow(EventIdConflictError);
      await finish().catch(() => {});
    });

    it('lets the loser win when the first transaction rolls back', async () => {
      const a = await pool.connect();
      const b = await pool.connect();

      try {
        await a.query('BEGIN');
        await b.query('BEGIN');

        await emit(a, { eventId, type: 'a', data: { n: 1 } });
        const blocked = emit(b, { eventId, type: 'a', data: { n: 2 } });

        // Nothing was written, so there is nothing for B to conflict with.
        await a.query('ROLLBACK');

        await expect(blocked).resolves.toBe(eventId);
        await b.query('COMMIT');
      } finally {
        a.release();
        b.release();
      }

      const [row] = await outboxRows();
      expect(row.payload).toEqual({ n: 2 });
    });
  });

  it('fails when the outbox grows a producer field the identity check does not know about', async () => {
    // A forgotten field makes two genuinely different events compare equal, which turns the
    // conflict check back into the silent discard it exists to remove. An ordering key was
    // planned when this was written and it fired on exactly that, which is the whole of what it
    // was for — two events under one id belonging to different sequences are different events.
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'commitrail' AND table_name = 'outbox_events'`,
    );

    const assignedByDatabase = ['event_id', 'source_sequence', 'transaction_id'];
    const comparedByIdentity = [
      'event_type',
      'event_version',
      'payload',
      'correlation_id',
      'causation_id',
      'subjects',
      'ordering_key',
      // Compared only when the caller supplied one — it defaults to now().
      'occurred_at',
    ];

    expect(rows.map((r) => r.column_name).sort()).toEqual(
      [...assignedByDatabase, ...comparedByIdentity].sort(),
    );
  });

  it('ships a schema that produces the table capture reads', async () => {
    // The DDL a customer applies must match what capture queries. Shipping it from the SDK
    // is what keeps those from being two documents that agree by memory.
    await pool.query(OUTBOX_SCHEMA_SQL);

    const { rows } = await pool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'commitrail' AND table_name = 'outbox_events'
       ORDER BY ordinal_position`,
    );

    // The set, not the order. A customer whose outbox predates a column gains it by ALTER,
    // which appends — so ordinal position legitimately differs between a fresh install and an
    // upgraded one, and asserting it would fail on exactly the customers who upgraded.
    expect(rows.map((r) => r.column_name).sort()).toEqual([
      'causation_id',
      'correlation_id',
      'event_id',
      'event_type',
      'event_version',
      'occurred_at',
      'ordering_key',
      'payload',
      'source_sequence',
      'subjects',
      'transaction_id',
    ]);
    expect(rows.find((r) => r.column_name === 'transaction_id')?.data_type).toBe('xid8');
  });
});
