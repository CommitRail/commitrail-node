import { InvalidSubjectsError, SUBJECT_LIMITS } from 'commitrail';
import { normalizeSubjects } from 'commitrail/subjects';
import { serialiseEnvelope } from 'commitrail/envelope';

/**
 * The subjects contract, at the one boundary that validates it.
 *
 * `normalizeSubjects` runs twice per event — in `emit()` before anything reaches the outbox,
 * and again at acceptance against whatever a raw producer actually wrote — so what it
 * accepts, drops and refuses IS the feature's input contract, and both call sites share it
 * on purpose: two validators is how the two ends of a pipeline drift.
 */
describe('normalizeSubjects', () => {
  it('canonicalises a valid list and preserves first-occurrence order', () => {
    expect(
      normalizeSubjects([
        { type: 'order', id: 'order_1264' },
        { type: 'payment', id: 'pay_991' },
      ]),
    ).toEqual([
      { type: 'order', id: 'order_1264' },
      { type: 'payment', id: 'pay_991' },
    ]);
  });

  it('treats undefined, null and an empty array as the same statement: no subjects', () => {
    expect(normalizeSubjects(undefined)).toBeNull();
    expect(normalizeSubjects(null)).toBeNull();
    expect(normalizeSubjects([])).toBeNull();
  });

  it('drops exact duplicates rather than rejecting them', () => {
    // Duplicates carry no meaning, and producers legitimately assemble subjects from more
    // than one code path. Refusing would turn a harmless redundancy into a lost event.
    expect(
      normalizeSubjects([
        { type: 'order', id: 'order_1' },
        { type: 'order', id: 'order_1' },
      ]),
    ).toEqual([{ type: 'order', id: 'order_1' }]);
  });

  it('keeps two subjects of the same type — orders.merged is a real event', () => {
    expect(
      normalizeSubjects([
        { type: 'order', id: 'order_1' },
        { type: 'order', id: 'order_2' },
      ]),
    ).toHaveLength(2);
  });

  it('does not conflate subjects whose concatenations collide', () => {
    // 'ab'+'c' and 'a'+'bc' joined naively are the same string. If the dedupe key were that
    // string, one of these would silently vanish.
    expect(
      normalizeSubjects([
        { type: 'ab', id: 'c' },
        { type: 'a', id: 'bc' },
      ]),
    ).toHaveLength(2);
  });

  it('rejects a non-array and non-object elements', () => {
    expect(() => normalizeSubjects({ type: 'order', id: 'x' })).toThrow(InvalidSubjectsError);
    expect(() => normalizeSubjects(['order/x'])).toThrow(InvalidSubjectsError);
    expect(() => normalizeSubjects([null])).toThrow(InvalidSubjectsError);
    expect(() => normalizeSubjects([['order', 'x']])).toThrow(InvalidSubjectsError);
  });

  it('rejects an empty or non-string type or id', () => {
    expect(() => normalizeSubjects([{ type: '', id: 'x' }])).toThrow(InvalidSubjectsError);
    expect(() => normalizeSubjects([{ type: 'order', id: '' }])).toThrow(InvalidSubjectsError);
    expect(() => normalizeSubjects([{ type: 'order', id: 123 }])).toThrow(InvalidSubjectsError);
    expect(() => normalizeSubjects([{ type: 'order' }])).toThrow(InvalidSubjectsError);
  });

  it('enforces the length limits without truncating', () => {
    const longType = 'a'.repeat(SUBJECT_LIMITS.maxTypeLength + 1);
    const longId = 'b'.repeat(SUBJECT_LIMITS.maxIdLength + 1);

    expect(() => normalizeSubjects([{ type: longType, id: 'x' }])).toThrow(InvalidSubjectsError);
    expect(() => normalizeSubjects([{ type: 'order', id: longId }])).toThrow(InvalidSubjectsError);

    // At the limit exactly is fine — the limit is a ceiling, not a fencepost trap.
    expect(
      normalizeSubjects([
        {
          type: 'a'.repeat(SUBJECT_LIMITS.maxTypeLength),
          id: 'b'.repeat(SUBJECT_LIMITS.maxIdLength),
        },
      ]),
    ).toHaveLength(1);
  });

  it('enforces the count limit after deduplication', () => {
    const tooMany = Array.from({ length: SUBJECT_LIMITS.maxPerEvent + 1 }, (_, i) => ({
      type: 'order',
      id: `order_${i}`,
    }));
    expect(() => normalizeSubjects(tooMany)).toThrow(InvalidSubjectsError);

    // The same list with duplicates folding it under the limit is fine: the limit bounds
    // what is stored, and duplicates store nothing.
    const duplicated = [...tooMany.slice(0, SUBJECT_LIMITS.maxPerEvent), tooMany[0]!];
    expect(normalizeSubjects(duplicated)).toHaveLength(SUBJECT_LIMITS.maxPerEvent);
  });
});

describe('subjects on the envelope', () => {
  const base = {
    id: 'evt-1',
    type: 'order.created',
    version: 1,
    occurredAt: '2026-08-27T00:00:00.000Z',
    deliveryId: 'delivery-1',
    attempt: 1,
    data: '{"a":1}',
  };

  it('keeps the exact bytes an envelope without subjects has always had', () => {
    // The serialised bytes are what gets signed, so this is the compatibility contract:
    // a producer that declares no subjects must sign and send what it did before this
    // member existed, or deploying the server breaks every deployed verifier at once.
    const before =
      '{"specVersion":"1","id":"evt-1","type":"order.created","version":1,' +
      '"occurredAt":"2026-08-27T00:00:00.000Z","delivery":{"id":"delivery-1","attempt":1},"data":{"a":1}}';

    expect(serialiseEnvelope(base)).toBe(before);
    expect(serialiseEnvelope({ ...base, subjects: null })).toBe(before);
    expect(serialiseEnvelope({ ...base, subjects: [] })).toBe(before);
  });

  it('adds subjects to the fixed order rather than inserting into it', () => {
    expect(serialiseEnvelope({ ...base, subjects: [{ type: 'order', id: 'order_1264' }] })).toBe(
      '{"specVersion":"1","id":"evt-1","type":"order.created","version":1,' +
        '"occurredAt":"2026-08-27T00:00:00.000Z",' +
        '"subjects":[{"type":"order","id":"order_1264"}],' +
        '"delivery":{"id":"delivery-1","attempt":1},"data":{"a":1}}',
    );
  });
});
