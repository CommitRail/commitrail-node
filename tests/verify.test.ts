import { describe, expect, it } from 'vitest';
import { HEADERS, SPEC_VERSION, type CommitRailEvent } from 'commitrail';
/**
 * Reaching past the package's `exports` map on purpose.
 *
 * `signatureHeader` is not public: CommitRail signs from its own private implementation and a
 * customer never needs to sign anything. It stays exported from the module so tests can build a
 * genuine signed request, and `verify:package` asserts that a real consumer cannot import this
 * path — the `exports` map is the gate, not the absence of the symbol.
 */
import { signatureHeader } from 'commitrail/signing';
import { InvalidDeliveryError, verifyRequest } from 'commitrail/webhooks';

/**
 * The verifier a customer pastes into their middleware.
 *
 * It is worth more scrutiny than its size suggests: it is the only thing standing between a
 * webhook endpoint and anyone who can guess its URL, and it will be copied once and never
 * looked at again.
 */
describe('verifyRequest', () => {
  const secret = 'a-shared-secret-value-long-enough';
  const deliveryId = '7b1f4d2e-0000-4000-8000-000000000001';

  function delivery(overrides: Partial<CommitRailEvent> = {}, ageSeconds = 0) {
    const event: CommitRailEvent = {
      specVersion: SPEC_VERSION,
      id: 'producer-event-1',
      type: 'order.created',
      version: 1,
      occurredAt: '2026-08-20T09:00:00.000Z',
      delivery: { id: deliveryId, attempt: 1 },
      data: { orderId: 'order-1' },
      ...overrides,
    };

    const body = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000) - ageSeconds;

    return {
      body,
      // Every header the delivery worker actually sends, so a test about them is about the real
      // request rather than about a two-header subset nothing produces.
      headers: {
        [HEADERS.specVersion]: event.specVersion,
        [HEADERS.deliveryId]: deliveryId,
        [HEADERS.idempotencyKey]: deliveryId,
        [HEADERS.attemptId]: 'attempt-1',
        [HEADERS.attemptNumber]: String(event.delivery.attempt),
        [HEADERS.eventId]: event.id,
        [HEADERS.eventType]: event.type,
        [HEADERS.timestamp]: String(timestamp),
        [HEADERS.signature]: signatureHeader({
          timestamp,
          deliveryId,
          body,
          material: { current: { version: 1, secret } },
        }),
      } as Record<string, string>,
    };
  }

  it('returns the event when everything checks out', () => {
    const { headers, body } = delivery();

    const event = verifyRequest<{ orderId: string }>({ headers, body, secret });

    expect(event.type).toBe('order.created');
    expect(event.data.orderId).toBe('order-1');
    expect(event.delivery.id).toBe(deliveryId);
  });

  it('throws rather than returning false', () => {
    const { headers, body } = delivery();

    // A handler that forgets to check a boolean still fails closed this way. A handler that
    // forgets to check an exception does not compile past the first await.
    expect(() => verifyRequest({ headers, body, secret: 'the-wrong-secret-value-here' })).toThrow(
      InvalidDeliveryError,
    );
  });

  it('rejects a body altered after signing', () => {
    const { headers, body } = delivery();
    const tampered = body.replace('order-1', 'order-999');

    expect(() => verifyRequest({ headers, body: tampered, secret })).toThrow(InvalidDeliveryError);
  });

  it('rejects a request with no signature at all', () => {
    const { headers, body } = delivery();
    delete headers[HEADERS.signature];

    expect(() => verifyRequest({ headers, body, secret })).toThrow(/no signature header/);
  });

  it('rejects a body replayed under a different delivery id', () => {
    const { headers, body } = delivery();
    headers[HEADERS.deliveryId] = '7b1f4d2e-0000-4000-8000-000000000002';

    expect(() => verifyRequest({ headers, body, secret })).toThrow(InvalidDeliveryError);
  });

  it('rejects a body whose delivery id disagrees with the header', () => {
    const deliveryId2 = '7b1f4d2e-0000-4000-8000-000000000003';
    const event = { ...JSON.parse(delivery().body), delivery: { id: deliveryId2, attempt: 1 } };
    const body = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000);

    const headers = {
      [HEADERS.deliveryId]: deliveryId,
      [HEADERS.signature]: signatureHeader({
        timestamp,
        deliveryId,
        body,
        material: { current: { version: 1, secret } },
      }),
    };

    // Signature valid, contents inconsistent. Deduplication keys on the delivery id, so a
    // mismatch would let the same obligation be recorded under two identities.
    expect(() => verifyRequest({ headers, body, secret })).toThrow(/does not match/);
  });

  it('gives one message for every kind of failure', () => {
    const { headers, body } = delivery();

    const wrongSecret = grab(() =>
      verifyRequest({ headers, body, secret: 'nope-nope-nope-nope-nope' }),
    );
    const tampered = grab(() =>
      verifyRequest({ headers, body: body.replace('order-1', 'x'), secret }),
    );

    // Telling an attacker which check failed helps them and helps nobody else.
    expect(wrongSecret).toBe(tampered);
  });

  it('finds headers whatever case the framework preserved', () => {
    const { headers, body } = delivery();
    const upper = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key.toUpperCase(), value]),
    );

    expect(() => verifyRequest({ headers: upper, body, secret })).not.toThrow();
  });

  it('handles header values delivered as arrays', () => {
    const { headers, body } = delivery();
    const arrayed = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, [v]]));

    expect(() => verifyRequest({ headers: arrayed, body, secret })).not.toThrow();
  });

  /**
   * A spec version the verifier has never heard of must still verify.
   *
   * `SPEC_VERSION` travels in the envelope and in a header, and `verifyRequest` deliberately
   * does not read either. That is what allows the wire format to move at all: a customer's
   * verifier is installed once and left there, so if it refused an envelope carrying a
   * version it did not recognise, bumping `SPEC_VERSION` would break every deployed consumer
   * on the day we deployed — a flag day with no safe rollout order.
   *
   * This is the invariant most likely to be removed by someone trying to help. Adding
   * `if (event.specVersion !== SPEC_VERSION) throw` reads as tightening a lax verifier, and
   * every existing test would still pass, because they all send the matching version.
   */
  it('accepts an envelope from a spec version it does not know', () => {
    const { headers, body } = delivery({ specVersion: '99' });

    const event = verifyRequest({ headers, body, secret });

    expect(event.specVersion).toBe('99');
  });

  it('rejects a valid signature over a body that is not JSON', () => {
    const body = 'not json at all';
    const timestamp = Math.floor(Date.now() / 1000);

    const headers = {
      [HEADERS.deliveryId]: deliveryId,
      [HEADERS.signature]: signatureHeader({
        timestamp,
        deliveryId,
        body,
        material: { current: { version: 1, secret } },
      }),
    };

    expect(() => verifyRequest({ headers, body, secret })).toThrow(/valid JSON/);
  });

  it('rejects a stale request even with a correct signature', () => {
    const body = JSON.stringify({ delivery: { id: deliveryId } });
    const anHourAgo = Math.floor(Date.now() / 1000) - 3600;

    const headers = {
      [HEADERS.deliveryId]: deliveryId,
      [HEADERS.signature]: signatureHeader({
        timestamp: anHourAgo,
        deliveryId,
        body,
        material: { current: { version: 1, secret } },
      }),
    };

    // Without the timestamp bound, a captured request stays replayable forever.
    expect(() => verifyRequest({ headers, body, secret })).toThrow(InvalidDeliveryError);
  });

  describe('headers that are not signed', () => {
    /**
     * The envelope is signed; most of the headers are not.
     *
     * `canonicalPayload` covers the timestamp, the delivery id and the body. Everything else
     * CommitRail sends is a convenience copy of something inside the envelope, and an attacker
     * who cannot forge a signature can still edit those — no secret required, just the ability
     * to alter a request in flight or to replay one inside the tolerance window.
     *
     * The dangerous one is the idempotency key, because deduplicating on it is exactly what the
     * header is for.
     */
    it('rejects a delivery whose idempotency key was swapped', () => {
      const { body, headers } = delivery();

      // The signature still verifies: the body and the delivery id are untouched, and only the
      // unsigned copy changed. A consumer deduplicating on this header would treat a replay as
      // new work.
      headers[HEADERS.idempotencyKey] = '7b1f4d2e-0000-4000-8000-00000000dead';

      expect(() => verifyRequest({ headers, body, secret })).toThrow(/does not match the signed/);
    });

    it.each([
      [HEADERS.eventId, 'someone-elses-event'],
      [HEADERS.eventType, 'order.cancelled'],
      [HEADERS.attemptNumber, '99'],
      [HEADERS.specVersion, '2'],
      [HEADERS.timestamp, '1'],
    ])('rejects a delivery whose %s disagrees with the envelope', (name, forged) => {
      const { body, headers } = delivery();
      headers[name] = forged;

      expect(() => verifyRequest({ headers, body, secret })).toThrow(InvalidDeliveryError);
    });

    it('accepts a delivery that omits a convenience header entirely', () => {
      // Absent is not disagreement. CommitRail must stay free to stop sending one of these
      // without every deployed verifier refusing the delivery — the same reasoning that keeps
      // `specVersion` from ever being checked against this package's own constant.
      const { body, headers } = delivery();
      delete headers[HEADERS.eventType];
      delete headers[HEADERS.idempotencyKey];
      delete headers[HEADERS.specVersion];

      expect(verifyRequest({ headers, body, secret }).id).toBe('producer-event-1');
    });

    it('does not authenticate the attempt id', () => {
      // The one header with nothing in the envelope to check it against. Tolerated knowingly
      // rather than silently: a consumer must not make a decision on it.
      const { body, headers } = delivery();
      headers[HEADERS.attemptId] = 'anything-at-all';

      expect(() => verifyRequest({ headers, body, secret })).not.toThrow();
    });
  });

  describe('why it was rejected', () => {
    const codeOf = (work: () => unknown): string => {
      try {
        work();
        return 'no error';
      } catch (error) {
        return (error as InvalidDeliveryError).code;
      }
    };

    it.each([
      ['missing_signature', (h: Record<string, string>) => delete h[HEADERS.signature]],
      ['missing_delivery_id', (h: Record<string, string>) => delete h[HEADERS.deliveryId]],
      ['header_mismatch', (h: Record<string, string>) => (h[HEADERS.eventId] = 'wrong')],
    ])('reports %s', (code, breakIt) => {
      const { body, headers } = delivery();
      breakIt(headers);

      expect(codeOf(() => verifyRequest({ headers, body, secret }))).toBe(code);
    });

    it('separates a stale clock from a bad secret, without saying so in the message', () => {
      const { body, headers, timestamp } = delivery();
      const wrong = 'a-completely-different-secret-value';

      // The two an integrator most needs to tell apart, and they are fixed in completely
      // different places: one is a clock on one of the two machines, the other is the secret or
      // a re-serialised body.
      expect(codeOf(() => verifyRequest({ headers, body, secret: wrong }))).toBe(
        'signature_mismatch',
      );
      // Signed ten minutes ago: past the five-minute default, with a signature that is itself
      // perfectly good — which is exactly why the two need different codes.
      const stale = delivery({}, 600);
      expect(
        codeOf(() => verifyRequest({ headers: stale.headers, body: stale.body, secret })),
      ).toBe('timestamp_out_of_range');

      // The code is for logs; the message stays vague on purpose, because the common mistake is
      // echoing it to the caller — and a wrong secret, a stale timestamp and an altered body are
      // three different hints to hand an attacker.
      expect(grab(() => verifyRequest({ headers, body, secret: wrong }))).not.toMatch(
        /secret|timestamp|stale|expired|body/i,
      );
    });
  });
});

function grab(work: () => unknown): string {
  try {
    work();
    return 'no error';
  } catch (error) {
    return (error as Error).message;
  }
}
