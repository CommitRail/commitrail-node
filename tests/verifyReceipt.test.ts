import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { InvalidDeliveryError, verifyReceipt } from 'commitrail/webhooks';

/**
 * The receipt probe verifier, from the caller's side.
 *
 * This is the one piece of CommitRail's protocol a customer would otherwise implement with
 * their own crypto — a timing-unsafe compare, a lenient timestamp parse, or a verifier that
 * rejects parts it does not recognise are all real mistakes, and all of them are ours to
 * prevent rather than theirs to avoid.
 *
 * Answering a probe is a disclosure: 200 tells the caller you hold that delivery. An endpoint
 * that does not verify hands anybody who can reach it a way to enumerate which delivery ids
 * exist, so every case below is about refusing rather than accepting.
 */
describe('verifyReceipt', () => {
  const secret = 'a-signing-secret-long-enough-to-use';
  const deliveryId = '5f6c1d2e-0000-4000-8000-0000000000aa';

  const sign = (value: string, key = secret) =>
    createHmac('sha256', key).update(value).digest('hex');

  const headersFor = (
    id = deliveryId,
    at = Math.floor(Date.now() / 1000),
    key = secret,
  ): Record<string, string> => ({
    'commitrail-delivery-id': id,
    'commitrail-timestamp': String(at),
    'commitrail-signature': `t=${at},v1=${sign(`receipt.${at}.${id}`, key)}`,
  });

  it('accepts a probe CommitRail signed', () => {
    expect(() => verifyReceipt({ headers: headersFor(), deliveryId, secret })).not.toThrow();
  });

  it('refuses a probe with no signature at all', () => {
    expect(() => verifyReceipt({ headers: {}, deliveryId, secret })).toThrow(InvalidDeliveryError);
  });

  it('refuses a signature under a different secret', () => {
    expect(() =>
      verifyReceipt({
        headers: headersFor(deliveryId, undefined, 'the-wrong-secret-also-long-enough'),
        deliveryId,
        secret,
      }),
    ).toThrow(/did not verify/);
  });

  /**
   * The reason `deliveryId` is a parameter rather than read from the headers.
   *
   * Verifying against the header would confirm only that the headers agree with each other,
   * while the handler looked up whatever the route said — so a probe signed for a delivery the
   * caller is entitled to ask about could be used to ask about one they are not.
   */
  it('refuses to answer about a delivery the signature does not cover', () => {
    try {
      verifyReceipt({
        headers: headersFor(),
        deliveryId: '5f6c1d2e-0000-4000-8000-0000000000bb',
        secret,
      });
      expect.unreachable();
    } catch (error) {
      expect((error as InvalidDeliveryError).code).toBe('header_mismatch');
    }

    // And with no id header at all, so the refusal rests on the signature rather than on the
    // two headers disagreeing.
    const at = Math.floor(Date.now() / 1000);

    expect(() =>
      verifyReceipt({
        headers: {
          'commitrail-signature': `t=${at},v1=${sign(`receipt.${at}.${deliveryId}`)}`,
        },
        deliveryId: '5f6c1d2e-0000-4000-8000-0000000000bb',
        secret,
      }),
    ).toThrow(/did not verify/);
  });

  it('refuses a stale probe, and accepts one exactly at the tolerance', () => {
    const now = Math.floor(Date.now() / 1000);

    try {
      verifyReceipt({ headers: headersFor(deliveryId, now - 301), deliveryId, secret });
      expect.unreachable();
    } catch (error) {
      // The code, not the message. `verifyReceiptSignatureHeader` refuses a stale probe on its
      // own, so asserting the message alone passes whether or not this check exists — and the
      // code is the whole reason it does: a stale timestamp during setup is a clock problem and
      // a mismatch is a secret problem, fixed in completely different places.
      expect((error as InvalidDeliveryError).code).toBe('timestamp_out_of_range');
    }

    // Inclusive and symmetric, the same bound the delivery verifier uses.
    expect(() =>
      verifyReceipt({ headers: headersFor(deliveryId, now - 300), deliveryId, secret }),
    ).not.toThrow();
  });

  /**
   * The `t=` value is digits only, and the suffixes below are what makes that testable.
   *
   * Each one signs over the *parsed* integer while presenting the lenient string, so a verifier
   * using `Number.parseInt` accepts it and a strict one refuses. Signing over the raw string
   * instead would be caught by the signature mismatch and would prove nothing about parsing —
   * which is exactly how the first version of this test passed against a lenient parse.
   *
   * Three header strings verifying against one signature is a divergence, and divergence between
   * verifiers written from the same document is the thing this protocol cannot afford.
   *
   * Surrounding whitespace is not in this list: parts are trimmed before parsing, here and in the
   * delivery verifier, because whitespace after a comma is ordinary in a header.
   */
  it.each(['.5', 'junk'])('refuses a timestamp with %j appended', (suffix) => {
    const at = Math.floor(Date.now() / 1000);

    expect(() =>
      verifyReceipt({
        headers: {
          'commitrail-signature': `t=${at}${suffix},v1=${sign(`receipt.${at}.${deliveryId}`)}`,
        },
        deliveryId,
        secret,
      }),
    ).toThrow(InvalidDeliveryError);
  });

  /**
   * The upgrade path, and the reason it is a test rather than a comment.
   *
   * A new scheme ships alongside as `t=…,v1=…,v2=…`. A verifier that rejects what it does not
   * recognise turns every future change into a flag day for every deployed consumer.
   */
  it('ignores a part it does not recognise rather than refusing', () => {
    const at = Math.floor(Date.now() / 1000);
    const headers = {
      'commitrail-signature': `t=${at},v1=${sign(`receipt.${at}.${deliveryId}`)},v2=whatever-comes-next`,
    };

    expect(() => verifyReceipt({ headers, deliveryId, secret })).not.toThrow();
  });

  it('accepts either secret while one is being rotated', () => {
    const at = Math.floor(Date.now() / 1000);
    const previous = 'the-previous-secret-also-long-enough';
    const canonical = `receipt.${at}.${deliveryId}`;
    const headers = {
      'commitrail-signature': `t=${at},v1=${sign(canonical)},v1=${sign(canonical, previous)}`,
    };

    for (const key of [secret, previous]) {
      expect(() => verifyReceipt({ headers, deliveryId, secret: key })).not.toThrow();
    }
  });

  /**
   * A delivery's signature must never open this endpoint.
   *
   * The two canonical forms are domain-separated structurally: a delivery's begins with a
   * timestamp, which is digits, and cannot produce the `receipt.` prefix for any body. Signing a
   * probe as a delivery-with-an-empty-body was the rejected design, and this is what makes the
   * rejection hold rather than depend on bodies never being empty.
   */
  it('refuses a delivery signature presented as a probe', () => {
    const at = Math.floor(Date.now() / 1000);
    const headers = {
      'commitrail-delivery-id': deliveryId,
      'commitrail-signature': `t=${at},v1=${sign(`${at}.${deliveryId}.`)}`,
    };

    expect(() => verifyReceipt({ headers, deliveryId, secret })).toThrow(InvalidDeliveryError);
  });

  it('names which check failed, for a log rather than a response', () => {
    try {
      verifyReceipt({ headers: {}, deliveryId, secret });
      expect.unreachable();
    } catch (error) {
      expect(InvalidDeliveryError.is(error)).toBe(true);
      expect((error as InvalidDeliveryError).code).toBe('missing_signature');
    }
  });
});
