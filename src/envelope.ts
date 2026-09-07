/** The wire contract: the envelope CommitRail sends, and the bytes a signature covers. */
import type { EventSubject } from './subjects.js';

export const SPEC_VERSION = '1';

export interface CommitRailEvent<TData = unknown> {
  specVersion: string;

  /**
   * The producer's own event identity, carried through untouched.
   *
   * Unique within its source, and not beyond it: a destination fed by two sources can see
   * the same id from unrelated events. Deduplicate on `delivery.id`.
   */
  id: string;

  type: string;
  version: number;

  /** When the event happened, as the producer recorded it. */
  occurredAt: string;

  /**
   * The logical operation this event belongs to, and the event that caused it.
   *
   * Absent when the producer named neither — an absent member says "this event names no
   * operation" more clearly than a null does. Put the same `correlationId` on whatever you
   * emit in response and CommitRail joins the chain without being told anything else.
   */
  correlationId?: string;
  causationId?: string;

  /**
   * The business identities the producer declared this event concerns.
   *
   * Absent when none were declared, for the same reason as the members above — and never
   * inferred: these are exactly what the producer wrote, so a consumer can route or index
   * on them with the same trust the producer's own code would get.
   */
  subjects?: EventSubject[];

  delivery: {
    /**
     * The obligation this request is fulfilling, stable across every retry.
     *
     * **This is the idempotency key.** One event legitimately becomes two obligations when
     * two routes point at the same destination, so deduplicating on `id` would silently
     * drop the second.
     */
    id: string;
    attempt: number;
  };

  data: TData;
}

/** Header names CommitRail sends. Lowercase, as Node normalises them. */
export const HEADERS = {
  specVersion: 'commitrail-spec-version',
  deliveryId: 'commitrail-delivery-id',
  idempotencyKey: 'commitrail-idempotency-key',
  attemptId: 'commitrail-attempt-id',
  attemptNumber: 'commitrail-attempt-number',
  eventId: 'commitrail-event-id',
  eventType: 'commitrail-event-type',
  timestamp: 'commitrail-timestamp',
  signature: 'commitrail-signature',
} as const;

/**
 * Serialise the wire envelope.
 *
 * `data` is spliced in as JSON text rather than parsed and re-serialised: `JSON.parse` is
 * float64 and silently rewrites any integer past 2^53, so an id of 12345678901234567890 would
 * become 12345678901234567000. Every other member goes through `JSON.stringify`, which is what
 * escapes it.
 *
 * The field order is fixed and written out rather than left to an object literal, because these
 * bytes are what gets signed.
 */
export function serialiseEnvelope(input: {
  id: string;
  type: string;
  version: number;
  occurredAt: string;
  correlationId?: string | null;
  causationId?: string | null;
  subjects?: EventSubject[] | null;
  deliveryId: string;
  attempt: number;
  /** JSON text. Never a parsed value — see the note above. */
  data: string;
}): string {
  // Omitted rather than sent as null, so the envelope keeps the shape it has always had for
  // events that name no operation.
  const optional = (name: string, value: string | null | undefined) =>
    value === null || value === undefined ? '' : `"${name}":${JSON.stringify(value)},`;

  return (
    '{' +
    `"specVersion":${JSON.stringify(SPEC_VERSION)},` +
    `"id":${JSON.stringify(input.id)},` +
    `"type":${JSON.stringify(input.type)},` +
    `"version":${JSON.stringify(input.version)},` +
    `"occurredAt":${JSON.stringify(input.occurredAt)},` +
    optional('correlationId', input.correlationId) +
    optional('causationId', input.causationId) +
    // Appended to the fixed order rather than inserted into it, so an envelope without subjects
    // keeps the bytes it had. `JSON.stringify` is safe here — subjects are strings by contract,
    // so there is no float64 hazard, unlike `data`.
    (input.subjects === null || input.subjects === undefined || input.subjects.length === 0
      ? ''
      : `"subjects":${JSON.stringify(input.subjects)},`) +
    `"delivery":{"id":${JSON.stringify(input.deliveryId)},"attempt":${JSON.stringify(input.attempt)}},` +
    `"data":${input.data}` +
    '}'
  );
}
