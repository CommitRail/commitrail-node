import { HEADERS, type CommitRailEvent } from './envelope.js';
import { verifySignatureHeader } from './signing.js';

/** Registered globally by description, so every copy of this package agrees on it. */
const BRAND = Symbol.for('commitrail.InvalidDeliveryError');

/**
 * How much clock skew is tolerated by default, in seconds.
 *
 * Five minutes. It bounds replay: without it a captured request stays valid forever. Too tight
 * and ordinary clock drift between two correct machines starts rejecting real deliveries.
 */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** Why a delivery was rejected. Stable values — new ones may be added. */
export type InvalidDeliveryCode =
  | 'missing_signature'
  | 'missing_delivery_id'
  /** The signature header could not be parsed at all. */
  | 'malformed_signature'
  /** The signature was well formed but the timestamp is outside your tolerance. */
  | 'timestamp_out_of_range'
  /** The signature did not match: the wrong secret, or a body altered after signing. */
  | 'signature_mismatch'
  | 'malformed_body'
  /** A header CommitRail sent disagrees with the signed envelope. */
  | 'header_mismatch';

/**
 * A delivery that could not be trusted.
 *
 * `error instanceof InvalidDeliveryError` is the ordinary way to catch this and works in
 * every normal application. It can fail in one specific case, and the case is created by
 * this package being dual-published: an application that both `import`s and `require()`s
 * `commitrail` loads two copies, with two distinct classes, and an error thrown by one
 * is not an `instanceof` the other. `InvalidDeliveryError.is(error)` checks a shared
 * symbol instead and is true across copies.
 */
export class InvalidDeliveryError extends Error {
  static readonly brand = BRAND;

  readonly [BRAND] = true;

  /**
   * Which check failed, for your logs.
   *
   * The message stays deliberately vague about *why* a signature did not verify, because the
   * most common mistake is echoing it to the caller — and a wrong secret, a stale timestamp and
   * a tampered body are three very different hints to hand an attacker. The code exists so your
   * own logs do not have to be as careful as your responses.
   *
   * The distinction that matters in practice: `signature_invalid` after a deploy is almost
   * always the wrong secret, and `malformed_body` is almost always a framework that parsed and
   * re-serialised the body instead of giving you the bytes that were signed.
   *
   * Return a bare 400 or 401 to the caller. Log the code.
   */
  readonly code: InvalidDeliveryCode;

  constructor(code: InvalidDeliveryCode, reason: string) {
    super(`CommitRail delivery rejected: ${reason}`);
    this.name = 'InvalidDeliveryError';
    this.code = code;
  }

  static is(error: unknown): error is InvalidDeliveryError {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as Record<symbol, unknown>)[BRAND] === true
    );
  }
}

export interface VerifyRequestInput {
  /** Request headers, however your framework exposes them. Case-insensitive. */
  headers: Record<string, string | string[] | undefined>;

  /**
   * The RAW request body, exactly as received.
   *
   * Not a parsed object re-serialised: `JSON.stringify` of a parsed body can differ from
   * the bytes that were signed — key order, number formatting, whitespace — and the
   * signature would fail for no reason a reader could see. Most frameworks need to be told
   * to keep the raw body.
   *
   * Bytes are preferred, because a signature is over bytes: hand Express its `Buffer` or a
   * `Uint8Array` straight through rather than calling `.toString()`, which is one more place to
   * pick the wrong encoding. A string is accepted and equivalent — JSON is UTF-8, which
   * round-trips exactly.
   */
  body: string | Uint8Array;

  secret: string;

  /** How much clock skew to tolerate, in seconds. Defaults to five minutes. */
  toleranceSeconds?: number;
}

/**
 * Verify a delivery and return its event.
 *
 * Throws rather than returning false, so a handler that forgets to check the result still
 * fails closed.
 *
 * ```ts
 * app.post('/webhooks/commitrail', async (request, reply) => {
 *   const event = verifyRequest({
 *     headers: request.headers,
 *     body: request.rawBody,
 *     secret: process.env.COMMITRAIL_SIGNING_SECRET!,
 *   });
 *
 *   if (await alreadyProcessed(event.delivery.id)) return reply.code(200).send();
 *
 *   await handle(event);
 *   await recordProcessed(event.delivery.id);
 *   return reply.code(200).send();
 * });
 * ```
 *
 * The deduplication is not decoration. Delivery is at-least-once: a timeout or a dropped
 * connection means CommitRail never learned whether you processed the event, and it will
 * try again.
 */
