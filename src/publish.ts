import { randomUUID } from 'node:crypto';
import { normalizeSubjects, type EventSubject } from './subjects.js';

/**
 * Publishing events to CommitRail over HTTP.
 *
 * The other side of `commitrail/postgres`. That one writes a row inside your own transaction and
 * never speaks to us; this one sends the event to CommitRail directly, which is simpler to adopt
 * and buys you less:
 *
 * - **We cannot tell you nothing is missing.** Capture re-reads your outbox and audits itself
 *   against it. A publish whose HTTP call was lost leaves no trace anywhere, so there is nothing
 *   to audit against.
 * - **Creating the event depends on us being reachable.** A transactional write touches only your
 *   own database. This puts CommitRail's availability into your request path.
 *
 * If your events already come from a PostgreSQL transaction, use `commitrail/postgres`. Use this
 * when they do not.
 */

/** Registered globally by description, so every copy of this package agrees on it. */
const PUBLISH_FAILED_BRAND = Symbol.for('commitrail.PublishFailedError');
const CREDENTIAL_REJECTED_BRAND = Symbol.for('commitrail.CredentialRejectedError');

const DEFAULT_CONTROL_PLANE_URL = 'https://api.commitrail.com';
const DEFAULT_REGIONAL_URL_TEMPLATE = 'https://api-{region}.commitrail.com';

const REGION_PLACEHOLDER = '{region}';

/**
 * A region id, and nothing that could choose a host.
 *
 * The region comes back in a response, and it is the one part of the address below that did not
 * come from your own configuration. An id shaped like `evil.com/` or `../` would otherwise pick
 * where your events are sent — so it is checked before it is interpolated, and that is a security
 * check rather than tidiness.
 */
const REGION_ID = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;

export interface PublisherOptions {
  /**
   * The ingestion credential for one source, as issued by CommitRail. Starts `cr_ing_`.
   *
   * It is bound to a single source: this publisher sends everything to that one, and there is no
   * way to name another. Keep it wherever you keep your other secrets.
   */
  credential: string;

  /** Where CommitRail answers. Override for staging or a self-hosted install. */
  controlPlaneUrl?: string;

  /**
   * Where a named region answers, with `{region}` interpolated.
   *
   * **Taken from your configuration and never from a response.** CommitRail tells this publisher
   * which region to use; it does not tell it which host, because what decides where your events
   * are sent should be something you already trust. With no `{region}` in the template, every
   * region resolves to the template itself.
   */
  regionalUrlTemplate?: string;

  /** How many times to retry one publish. Each retry reuses the same event id. */
  maxAttempts?: number;

  /** Injected for tests. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

export interface PublishEvent<TData = unknown> {
  type: string;
  data: TData;
  version?: number;
  occurredAt?: Date;

  /**
   * Supply one to make publishing idempotent across process restarts.
   *
   * You do not need it for ordinary retries: this publisher generates an id once and reuses it for
   * every attempt of the same call, so a timeout it retries itself is never a duplicate. What an
   * id of your own adds is surviving your process dying between attempts — and if you need *that*
   * guarantee always, `commitrail/postgres` is the honest answer, because it makes the event and
   * your business write one commit.
   */
  eventId?: string;

  /**
   * The logical operation this event belongs to — an order number, a checkout id, whatever your
   * application already calls it. CommitRail groups events that share one and never invents one.
   */
  correlationId?: string;

  /** The event that caused this one, if your application knows. */
  causationId?: string;

  /**
   * Which events must not overtake one another — `order:1264`, `user:${id}`.
   *
   * Events sharing a key are delivered to a destination one at a time, in the order CommitRail
   * accepted them, and a delivery that fails holds the ones behind it. Events with no key, which
   * is most of them, keep being delivered concurrently.
   */
  orderingKey?: string;

  /** What this event is about, so it can be found by subject rather than only by time. */
  subjects?: EventSubject[];
}

export interface PublishResult {
  /** CommitRail's id for the event, whether this call created it or an earlier one did. */
  eventId: string;

  /**
   * True when CommitRail already had this event.
   *
   * Not an error, and worth surfacing rather than hiding: a retry after a timeout you never got an
   * answer to is exactly what the id exists for, and this is how you tell "my retry worked" from
   * "I have now sent this twice".
   */
  duplicate: boolean;

