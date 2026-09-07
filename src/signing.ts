import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SigningSecret {
  version: number;
  secret: string;
}

export interface SigningMaterial {
  current: SigningSecret;
  /** Present only while a rotation is in progress. */
  previous?: SigningSecret;
}

/**
 * The canonical string a signature covers.
 *
 * It includes the delivery id, so a captured body cannot be replayed as a different obligation.
 */
export function canonicalPayload(input: {
  timestamp: number;
  deliveryId: string;
  body: string;
}): string {
  return `${input.timestamp}.${input.deliveryId}.${input.body}`;
}

/**
 * The same thing, as bytes, for a caller who has the raw body and has not decoded it.
 *
 * A signature is over bytes. Decoding to a string and re-encoding round-trips exactly for the
 * valid UTF-8 that JSON must be, so the two agree — but making the caller decode first asks them
 * to do something the contract does not need, and `.toString()` with a forgotten or wrong
 * encoding is a real way to break verification for reasons nobody can see.
 *
 * Returns `Uint8Array` rather than `Buffer`, so that compiling against this package does not
 * require `@types/node`.
 */
export function canonicalPayloadBytes(input: {
  timestamp: number;
  deliveryId: string;
  body: Uint8Array;
}): Uint8Array {
  return Buffer.concat([
    Buffer.from(`${input.timestamp}.${input.deliveryId}.`, 'utf8'),
    Buffer.from(input.body.buffer, input.body.byteOffset, input.body.byteLength),
  ]);
}

/**
 * The canonical string a *receipt probe's* signature covers.
 *
 * A receipt probe asks whether you already hold a delivery, and carries no body.
 *
 * **The two forms are domain-separated structurally.** A delivery's canonical string begins with
 * a timestamp, which is digits; this one begins with the literal `receipt.`, which the delivery
 * form cannot produce for any input. So a signature captured from a delivery can never be
 * presented as a probe, and a probe's can never be presented as a delivery.
 */
export function canonicalReceipt(input: { timestamp: number; deliveryId: string }): string {
  return `receipt.${input.timestamp}.${input.deliveryId}`;
}

export function sign(secret: string, canonical: string | Uint8Array): string {
  return createHmac('sha256', secret).update(canonical).digest('hex');
}

/**
 * Build the `CommitRail-Signature` header.
 *
 * During a rotation this carries a signature under each secret, so a consumer's
 * verification is "does one of these match mine". That code never has to know about
 * versions and never changes shape when a secret rotates — which matters more than
 * elegance for something that gets pasted into middleware once and left there.
 */
export function signatureHeader(input: {
  timestamp: number;
  deliveryId: string;
  body: string;
  material: SigningMaterial;
}): string {
  const canonical = canonicalPayload(input);

  const signatures = [input.material.current, input.material.previous]
    .filter((s): s is SigningSecret => s !== undefined)
    .map((s) => `v1=${sign(s.secret, canonical)}`);

  return [`t=${input.timestamp}`, ...signatures].join(',');
}

/** Verify a signature header: the timestamp is in tolerance and one `v1=` part matches. */
export function verifySignatureHeader(input: {
  header: string;
  secret: string;
  deliveryId: string;
  /** The raw body. Bytes are preferred; a string is decoded UTF-8 and equivalent for JSON. */
  body: string | Uint8Array;
  toleranceSeconds?: number;
  now?: number;
}): boolean {
  const tolerance = input.toleranceSeconds ?? 300;
  const now = input.now ?? Math.floor(Date.now() / 1000);

  const parts = input.header.split(',').map((p) => p.trim());
  const timestampPart = parts.find((p) => p.startsWith('t='));

  if (timestampPart === undefined) {
    return false;
  }

  const timestamp = parseTimestamp(timestampPart.slice(2));

  // Bounds replay. A signature stays valid forever otherwise, and a captured request could
  // be resent indefinitely. The bound is inclusive and symmetric: a delivery exactly `tolerance`
  // seconds either side of now is accepted.
  if (timestamp === undefined || Math.abs(now - timestamp) > tolerance) {
    return false;
  }

  const expected = sign(
    input.secret,
    typeof input.body === 'string'
      ? canonicalPayload({ timestamp, deliveryId: input.deliveryId, body: input.body })
      : canonicalPayloadBytes({ timestamp, deliveryId: input.deliveryId, body: input.body }),
  );

  return parts
    .filter((p) => p.startsWith('v1='))
    .some((p) => equalsConstantTime(p.slice(3), expected));
}

/**
 * Verify a receipt probe's signature header.
 *
 * The same shape as `verifySignatureHeader` — same strict `t=`, same inclusive tolerance, same
 * "does one of these `v1=` parts match", same silence about parts it does not recognise. Only
 * the canonical string differs.
 */
export function verifyReceiptSignatureHeader(input: {
  header: string;
  secret: string;
  deliveryId: string;
  toleranceSeconds?: number;
  now?: number;
}): boolean {
  const tolerance = input.toleranceSeconds ?? 300;
  const now = input.now ?? Math.floor(Date.now() / 1000);

  const parts = input.header.split(',').map((p) => p.trim());
  const timestampPart = parts.find((p) => p.startsWith('t='));

  if (timestampPart === undefined) {
    return false;
  }

  const timestamp = parseTimestamp(timestampPart.slice(2));

  if (timestamp === undefined || Math.abs(now - timestamp) > tolerance) {
    return false;
  }

  const expected = sign(
    input.secret,
    canonicalReceipt({ timestamp, deliveryId: input.deliveryId }),
  );

  return parts
    .filter((p) => p.startsWith('v1='))
    .some((p) => equalsConstantTime(p.slice(3), expected));
}

function equalsConstantTime(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');

  // Length must be compared first — timingSafeEqual throws on a mismatch — and leaking the
  // length of a hex digest tells an attacker nothing.
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The `t=` value, parsed strictly.
 *
 * `Number.parseInt` is lenient: it reads `1787000000.5` and `1787000000junk` as 1787000000, so
 * three different header strings would verify against one signature. The signature is computed
 * over the parsed integer, so nothing about the body or the window changes — but an independently
 * written verifier with a strict parse would reject what this one accepts, and two verifiers
 * disagreeing about one header is the difference nobody can see.
 *
 * Digits only. A negative timestamp is refused here rather than by the tolerance check, which
 * makes the rule one sentence instead of two.
 */
function parseTimestamp(value: string): number | undefined {
  if (!/^\d+$/.test(value)) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);

  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
