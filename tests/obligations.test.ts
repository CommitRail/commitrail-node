import { describe, expect, it } from 'vitest';
import { InvalidObligationsError, OBLIGATION_LIMITS } from '../src/obligations.js';
import { normalizeObligations } from '../src/obligations.js';

/**
 * What an event says the business owes, validated where it is written.
 *
 * The whole point of refusing here is *where* the refusal lands. An obligation named on an event
 * is written inside the caller's transaction, so throwing rolls back the business state that named
 * it — the order is not placed, and the line that wrote the bad name is in the stack trace. The
 * alternative is a row that cannot be accepted, discovered by a capture worker on the far side of
 * a network, with nothing left to connect it to the code that produced it.
 */
describe('obligations declared on an event', () => {
  it('keeps what was named, in the order it was named', () => {
    expect(normalizeObligations(['record-in-ledger', 'send-to-customer'])).toEqual([
      'record-in-ledger',
      'send-to-customer',
    ]);
  });

  it('treats naming nothing and naming an empty list as the same thing', () => {
    // Null rather than an empty array, so an event that owes nothing is stored one way by every
    // producer — and so "owes nothing" cannot be confused with "something dropped the list".
    expect(normalizeObligations(undefined)).toBeNull();
    expect(normalizeObligations(null)).toBeNull();
    expect(normalizeObligations([])).toBeNull();
  });

  it('drops a duplicate without complaining about it', () => {
    // Producers assemble this from more than one code path, and naming one duty twice is one
    // duty. Refusing would make a correct program fail for saying something true twice.
    expect(normalizeObligations(['ship-it', 'ship-it', 'bill-it'])).toEqual(['ship-it', 'bill-it']);
  });

  it('trims, and refuses a name that is only whitespace', () => {
    expect(normalizeObligations([' ship-it '])).toEqual(['ship-it']);

    // The shape a template produces when the value it interpolated was missing. Left alone it
    // names an obligation no rail declares, and becomes a held event long after this returned.
    expect(() => normalizeObligations(['   '])).toThrow(InvalidObligationsError);
  });

  it('refuses anything that is not a list of names', () => {
    expect(() => normalizeObligations('record-in-ledger')).toThrow(InvalidObligationsError);
    expect(() => normalizeObligations([{ name: 'record-in-ledger' }])).toThrow(
      InvalidObligationsError,
    );
    expect(() => normalizeObligations([42])).toThrow(InvalidObligationsError);
  });

  it('bounds the count and the length, and says which limit was met', () => {
    const many = Array.from({ length: OBLIGATION_LIMITS.maxPerEvent + 1 }, (_, i) => `owed-${i}`);

    expect(() => normalizeObligations(many)).toThrow(/at most 100 obligations/);
    expect(() => normalizeObligations(['x'.repeat(OBLIGATION_LIMITS.maxNameLength + 1)])).toThrow(
      /at most 200 characters/,
    );
  });

  it('counts before deduplicating, so the limit is about what was sent', () => {
    // A hundred and one names that are all the same is still a producer that lost control of the
    // list. Deduplicating first would hide it, and the limit exists to stop pathological usage
    // rather than to tidy up after it.
    const same = Array.from({ length: OBLIGATION_LIMITS.maxPerEvent + 1 }, () => 'ship-it');

    expect(() => normalizeObligations(same)).toThrow(InvalidObligationsError);
  });

  it('is recognised across two copies of this package', () => {
    /**
     * The dual-package hazard, as it applies to this error.
     *
     * An application that reaches this package by both `import` and `require` holds two copies and
     * two distinct classes, and `instanceof` is false across them — for an error that is exactly
     * what it looks like. A second class is built here to stand in for the second copy.
     */
    const brand = Symbol.for('commitrail.InvalidObligationsError');

    class FromAnotherCopy extends Error {
      readonly [brand] = true;
    }

    expect(InvalidObligationsError.is(new FromAnotherCopy('x'))).toBe(true);
    expect(new FromAnotherCopy('x') instanceof InvalidObligationsError).toBe(false);
    expect(InvalidObligationsError.is(new Error('x'))).toBe(false);
  });
});