  /** How many deliveries this event obliged. Zero if no route matched it, which is valid. */
  deliveriesCreated: number;
}

/**
 * CommitRail refused the credential.
 *
 * Distinct from a failed publish because the fix is different and no retry will help: the
 * credential is wrong, revoked, or for a different install. Branded and with a `static is()`,
 * because this package ships ESM and CommonJS and an application using both gets two copies of
 * every class — `instanceof` is false across them.
 */
export class CredentialRejectedError extends Error {
  readonly [CREDENTIAL_REJECTED_BRAND] = true;

  constructor(message: string) {
    super(message);
    this.name = 'CredentialRejectedError';
  }

  static is(error: unknown): error is CredentialRejectedError {
    return typeof error === 'object' && error !== null && CREDENTIAL_REJECTED_BRAND in error;
  }
}

/**
 * The publish did not succeed, and whether CommitRail has the event is unknown.
 *
 * `attempts` says how many were made. **Retrying with the same event id is safe and is the right
 * response** — if an earlier attempt did land, the retry is recognised as the same event and
 * changes nothing.
 */
export class PublishFailedError extends Error {
  readonly [PUBLISH_FAILED_BRAND] = true;

  constructor(
    message: string,
    readonly eventId: string,
    readonly attempts: number,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PublishFailedError';
  }

  static is(error: unknown): error is PublishFailedError {
    return typeof error === 'object' && error !== null && PUBLISH_FAILED_BRAND in error;
  }
}

export interface Publisher {
  publish<TData>(event: PublishEvent<TData>): Promise<PublishResult>;
}

interface Authority {
  token: string;
  environmentId: string;
  sourceId: string;
  region: string;
  /** When it stops being accepted. */
  expiresAtMs: number;
  /** When this publisher starts trying to replace it — half the lifetime. */
  refreshAfterMs: number;
}

/**
 * A publisher for one source.
 *
 * Hold on to it. It caches the short-lived token CommitRail issues and refreshes it before it
 * expires, so creating one per publish would exchange the credential every time.
 */
