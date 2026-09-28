import { describe, expect, it } from 'vitest';
import { createPublisher, CredentialRejectedError, PublishFailedError } from '../src/publish.js';

/**
 * The publisher's job is not sending one HTTP request. It is the three things a customer would
 * otherwise have to get right themselves: exchanging a credential and keeping the result fresh,
 * reusing an event id across retries, and never letting a response decide where events are sent.
 *
 * A stub `fetch` rather than a server, because every assertion here is about which request was
 * made and with what — not about HTTP.
 */

const CREDENTIAL = 'cr_ing_' + '0'.repeat(64);

interface Call {
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

function stub(
  handlers: {
    exchange?: (call: Call, n: number) => { status: number; body?: unknown };
    publish?: (call: Call, n: number) => { status: number; body?: unknown } | 'network-error';
  } = {},
) {
  const calls: { exchange: Call[]; publish: Call[] } = { exchange: [], publish: [] };

  const fetchStub = (async (input: string, init: RequestInit = {}) => {
    const call: Call = {
      url: String(input),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };

    if (call.url.endsWith('/ingestion-tokens')) {
      calls.exchange.push(call);

      const answer = handlers.exchange?.(call, calls.exchange.length) ?? {
        status: 200,
        body: {
          accessToken: `token-${calls.exchange.length}`,
          expiresIn: 900,
          environmentId: 'env-1',
          sourceId: 'src-1',
          region: 'fra',
        },
      };

      return response(answer);
    }

    calls.publish.push(call);

    const answer = handlers.publish?.(call, calls.publish.length) ?? {
      status: 202,
      body: { eventId: 'evt-1', duplicate: false, deliveriesCreated: 1 },
    };

    if (answer === 'network-error') {
      throw new Error('socket hang up');
    }

    return response(answer);
  }) as unknown as typeof globalThis.fetch;

  return { fetchStub, calls };
}

function response({ status, body }: { status: number; body?: unknown }): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const publisherWith = (fetchStub: typeof globalThis.fetch, extra = {}) =>
  createPublisher({
    credential: CREDENTIAL,
    controlPlaneUrl: 'https://cp.test',
    regionalUrlTemplate: 'https://api-{region}.test',
    ...extra,
    fetch: fetchStub,
  });

describe('publishing', () => {
  it('exchanges the credential, then sends the event to the region it was told', async () => {
    const { fetchStub, calls } = stub();

    const result = await publisherWith(fetchStub).publish({
      type: 'order.paid',
      data: { orderId: 'ord_1' },
    });

    expect(calls.exchange[0]!.headers.authorization).toBe(`Bearer ${CREDENTIAL}`);
    // The long-lived credential is presented once, when it is exchanged. Every published event
    // afterwards carries only the short-lived token that exchange returned.
    expect(calls.publish[0]!.headers.authorization).toBe('Bearer token-1');
    expect(calls.publish[0]!.url).toBe('https://api-fra.test/api/v1/environments/env-1/events');
    expect(result).toEqual({ eventId: 'evt-1', duplicate: false, deliveriesCreated: 1 });
  });

  it('never names a source, because the credential already does', async () => {
    const { fetchStub, calls } = stub();

    await publisherWith(fetchStub).publish({ type: 'order.paid', data: {} });

    expect(calls.publish[0]!.body).not.toHaveProperty('sourceId');
  });

  it('exchanges once and reuses the token', async () => {
    const { fetchStub, calls } = stub();
    const publisher = publisherWith(fetchStub);

    await publisher.publish({ type: 'a', data: {} });
    await publisher.publish({ type: 'b', data: {} });
    await publisher.publish({ type: 'c', data: {} });

    // Holding the publisher is the point. Exchanging per publish would turn every event into two
    // round trips, one of them to a different plane.
    expect(calls.exchange).toHaveLength(1);
    expect(calls.publish).toHaveLength(3);
  });

  it('exchanges once when several publishes race an empty cache', async () => {
    const { fetchStub, calls } = stub();
    const publisher = publisherWith(fetchStub);

    await Promise.all([
      publisher.publish({ type: 'a', data: {} }),
      publisher.publish({ type: 'b', data: {} }),
      publisher.publish({ type: 'c', data: {} }),
    ]);

    expect(calls.exchange).toHaveLength(1);
  });
});

describe('the event id', () => {
  it('is generated once and reused by every attempt', async () => {
    const { fetchStub, calls } = stub({
      publish: (_call, n) =>
        n < 3
          ? 'network-error'
          : { status: 202, body: { eventId: 'evt-1', duplicate: true, deliveriesCreated: 0 } },
    });

    await publisherWith(fetchStub).publish({ type: 'order.paid', data: {} });

    expect(calls.publish).toHaveLength(3);
    const ids = new Set(calls.publish.map((call) => (call.body as { eventId: string }).eventId));
    // The whole of what makes a retry safe. A fresh id per attempt would turn an ambiguous
    // timeout — where the request may well have landed — into a guaranteed duplicate.
    expect(ids.size).toBe(1);
  });

  it('is the caller’s when they supply one', async () => {
    const { fetchStub, calls } = stub();

    await publisherWith(fetchStub).publish({
      type: 'order.paid',
      data: {},
      eventId: '11111111-1111-4111-8111-111111111111',
    });

    expect((calls.publish[0]!.body as { eventId: string }).eventId).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
  });

  it('carries the duplicate answer back rather than hiding it', async () => {
    const { fetchStub } = stub({
      publish: () => ({
        status: 202,
        body: { eventId: 'evt-1', duplicate: true, deliveriesCreated: 0 },
      }),
    });

    const result = await publisherWith(fetchStub).publish({ type: 'order.paid', data: {} });

    // Not an error. It is how a caller tells "my retry worked" from "I have now sent this twice".
    expect(result.duplicate).toBe(true);
  });
});

describe('where events are sent', () => {
  it('refuses a region id that could choose a host', async () => {
    const { fetchStub, calls } = stub({
      exchange: () => ({
        status: 200,
        body: {
          accessToken: 't',
          expiresIn: 900,
          environmentId: 'env-1',
          sourceId: 'src-1',
          region: 'evil.example/',
        },
      }),
    });

    // The region is the one part of the address that came from a response. Interpolating it
    // unchecked would let the answer decide where a customer's events go.
    await expect(
      publisherWith(fetchStub).publish({ type: 'order.paid', data: {} }),
    ).rejects.toThrow(/not a CommitRail region id/);
    expect(calls.publish).toHaveLength(0);
  });

  it('sends everything to one host when the template names no region', async () => {
    const { fetchStub, calls } = stub();

    await publisherWith(fetchStub, { regionalUrlTemplate: 'http://localhost:4000' }).publish({
      type: 'order.paid',
      data: {},
    });

    expect(calls.publish[0]!.url).toBe('http://localhost:4000/api/v1/environments/env-1/events');
  });
});

describe('what it retries and what it does not', () => {
  it('retries a server error and succeeds', async () => {
    const { fetchStub, calls } = stub({
      publish: (_call, n) =>
        n === 1
          ? { status: 503 }
          : { status: 202, body: { eventId: 'e', duplicate: false, deliveriesCreated: 0 } },
    });

    await publisherWith(fetchStub).publish({ type: 'order.paid', data: {} });

    expect(calls.publish).toHaveLength(2);
  });

  it('does not retry an event CommitRail refused', async () => {
    const { fetchStub, calls } = stub({
      publish: () => ({ status: 400, body: { message: 'ordering key names nothing' } }),
    });

    // A malformed event, an unknown source, a paused one. Retrying changes nothing and would hide
    // the answer behind a timeout.
    await expect(
      publisherWith(fetchStub).publish({ type: 'order.paid', data: {}, orderingKey: '   ' }),
    ).rejects.toThrow(PublishFailedError);
    expect(calls.publish).toHaveLength(1);
  });

  it('re-exchanges once on a refused token, then gives up on the credential', async () => {
    const { fetchStub, calls } = stub({ publish: () => ({ status: 401 }) });

    // The first 401 may be a token that expired between the check and the send. A second is the
    // credential, not the clock.
    await expect(
      publisherWith(fetchStub).publish({ type: 'order.paid', data: {} }),
    ).rejects.toThrow(CredentialRejectedError);
    expect(calls.exchange).toHaveLength(2);
  });

  it('says the outcome is unknown when it runs out of attempts', async () => {
    const { fetchStub } = stub({ publish: () => 'network-error' });

    const error = await publisherWith(fetchStub, { maxAttempts: 2 })
      .publish({ type: 'order.paid', data: {} })
      .catch((caught: unknown) => caught);

    expect(PublishFailedError.is(error)).toBe(true);
    expect((error as PublishFailedError).attempts).toBe(2);
    // The honest answer, and the actionable one: the same id is safe to send again.
    expect((error as PublishFailedError).message).toMatch(/unknown/);
    expect((error as PublishFailedError).eventId).toEqual(expect.any(String));
  });
});

describe('the credential', () => {
  it('is rejected distinctly from a failed publish, because no retry will help', async () => {
    const { fetchStub, calls } = stub({ exchange: () => ({ status: 401 }) });

    await expect(
      publisherWith(fetchStub).publish({ type: 'order.paid', data: {} }),
    ).rejects.toThrow(CredentialRejectedError);
    expect(calls.publish).toHaveLength(0);
  });

  it('is required, and said so before any request is made', () => {
    expect(() => createPublisher({ credential: '' })).toThrow(TypeError);
  });
});

describe('errors survive being loaded twice', () => {
  it('is branded rather than relying on instanceof', () => {
    const error = new PublishFailedError('x', 'e', 1);

    // This package ships ESM and CommonJS, so an application doing both gets two copies of every
    // class and `instanceof` is false across them. Anything a customer branches on carries a
    // brand and a static `is`.
    expect(PublishFailedError.is(error)).toBe(true);
    expect(PublishFailedError.is(new Error('x'))).toBe(false);
    expect(CredentialRejectedError.is(new CredentialRejectedError('x'))).toBe(true);
    expect(CredentialRejectedError.is(error)).toBe(false);
  });
});
