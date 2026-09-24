/**
 * Obligations: what your business owes because an event happened.
 *
 * An obligation is not the event and not where anything is sent — it is the duty the event
 * creates. `invoice.issued` is what happened; *the invoice must reach the accounting ledger* and
 * *the customer must receive it* are the two obligations, and they can be fulfilled by different
 * systems, at different times, with different consequences when they are not.
 *
 * Most rails declare which events create which obligations once, in configuration, and never name
 * them here. Declaring them on the event is for the case configuration cannot express: an
 * obligation that depends on what is *in* the row rather than on the event's type — a shipment
 * that needs customs clearance only for some destinations, an upgrade that owes a provisioning
 * step only on some plans.
 *
 * Naming one here is the stronger statement of the two, because it is written inside the same
 * transaction as the business fact. Nothing was inferred afterwards from a type: this row says the
 * business owed this, and it committed or it did not.
 *
 * Names are the vocabulary your rail already declares. An event naming an obligation the rail does
 * not know is held rather than dropped, and reported with the name it gave.
 */

/**
 * Sized so normal business modelling never meets them; they exist to stop pathological usage,
 * not to ration obligations.
 */
export const OBLIGATION_LIMITS = {
  maxPerEvent: 100,
  maxNameLength: 200,
} as const;

/** Registered globally, so every copy of this package recognises a brand set by another. */
const BRAND = Symbol.for('commitrail.InvalidObligationsError');

/**
 * Thrown when an obligations value is malformed.
 *
 * Catch it with `InvalidObligationsError.is(error)` rather than `instanceof`. This package ships
 * both ESM and CommonJS, so an application that reaches it both ways holds two copies and two
 * distinct classes — and `instanceof` is **false** across them, for an error that is exactly what
 * it looks like. The brand is registered globally, so `is()` recognises either.
 */
export class InvalidObligationsError extends Error {
  static readonly brand = BRAND;

  readonly [BRAND] = true;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidObligationsError';
  }

  static is(error: unknown): error is InvalidObligationsError {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as Record<symbol, unknown>)[BRAND] === true
    );
  }
}

/**
 * Validate and canonicalise an obligations value.
 *
 * Returns `null` for "none" (undefined, null, or an empty array) so callers store nothing rather
 * than an empty list — an event that owes nothing and an event whose obligations were dropped must
 * not look the same.
 *
 * Duplicates are dropped with first-occurrence order preserved: naming the same duty twice is one
 * duty, and producers often assemble the list from more than one code path. Anything malformed
 * throws, at the boundary, inside your transaction — which rolls back the write that named it.
 * The alternative is a row that cannot be accepted later, held on the far side of a network with
 * no way back to the line that wrote it.
 *
 * Takes `unknown` because the value is re-validated wherever it is read back, and no type
 * annotation can vouch for what was actually written.
 */
export function normalizeObligations(obligations: unknown): string[] | null {
  if (obligations === undefined || obligations === null) {
    return null;
  }

  if (!Array.isArray(obligations)) {
    throw new InvalidObligationsError('obligations must be an array of names');
  }

  if (obligations.length === 0) {
    return null;
  }

  if (obligations.length > OBLIGATION_LIMITS.maxPerEvent) {
    throw new InvalidObligationsError(
      `an event may name at most ${OBLIGATION_LIMITS.maxPerEvent} obligations`,
    );
  }

  const seen = new Set<string>();
  const kept: string[] = [];

  for (const name of obligations) {
    if (typeof name !== 'string') {
      throw new InvalidObligationsError('every obligation must be a name');
    }

    /*
      Trimmed, then required to be non-empty.

      A name that is only whitespace is the shape a template produces when the value it was
      interpolating was missing — and it would name an obligation nothing declares, which becomes
      a held event long after the code that wrote it has returned.
    */
    const trimmed = name.trim();

    if (trimmed.length === 0) {
      throw new InvalidObligationsError('an obligation name cannot be empty');
    }

    if (trimmed.length > OBLIGATION_LIMITS.maxNameLength) {
      throw new InvalidObligationsError(
        `an obligation name may be at most ${OBLIGATION_LIMITS.maxNameLength} characters`,
      );
    }

    if (seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    kept.push(trimmed);
  }

  return kept;
}