export function createPublisher(options: PublisherOptions): Publisher {
  const doFetch = options.fetch ?? globalThis.fetch;
  const controlPlaneUrl = trimSlash(options.controlPlaneUrl ?? DEFAULT_CONTROL_PLANE_URL);
  const regionalTemplate = options.regionalUrlTemplate ?? DEFAULT_REGIONAL_URL_TEMPLATE;
  const maxAttempts = options.maxAttempts ?? 3;

  if (typeof doFetch !== 'function') {
    throw new TypeError('No fetch is available. Pass one, or run on Node 18 or later.');
  }

  if (!options.credential) {
    throw new TypeError('An ingestion credential is required.');
  }

  let authority: Authority | null = null;
  let inFlight: Promise<Authority> | null = null;

  /**
   * The current authority, refreshed early rather than late.
   *
   * A token that lapses mid-request fails the request that discovers it, so the replacement is
   * fetched at half-life. **A failed refresh is not fatal while the token still works** — the
   * exchange is a network call to CommitRail, and a moment when it does not answer should not
   * stop your application publishing on authority it already holds.
   */
  async function currentAuthority(): Promise<Authority> {
    const now = Date.now();

    if (authority !== null && now < authority.refreshAfterMs) {
      return authority;
    }

    if (authority !== null && now < authority.expiresAtMs) {
      // Due for refresh and still valid. Try, and carry on with what we have if it fails.
      try {
        return await exchangeOnce();
      } catch {
        return authority;
      }
    }

    return exchangeOnce();
  }

  /** One exchange at a time, however many publishes are waiting on it. */
  function exchangeOnce(): Promise<Authority> {
    inFlight ??= exchange()
      .then((next) => {
        authority = next;

        return next;
      })
      .finally(() => {
        inFlight = null;
      });

    return inFlight;
  }

  async function exchange(): Promise<Authority> {
    let response: Response;

    try {
      response = await doFetch(`${controlPlaneUrl}/api/v1/ingestion-tokens`, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.credential}` },
      });
    } catch (cause) {
      throw new PublishFailedError(
        `Could not reach CommitRail to exchange the ingestion credential: ${describe(cause)}`,
        '',
        1,
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new CredentialRejectedError(
        'CommitRail refused this ingestion credential. It may be revoked, expired, or for a ' +
          'different installation.',
      );
    }

    if (!response.ok) {
      throw new PublishFailedError(
        `CommitRail answered ${response.status} when exchanging the ingestion credential.`,
        '',
        1,
        response.status,
      );
    }

    const body = (await response.json()) as {
      accessToken: string;
      expiresIn: number;
      environmentId: string;
      sourceId: string;
      region: string;
    };

    const lifetimeMs = body.expiresIn * 1000;

    return {
      token: body.accessToken,
      environmentId: body.environmentId,
      sourceId: body.sourceId,
      region: body.region,
      expiresAtMs: Date.now() + lifetimeMs,
      refreshAfterMs: Date.now() + lifetimeMs / 2,
    };
  }

  function regionalBaseUrl(region: string): string {
    if (!regionalTemplate.includes(REGION_PLACEHOLDER)) {
      return trimSlash(regionalTemplate);
    }

    if (!REGION_ID.test(region)) {
      throw new PublishFailedError(
        `${JSON.stringify(region)} is not a CommitRail region id.`,
        '',
        1,
      );
    }

    return trimSlash(regionalTemplate.replaceAll(REGION_PLACEHOLDER, region));
  }

  return {
    async publish<TData>(event: PublishEvent<TData>): Promise<PublishResult> {
      if (!event.type) {
        throw new TypeError('An event needs a type.');
      }

      /**
       * Generated once, here, and reused by every attempt below.
       *
       * This is the whole of what makes a retry safe. A client that minted a fresh id per attempt
       * would turn an ambiguous timeout — where the request may well have landed — into a
       * guaranteed duplicate.
       */
      const eventId = event.eventId ?? randomUUID();

      const body = JSON.stringify({
        eventId,
        eventType: event.type,
        eventVersion: event.version ?? 1,
        payload: event.data,
        occurredAt: (event.occurredAt ?? new Date()).toISOString(),
        ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
        ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
        ...(event.orderingKey === undefined ? {} : { orderingKey: event.orderingKey }),
        ...(event.subjects === undefined
          ? {}
          : { subjects: normalizeSubjects(event.subjects) ?? [] }),
      });

      let lastStatus: number | undefined;
      let lastDetail = '';

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const held = await currentAuthority();
        const url = `${regionalBaseUrl(held.region)}/api/v1/environments/${held.environmentId}/events`;

        let response: Response;

        try {
          response = await doFetch(url, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${held.token}`,
              'content-type': 'application/json',
            },
            body,
          });
        } catch (cause) {
          // Never reached CommitRail, or never heard back. Unknown rather than failed, which is
          // exactly the case the reused id makes safe.
          lastDetail = describe(cause);
          await backOff(attempt);
          continue;
        }

        if (response.ok) {
          const result = (await response.json()) as PublishResult;

          return {
            eventId: result.eventId,
            duplicate: result.duplicate,
            deliveriesCreated: result.deliveriesCreated,
          };
        }

        lastStatus = response.status;
        lastDetail = await readError(response);

        if (response.status === 401 || response.status === 403) {
          /**
           * The token was refused. Once because it may simply have expired between the check and
           * the send, and then no more — a second refusal is the credential, not the clock.
           */
          if (attempt === 1) {
            authority = null;
            continue;
          }

          throw new CredentialRejectedError(
            `CommitRail refused this publisher's authority: ${lastDetail}`,
          );
        }

        // A refusal the caller has to fix — a malformed event, an unknown source, a paused one.
        // Retrying changes nothing and would hide the answer behind a timeout.
        if (response.status < 500 && response.status !== 429) {
          throw new PublishFailedError(
            `CommitRail refused this event: ${lastDetail}`,
            eventId,
            attempt,
            response.status,
          );
        }

        await backOff(attempt);
      }

      throw new PublishFailedError(
        `CommitRail did not accept this event after ${maxAttempts} attempts: ${lastDetail}. ` +
          'Whether it was stored is unknown — retry with the same eventId, which is safe.',
        eventId,
        maxAttempts,
        lastStatus,
      );
    },
  };
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

async function backOff(attempt: number): Promise<void> {
  // Exponential with jitter, so a fleet that fails together does not retry together.
  const base = Math.min(2_000, 100 * 2 ** (attempt - 1));

  await new Promise((resolve) => setTimeout(resolve, base + Math.random() * base));
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string; error?: string };

    return body.message ?? body.error ?? String(response.status);
  } catch {
    return String(response.status);
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
