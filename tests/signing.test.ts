import { describe, expect, it } from 'vitest';
import { verifySignatureHeader } from 'commitrail';
/**
 * Reaching past the package's `exports` map on purpose.
 *
 * `signatureHeader` is not public: CommitRail signs from its own private implementation and a
 * customer never needs to sign anything. It stays exported from the module so tests can build a
 * genuine signed request, and `verify:package` asserts that a real consumer cannot import this
 * path — the `exports` map is the gate, not the absence of the symbol.
 */
import { canonicalPayload, signatureHeader } from 'commitrail/signing';

/**
 * The signature contract, verified the way a consumer would verify it.
 *
 * These live in the SDK because the SDK is what a consumer imports, and CommitRail signs
 * with the same code it publishes for verifying. There is no second implementation to
 * drift from this one.
 */
describe('request signing', () => {
  const material = { current: { version: 2, secret: 'current-secret' } };
  const base = { timestamp: 1_774_000_000, deliveryId: 'delivery-1', body: '{"a":1}' };

  it('binds the timestamp, delivery id and body together', () => {
    expect(canonicalPayload(base)).toBe('1774000000.delivery-1.{"a":1}');
  });

  it('produces a header a consumer can verify', () => {
    const header = signatureHeader({ ...base, material });

    expect(
      verifySignatureHeader({
        header,
        secret: 'current-secret',
        deliveryId: base.deliveryId,
        body: base.body,
        now: base.timestamp,
      }),
    ).toBe(true);
  });

  it('rejects a signature made with a different secret', () => {
    const header = signatureHeader({ ...base, material });

    expect(
      verifySignatureHeader({
        header,
        secret: 'someone-elses-secret',
        deliveryId: base.deliveryId,
        body: base.body,
        now: base.timestamp,
      }),
    ).toBe(false);
  });

  it('rejects a body that was altered after signing', () => {
    const header = signatureHeader({ ...base, material });

    expect(
      verifySignatureHeader({
        header,
        secret: 'current-secret',
        deliveryId: base.deliveryId,
        body: '{"a":2}',
        now: base.timestamp,
      }),
    ).toBe(false);
  });

  it('rejects a body replayed under a different delivery id', () => {
    const header = signatureHeader({ ...base, material });

    // Why the delivery id is inside the canonical string: without it, a captured request
    // could be resent as some other obligation and still verify.
    expect(
      verifySignatureHeader({
        header,
        secret: 'current-secret',
        deliveryId: 'delivery-2',
        body: base.body,
        now: base.timestamp,
      }),
    ).toBe(false);
  });

  it('rejects a signature older than the tolerance', () => {
    const header = signatureHeader({ ...base, material });

    expect(
      verifySignatureHeader({
        header,
        secret: 'current-secret',
        deliveryId: base.deliveryId,
        body: base.body,
        toleranceSeconds: 300,
        now: base.timestamp + 3600,
      }),
    ).toBe(false);
  });

  describe('rotation', () => {
    const rotating = {
      current: { version: 3, secret: 'new-secret' },
      previous: { version: 2, secret: 'old-secret' },
    };

    it('sends a signature under each secret while rotating', () => {
      const header = signatureHeader({ ...base, material: rotating });

      expect(header.match(/v1=/g)).toHaveLength(2);
    });

    it('verifies for a consumer who has already moved to the new secret', () => {
      const header = signatureHeader({ ...base, material: rotating });

      expect(
        verifySignatureHeader({
          header,
          secret: 'new-secret',
          deliveryId: base.deliveryId,
          body: base.body,
          now: base.timestamp,
        }),
      ).toBe(true);
    });

    it('verifies for a consumer who has not moved yet', () => {
      const header = signatureHeader({ ...base, material: rotating });

      // The point of rotation: neither side has to change at the same instant, so rotating
      // a secret stops being a breaking operational event.
      expect(
        verifySignatureHeader({
          header,
          secret: 'old-secret',
          deliveryId: base.deliveryId,
          body: base.body,
          now: base.timestamp,
        }),
      ).toBe(true);
    });

    it('stops accepting the old secret once rotation completes', () => {
      const header = signatureHeader({ ...base, material: { current: rotating.current } });

      expect(
        verifySignatureHeader({
          header,
          secret: 'old-secret',
          deliveryId: base.deliveryId,
          body: base.body,
          now: base.timestamp,
        }),
      ).toBe(false);
    });
  });

  /**
   * The escape hatch from a flag day, and the reason the `v1=` prefix exists at all.
   *
   * Once a customer runs `npm install commitrail`, we can no longer upgrade their dependency
   * when we deploy. A signing scheme therefore cannot be *replaced* — it has to ship
   * alongside, as `t=…,v1=…,v2=…`, so a verifier installed months ago keeps matching `v1`
   * while a newer one prefers `v2`. That only works because verification filters for the
   * prefix it knows instead of rejecting a header it does not fully recognise.
   *
   * Nothing enforced this. `verifySignatureHeader` doing `parts.filter(p =>
   * p.startsWith('v1='))` reads like an implementation detail, and tightening it to reject
   * unknown parts would look like hardening a loose parser. It would in fact remove the only
   * path by which the signature scheme can ever change without breaking every deployed
   * consumer at once. See `docs/sdk-distribution-design.md`.
   */
  describe('tolerating a scheme it has not seen', () => {
    it('verifies v1 even when a future scheme rides along', () => {
      const header = `${signatureHeader({ ...base, material })},v2=deadbeef`;

      expect(
        verifySignatureHeader({
          header,
          secret: 'current-secret',
          deliveryId: base.deliveryId,
          body: base.body,
          now: base.timestamp,
        }),
      ).toBe(true);
    });

    it('ignores an unknown part rather than treating it as a candidate', () => {
      // The other direction: an unrecognised part must not be able to *pass* verification
      // either. Tolerance is "skip what you do not understand", never "accept it".
      const header = `t=${base.timestamp},v2=${'0'.repeat(64)}`;

      expect(
        verifySignatureHeader({
          header,
          secret: 'current-secret',
          deliveryId: base.deliveryId,
          body: base.body,
          now: base.timestamp,
        }),
      ).toBe(false);
    });
  });

  it('rejects a malformed header rather than throwing', () => {
    for (const header of ['', 'garbage', 'v1=abc', 't=notanumber,v1=abc']) {
      expect(
        verifySignatureHeader({
          header,
          secret: 'current-secret',
          deliveryId: base.deliveryId,
          body: base.body,
          now: base.timestamp,
        }),
      ).toBe(false);
    }
  });
});

