/**
 * Subjects: the business identities an event concerns.
 *
 * A subject is not what happened (the event type), not the operation it belongs to (the
 * correlation id), and not what caused it (the causation id) — it is *who or what it was
 * about*: an order, a payment, a customer, a document. Declaring them makes those
 * identifiers first-class lookup keys in CommitRail, so an investigation can start from
 * "what happened to order_1264" rather than from an event id nobody has.
 *
 * Subjects are an unordered set of `(type, id)` pairs. Plural on purpose: a
 * `payment.captured` legitimately concerns the payment, the order and the customer, and
 * CommitRail has no business deciding which of them is *the* subject.
 */
export interface EventSubject {
  /** The kind of thing, in the application's own vocabulary: `order`, `payment`, `customer`. */
  type: string;
  /** The application's identifier for it: `order_1264`, `pay_991`. */
  id: string;
}

/**
 * Sized so normal business modelling never meets them; they exist to stop pathological
 * usage, not to ration subjects. The evidence behind each number — measured throughput,
 * storage and lookup curves, and what still needs re-measuring at production scale —
 * is docs/benchmarks/event-subjects-limits.md; change them there first.
 */
export const SUBJECT_LIMITS = {
  maxPerEvent: 100,
  maxTypeLength: 200,
  maxIdLength: 500,
} as const;

/** Registered globally by description, so every copy of this package agrees on it. */
const BRAND = Symbol.for('commitrail.InvalidSubjectsError');

/** Branded like `InvalidDeliveryError`, and for the same dual-package reason. */
export class InvalidSubjectsError extends Error {
  static readonly brand = BRAND;

  readonly [BRAND] = true;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidSubjectsError';
  }

  static is(error: unknown): error is InvalidSubjectsError {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as Record<symbol, unknown>)[BRAND] === true
    );
  }
}

/**
 * Validate and canonicalise a subjects value.
 *
 * Returns `null` for "no subjects" (undefined, null, or an empty array) so callers store
 * nothing rather than an empty list. Exact duplicate `(type, id)` pairs are dropped —
 * duplicates carry no meaning, and producers often assemble subjects from more than one
 * code path — with first-occurrence order preserved. Anything malformed throws: a subject
 * that cannot be represented is an error at the boundary, never a silent truncation.
 *
 * Takes `unknown` because the acceptance side re-validates whatever a producer actually
 * wrote to the outbox, which no type annotation can vouch for.
 */
export function normalizeSubjects(subjects: unknown): EventSubject[] | null {
  if (subjects === undefined || subjects === null) {
    return null;
  }

  if (!Array.isArray(subjects)) {
    throw new InvalidSubjectsError('subjects must be an array of { type, id } pairs');
  }

  const seen = new Set<string>();
  const normalized: EventSubject[] = [];

  for (const subject of subjects) {
    if (typeof subject !== 'object' || subject === null || Array.isArray(subject)) {
      throw new InvalidSubjectsError('each subject must be an object with string type and id');
    }

    const { type, id } = subject as { type?: unknown; id?: unknown };

    if (typeof type !== 'string' || type.length === 0) {
      throw new InvalidSubjectsError('a subject type must be a non-empty string');
    }
    if (typeof id !== 'string' || id.length === 0) {
      throw new InvalidSubjectsError('a subject id must be a non-empty string');
    }
    if (type.length > SUBJECT_LIMITS.maxTypeLength) {
      throw new InvalidSubjectsError(
        `a subject type may be at most ${SUBJECT_LIMITS.maxTypeLength} characters`,
      );
    }
    if (id.length > SUBJECT_LIMITS.maxIdLength) {
      throw new InvalidSubjectsError(
        `a subject id may be at most ${SUBJECT_LIMITS.maxIdLength} characters`,
      );
    }

    // A joining delimiter cannot be trusted when it may appear in the values themselves;
    // length-prefixing makes the key unambiguous whatever the strings contain.
    const key = `${type.length}:${type}${id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    normalized.push({ type, id });
  }

  if (normalized.length === 0) {
    return null;
  }

  if (normalized.length > SUBJECT_LIMITS.maxPerEvent) {
    throw new InvalidSubjectsError(
      `an event may declare at most ${SUBJECT_LIMITS.maxPerEvent} subjects`,
    );
  }

  return normalized;
}