export function verifyRequest<TData = unknown>(input: VerifyRequestInput): CommitRailEvent<TData> {
  const signature = header(input.headers, HEADERS.signature);
  const deliveryId = header(input.headers, HEADERS.deliveryId);

  if (signature === undefined) {
    throw new InvalidDeliveryError('missing_signature', 'no signature header');
  }

  if (deliveryId === undefined) {
    throw new InvalidDeliveryError('missing_delivery_id', 'no delivery id header');
  }

  /**
   * The timestamp first, and separately, so the code can say which it was.
   *
   * One *message* for every cryptographic failure is right: the common mistake is echoing it to
   * the caller, and "your clock is wrong" versus "your secret is wrong" are different hints to
   * hand an attacker. That argument does not extend to a field you have to read deliberately —
   * and these are the two an integrator most needs to tell apart, because a stale timestamp
   * during setup is a clock problem and a mismatch is a secret or a raw-body problem, and they
   * are fixed in completely different places.
   */
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const timestamp = signedTimestamp(signature);

  if (timestamp === undefined) {
    throw new InvalidDeliveryError('malformed_signature', 'signature did not verify');
  }

  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > tolerance) {
    throw new InvalidDeliveryError('timestamp_out_of_range', 'signature did not verify');
  }

  const valid = verifySignatureHeader({
    header: signature,
    secret: input.secret,
    deliveryId,
    body: input.body,
    toleranceSeconds: tolerance,
  });

  if (!valid) {
    throw new InvalidDeliveryError('signature_mismatch', 'signature did not verify');
  }

  let event: CommitRailEvent<TData>;

  try {
    event = JSON.parse(
      typeof input.body === 'string' ? input.body : Buffer.from(input.body).toString('utf8'),
    ) as CommitRailEvent<TData>;
  } catch {
    throw new InvalidDeliveryError('malformed_body', 'body was not valid JSON');
  }

  // Before touching a member of it. `JSON.parse('null')` is null and `null.delivery` is a
  // TypeError, not an InvalidDeliveryError — so a handler doing `if (InvalidDeliveryError.is(e))`
  // would miss it and rethrow, turning a rejected delivery into a 500. A verifier must never
  // throw a type its caller has not been told about.
  if (typeof event !== 'object' || event === null || Array.isArray(event)) {
    throw new InvalidDeliveryError('malformed_body', 'the body is not a CommitRail envelope');
  }

  if (event.delivery?.id !== deliveryId) {
    throw new InvalidDeliveryError(
      'header_mismatch',
      'delivery id in the body does not match the header',
    );
  }

  assertHeadersAgree(input.headers, event, signature);

  return event;
}

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  const value = Array.isArray(direct) ? direct[0] : direct;

  if (value !== undefined) {
    return value;
  }

  // Fall back to a case-insensitive scan for frameworks that preserve the original casing.
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  const found = match?.[1];

  return Array.isArray(found) ? found[0] : found;
}

/**
 * The envelope is signed. Most of the headers are not.
 *
 * `canonicalPayload` covers the timestamp, the delivery id and the body — so the body cannot be
 * altered and the delivery id cannot be swapped. Everything else CommitRail sends is a
 * convenience copy of something already inside the envelope, carried in a header so a consumer
 * can route or log without parsing. Those copies are **not** covered by the signature.
 *
 * That matters because the obvious thing to do with `commitrail-idempotency-key` is deduplicate
 * on it, and a value an attacker can edit is a poor thing to deduplicate on: replay a captured
 * delivery with a fresh key and a consumer trusting the header processes it twice; send two
 * genuine deliveries with one key and it drops one. Neither needs the signing secret.
 *
 * So every header that duplicates a signed field is checked against the envelope here, and the
 * advice becomes true rather than merely stated: after `verifyRequest` returns, the headers
 * agree with the envelope, and the envelope is what was signed.
 *
 * **Only a header that is present and disagrees is rejected.** An absent one is fine, and that is
 * deliberate: CommitRail must stay free to stop sending a convenience header without every
 * deployed verifier refusing the delivery. This is the same reasoning as `verifyRequest` never
 * reading `specVersion` to decide anything — comparing two things CommitRail sent is not the same
 * as requiring a particular version, and it must not quietly become that.
 *
 * `commitrail-attempt-id` is the one header with nothing in the envelope to check it against. It
 * stays unauthenticated; do not make a decision on it.
 */
function assertHeadersAgree(
  headers: VerifyRequestInput['headers'],
  event: CommitRailEvent<unknown>,
  signature: string,
): void {
  const timestamp = signedTimestamp(signature);

  const expected: [name: string, value: string | undefined][] = [
    [HEADERS.specVersion, event.specVersion],
    [HEADERS.idempotencyKey, event.delivery?.id],
    [HEADERS.eventId, event.id],
    [HEADERS.eventType, event.type],
    [HEADERS.attemptNumber, event.delivery?.attempt?.toString()],
    [HEADERS.timestamp, timestamp?.toString()],
  ];

  for (const [name, value] of expected) {
    const sent = header(headers, name);

    if (sent !== undefined && sent !== value) {
      // Named, because unlike a signature failure this one tells an attacker nothing they did
      // not already choose — and it is the sort of thing a proxy causes by rewriting headers.
      throw new InvalidDeliveryError(
        'header_mismatch',
        `${name} does not match the signed envelope`,
      );
    }
  }
}

/** The `t=` a signature header carries, which is authenticated: it is inside the signed string. */
function signedTimestamp(header: string): number | undefined {
  const part = header
    .split(',')
    .map((p) => p.trim())
    .find((p) => p.startsWith('t='));

  if (part === undefined) {
    return undefined;
  }

  const value = part.slice(2);

  // Digits only, matching `verifySignatureHeader`. See the note on `parseTimestamp` there: a
  // lenient parse means several header strings verify against one signature, and a verifier
  // written from the specification would not agree with us about which.
  if (!/^\d+$/.test(value)) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);

  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