describe('verifying raw bytes', () => {
  const secret = 'a-shared-secret-value-long-enough';
  const deliveryId = '7b1f4d2e-0000-4000-8000-000000000001';
  const timestamp = 1787000000;

  /**
   * A signature is over bytes, so the API takes bytes — and a string has to mean exactly the
   * same thing, or handing Express its Buffer instead of calling `.toString()` would change
   * whether a delivery verifies.
   */
  const headerFor = (body: string) =>
    signatureHeader({
      timestamp,
      deliveryId,
      body,
      material: { current: { version: 1, secret } },
    });

  it.each([
    ['ascii', '{"orderId":"o-1"}'],
    ['multi-byte characters', '{"name":"Ünïcødé — ✅ 日本語"}'],
    ['an emoji outside the BMP', '{"note":"🚀"}'],
  ])('accepts a Buffer and a string identically: %s', (_name, body) => {
    const header = headerFor(body);
    const args = { header, secret, deliveryId, now: timestamp };

    expect(verifySignatureHeader({ ...args, body })).toBe(true);
    expect(verifySignatureHeader({ ...args, body: Buffer.from(body, 'utf8') })).toBe(true);
    expect(verifySignatureHeader({ ...args, body: new TextEncoder().encode(body) })).toBe(true);
  });

  it('rejects bytes that differ by one', () => {
    const body = '{"orderId":"o-1"}';
    const bytes = Buffer.from(body, 'utf8');
    bytes[bytes.length - 2] = bytes[bytes.length - 2]! ^ 0x01;

    expect(
      verifySignatureHeader({
        header: headerFor(body),
        secret,
        deliveryId,
        body: bytes,
        now: timestamp,
      }),
    ).toBe(false);
  });

  it('reads a view into a larger buffer without reading past it', () => {
    // A framework may hand over a subarray of a pooled buffer. Reading the whole underlying
    // ArrayBuffer would sign the neighbouring bytes too, and fail for reasons nobody can see.
    const body = '{"orderId":"o-1"}';
    const padded = Buffer.concat([
      Buffer.from('XXXX'),
      Buffer.from(body, 'utf8'),
      Buffer.from('YY'),
    ]);
    const view = padded.subarray(4, 4 + Buffer.byteLength(body));

    expect(
      verifySignatureHeader({
        header: headerFor(body),
        secret,
        deliveryId,
        body: view,
        now: timestamp,
      }),
    ).toBe(true);
  });
});
