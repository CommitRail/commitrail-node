import { describe, expect, it } from 'vitest';
import { HEADERS, SPEC_VERSION, verifySignatureHeader, type CommitRailEvent } from 'commitrail';
import { InvalidDeliveryError, verifyRequest } from 'commitrail/webhooks';
import { signatureHeader, sign, canonicalPayload } from 'commitrail/signing';

/**
 * Adversarial input to the verifier, which is the thing standing between a webhook endpoint and
 * anyone who can guess its URL.
 *
 * The conformance vectors pin the happy path: given this event and this secret, these bytes. They
 * say almost nothing about malformed input, and malformed input is where an independently written
 * verifier — the Go one somebody builds from PROTOCOL.md — is most likely to diverge from this
 * one. So every case here is also a statement the specification has to make.
 *
 * The rule throughout: **anything not exactly right is rejected**, and rejection is the only
 * outcome. There is no input for which "accept" is the merciful answer.
 */
describe('the verifier under hostile input', () => {
  const secret = 'a-shared-secret-value-long-enough';
  const deliveryId = '7b1f4d2e-0000-4000-8000-000000000001';
  const body = '{"orderId":"o-1"}';

  const at = (timestamp: number) =>
    signatureHeader({ timestamp, deliveryId, body, material: { current: { version: 1, secret } } });

  const check = (header: string, now = 1787000000, over = body) =>
    verifySignatureHeader({ header, secret, deliveryId, body: over, now });

  describe('parsing the signature header', () => {
    it.each([
      ['empty', ''],
      ['no parts at all', ','],
      ['only a timestamp', 't=1787000000'],
      [
        'only a signature',
        'v1=' + sign(secret, canonicalPayload({ timestamp: 1787000000, deliveryId, body })),
      ],
      ['timestamp not a number', 't=abc,v1=' + 'a'.repeat(64)],
      ['timestamp empty', 't=,v1=' + 'a'.repeat(64)],
      ['spaces around the equals', 't = 1787000000, v1 = ' + 'a'.repeat(64)],
      ['uppercase part names', 'T=1787000000,V1=' + 'a'.repeat(64)],
      ['a signature that is not hex', 't=1787000000,v1=zzzz'],
      ['a signature of the wrong length', 't=1787000000,v1=abcd'],
    ])('rejects a header that is %s', (_name, header) => {
      expect(check(header)).toBe(false);
    });

    it('rejects an uppercase hex signature', () => {
      // The specification says lowercase hex. An implementation comparing case-insensitively
      // would accept a signature this one rejects, which is a divergence a customer would meet
      // only in production.
      const valid = at(1787000000);
      expect(check(valid)).toBe(true);
      expect(check(valid.toUpperCase())).toBe(false);
    });

    it('tolerates whitespace between parts, because HTTP does', () => {
      const valid = at(1787000000);
      expect(check(valid.replace(/,/g, ', '))).toBe(true);
    });

    it('does not blow up on an enormous header', () => {
      const flood = `t=1787000000,${'v1=' + 'a'.repeat(64) + ','.repeat(1)}`.repeat(20_000);
      expect(check(flood)).toBe(false);
    });
  });

  describe('multiple and unknown signature parts', () => {
    it('accepts when any v1 matches, wherever it sits', () => {
      const good = at(1787000000).split(',')[1]!;
      const bad = `v1=${'0'.repeat(64)}`;

      expect(check(`t=1787000000,${good},${bad}`)).toBe(true);
      expect(check(`t=1787000000,${bad},${good}`)).toBe(true);
      expect(check(`t=1787000000,${bad},${bad}`)).toBe(false);
    });

    it('ignores a scheme it has never seen', () => {
      // The upgrade path. A verifier that rejects unrecognised parts closes it for everyone.
      const good = at(1787000000).split(',')[1]!;
      expect(check(`t=1787000000,${good},v2=whatever,v99=${'f'.repeat(128)}`)).toBe(true);
    });

    it('is not satisfied by a v2 alone', () => {
      expect(check(`t=1787000000,v2=${'a'.repeat(64)}`)).toBe(false);
    });
  });

  describe('the replay window', () => {
    const t = 1787000000;

    it.each([
      ['exactly at the tolerance, in the past', t - 300, true],
      ['one second beyond it', t - 301, false],
      ['exactly at the tolerance, in the future', t + 300, true],
      ['one second beyond it, in the future', t + 301, false],
    ])('%s', (_name, signedAt, accepted) => {
      // The boundary is inclusive and symmetric. A verifier that made it exclusive would reject
      // deliveries this one accepts, at a rate that depends on clock drift.
      expect(check(at(signedAt), t)).toBe(accepted);
    });

    it.each([
      ['negative', '-1787000000'],
      ['zero', '0'],
      ['far beyond any clock', '99999999999999999999'],
      ['a float', '1787000000.5'],
      ['hex', '0x6a7c1e00'],
      ['with trailing junk', '1787000000junk'],
    ])('rejects a timestamp that is %s', (_name, timestamp) => {
      const good = at(t).split(',')[1]!;
      expect(check(`t=${timestamp},${good}`, t)).toBe(false);
    });
  });

  describe('the body', () => {
    it('rejects a body that differs by one byte, one space, or one reordering', () => {
      const header = at(1787000000);

      expect(check(header, 1787000000, body)).toBe(true);
      expect(check(header, 1787000000, `${body} `)).toBe(false);
      expect(check(header, 1787000000, ' ' + body)).toBe(false);
      expect(check(header, 1787000000, '{"orderId":"o-2"}')).toBe(false);
      // The re-serialisation trap: same object, different bytes.
      expect(check(header, 1787000000, JSON.stringify(JSON.parse(body), null, 2))).toBe(false);
    });

    it('rejects an empty body signed for a non-empty one', () => {
      expect(check(at(1787000000), 1787000000, '')).toBe(false);
    });
  });

  describe('verifyRequest on top of it', () => {
    const envelope = (overrides: Partial<CommitRailEvent> = {}): CommitRailEvent => ({
      specVersion: SPEC_VERSION,
      id: 'evt_1',
      type: 'order.created',
      version: 1,
      occurredAt: '2026-08-20T09:00:00.000Z',
      delivery: { id: deliveryId, attempt: 1 },
      data: { orderId: 'o-1' },
      ...overrides,
    });

    const request = (event: unknown) => {
      const raw = JSON.stringify(event);
      const timestamp = Math.floor(Date.now() / 1000);

      return {
        body: raw,
        headers: {
          [HEADERS.deliveryId]: deliveryId,
          [HEADERS.signature]: signatureHeader({
            timestamp,
            deliveryId,
            body: raw,
            material: { current: { version: 1, secret } },
          }),
        } as Record<string, string>,
      };
    };

    const codeOf = (work: () => unknown) => {
      try {
        work();
        return 'no error';
      } catch (error) {
        return (error as InvalidDeliveryError).code;
      }
    };

    it.each([
      ['null', null],
      ['a number', 42],
      ['a string', 'hello'],
      ['an array', [1, 2, 3]],
      ['an object with no delivery', { specVersion: '1', id: 'e' }],
      ['a delivery that is not an object', { delivery: 'nope' }],
      ['a delivery with no id', { delivery: { attempt: 1 } }],
      ['a delivery id that is a number', { delivery: { id: 7, attempt: 1 } }],
    ])('rejects a correctly signed envelope that is %s', (_name, shape) => {
      // Correctly signed and structurally wrong. The signature says the bytes came from
      // CommitRail; it says nothing about whether they mean anything. Every one of these must
      // arrive as an InvalidDeliveryError — `null` used to reach `null.delivery` and throw a
      // TypeError, which a handler checking `InvalidDeliveryError.is` would rethrow as a 500.
      const { body: raw, headers } = request(shape);
      const code = codeOf(() => verifyRequest({ headers, body: raw, secret }));

      expect(['malformed_body', 'header_mismatch']).toContain(code);
    });

    it('rejects a body that is valid bytes and invalid JSON', () => {
      const raw = '{"orderId":';
      const timestamp = Math.floor(Date.now() / 1000);
      const headers = {
        [HEADERS.deliveryId]: deliveryId,
        [HEADERS.signature]: signatureHeader({
          timestamp,
          deliveryId,
          body: raw,
          material: { current: { version: 1, secret } },
        }),
      };

      expect(codeOf(() => verifyRequest({ headers, body: raw, secret }))).toBe('malformed_body');
    });

    it('takes the first value when a header arrives more than once', () => {
      // A proxy can duplicate a header. Whichever is chosen, the choice must be deterministic and
      // the signature must still be checked against it.
      const { body: raw, headers } = request(envelope());
      const doubled = { ...headers, [HEADERS.deliveryId]: [deliveryId, 'someone-elses-id'] };

      expect(verifyRequest({ headers: doubled, body: raw, secret }).id).toBe('evt_1');
    });

    it('rejects when the first of a duplicated delivery id is the wrong one', () => {
      const { body: raw, headers } = request(envelope());
      const doubled = { ...headers, [HEADERS.deliveryId]: ['someone-elses-id', deliveryId] };

      expect(codeOf(() => verifyRequest({ headers: doubled, body: raw, secret }))).toBe(
        'signature_mismatch',
      );
    });

    it('accepts a spec version it has never seen', () => {
      // SPEC_VERSION must be able to move without every deployed verifier refusing deliveries.
      const { body: raw, headers } = request(envelope({ specVersion: '99' }));
      expect(verifyRequest({ headers, body: raw, secret }).specVersion).toBe('99');
    });
  });
});
