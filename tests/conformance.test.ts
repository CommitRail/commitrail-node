import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  verifyReceiptSignatureHeader,
  verifySignatureHeader,
  SPEC_VERSION,
  HEADERS,
  SUBJECT_LIMITS,
} from 'commitrail';
import { normalizeSubjects } from 'commitrail/subjects';

/**
 * This verifier must accept what CommitRail's servers actually send.
 *
 * CommitRail's backend implements the same wire protocol from its own private code and imports
 * nothing from this package — deliberately, because a published SDK should be shaped by what
 * customers need rather than by what our servers need, and because a Go or Python verifier could
 * never have shared our functions anyway.
 *
 * `vectors/protocol.json` is what holds the two together. It is frozen and **it is the
 * specification**: the exact bytes, canonical strings and signatures for a set of events.
 * CommitRail's own sender is tested against the same file.
 *
 * **A failure here is never fixed by editing a vector.** It means this verifier stopped accepting
 * something CommitRail sends, or the protocol changed — and a protocol change is a new spec
 * version and a conversation, not an edit to a fixture.
 */
describe('conformance to the frozen protocol vectors', () => {
  const vectors = JSON.parse(
    readFileSync(path.resolve(__dirname, '../vectors/protocol.json'), 'utf8'),
  ) as {
    specVersion: string;
    headers: Record<string, string>;
    subjectLimits: Record<string, number>;
    secrets: { current: string; previous: string };
    timestamp: number;
    envelopes: {
      name: string;
      input: { deliveryId: string };
      body: string;
      signatureHeader: string;
      rotatingSignatureHeader: string;
    }[];
    receipts: {
      name: string;
      deliveryId: string;
      canonicalReceipt: string;
      signatureHeader: string;
      rotatingSignatureHeader: string;
    }[];
    subjectNormalisation: { name: string; input: unknown; output: unknown }[];
  };

  it('agrees on the spec version, headers and limits', () => {
    expect(SPEC_VERSION).toBe(vectors.specVersion);
    expect({ ...HEADERS }).toEqual(vectors.headers);
    expect({ ...SUBJECT_LIMITS }).toEqual(vectors.subjectLimits);
  });

  it.each(vectors.envelopes.map((v) => [v.name, v] as const))(
    'accepts the signature CommitRail produces for: %s',
    (_name, v) => {
      expect(
        verifySignatureHeader({
          header: v.signatureHeader,
          secret: vectors.secrets.current,
          deliveryId: v.input.deliveryId,
          body: v.body,
          now: vectors.timestamp,
        }),
      ).toBe(true);
    },
  );

  it.each(vectors.envelopes.map((v) => [v.name, v] as const))(
    'accepts either secret mid-rotation for: %s',
    (_name, v) => {
      // The header carries a signature under each secret, so verification is "does one of these
      // match mine" and neither side has to change at the same instant.
      for (const secret of [vectors.secrets.current, vectors.secrets.previous]) {
        expect(
          verifySignatureHeader({
            header: v.rotatingSignatureHeader,
            secret,
            deliveryId: v.input.deliveryId,
            body: v.body,
            now: vectors.timestamp,
          }),
        ).toBe(true);
      }
    },
  );

  it.each(vectors.envelopes.map((v) => [v.name, v] as const))(
    'rejects a body altered after signing: %s',
    (_name, v) => {
      expect(
        verifySignatureHeader({
          header: v.signatureHeader,
          secret: vectors.secrets.current,
          deliveryId: v.input.deliveryId,
          body: `${v.body} `,
          now: vectors.timestamp,
        }),
      ).toBe(false);
    },
  );

  it.each(vectors.receipts.map((v) => [v.name, v] as const))(
    'accepts the receipt probe CommitRail sends: %s',
    (_name, v) => {
      expect(
        verifyReceiptSignatureHeader({
          header: v.signatureHeader,
          secret: vectors.secrets.current,
          deliveryId: v.deliveryId,
          now: vectors.timestamp,
        }),
      ).toBe(true);
    },
  );

  it.each(vectors.receipts.map((v) => [v.name, v] as const))(
    'accepts either secret mid-rotation on a receipt probe: %s',
    (_name, v) => {
      for (const secret of [vectors.secrets.current, vectors.secrets.previous]) {
        expect(
          verifyReceiptSignatureHeader({
            header: v.rotatingSignatureHeader,
            secret,
            deliveryId: v.deliveryId,
            now: vectors.timestamp,
          }),
        ).toBe(true);
      }
    },
  );

  /**
   * The domain separation, checked as a property rather than described.
   *
   * A receipt probe is signed over `receipt.<t>.<id>` and a delivery over `<t>.<id>.<body>`. The
   * delivery form begins with digits and cannot produce the `receipt.` prefix for any input, so
   * neither signature can ever be presented as the other. Asserting it here means the claim
   * survives somebody "simplifying" one of the two canonical strings.
   */
  it.each(vectors.receipts.map((v) => [v.name, v] as const))(
    'will not accept a receipt signature as a delivery, or the reverse: %s',
    (_name, v) => {
      expect(
        verifySignatureHeader({
          header: v.signatureHeader,
          secret: vectors.secrets.current,
          deliveryId: v.deliveryId,
          // An empty body — the shape the rejected design would have signed.
          body: '',
          now: vectors.timestamp,
        }),
      ).toBe(false);

      const delivery = vectors.envelopes[0]!;

      expect(
        verifyReceiptSignatureHeader({
          header: delivery.signatureHeader,
          secret: vectors.secrets.current,
          deliveryId: delivery.input.deliveryId,
          now: vectors.timestamp,
        }),
      ).toBe(false);
    },
  );

  it.each(vectors.receipts.map((v) => [v.name, v] as const))(
    'will not answer for a different delivery than the one signed for: %s',
    (_name, v) => {
      expect(
        verifyReceiptSignatureHeader({
          header: v.signatureHeader,
          secret: vectors.secrets.current,
          deliveryId: `${v.deliveryId}-x`,
          now: vectors.timestamp,
        }),
      ).toBe(false);
    },
  );

  it.each(vectors.subjectNormalisation.map((c) => [c.name, c] as const))(
    'normalises subjects the same way CommitRail does: %s',
    (_name, c) => {
      // Both sides normalise — here before the outbox write, and again at acceptance — so a
      // disagreement means a producer's own subjects change under it.
      expect(normalizeSubjects(c.input)).toEqual(c.output);
    },
  );
});
