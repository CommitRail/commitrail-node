# Changelog

## 0.1.0-alpha.3

Adds `verifyReceipt` to `commitrail/webhooks`, for the receipt endpoint CommitRail asks before it
gives up on a delivery.

When an attempt times out, CommitRail cannot tell whether you processed it. If your destination
declares a receipt URL, it is asked once — `GET {receiptUrl}/{deliveryId}` — before recording the
delivery as undelivered. Answer 200 if you already have it, 404 if you do not.

```ts
app.get('/commitrail/receipts/:deliveryId', async (request, reply) => {
  verifyReceipt({
    headers: request.headers,
    deliveryId: request.params.deliveryId,
    secret: process.env.COMMITRAIL_SIGNING_SECRET!,
  });

  return (await alreadyProcessed(request.params.deliveryId))
    ? reply.code(200).send()
    : reply.code(404).send();
});
```

The probe is signed with the same secret and the same `t=…,v1=…` header as a delivery, over a
canonical string of its own — `receipt.{timestamp}.{deliveryId}`. The two forms are separated
structurally: a delivery's begins with a timestamp, and cannot produce the `receipt.` prefix for
any body, so neither signature can be presented as the other.

`deliveryId` is a parameter rather than read from the headers on purpose. What has to be verified
is that the signature covers *the delivery you are about to answer about* — verifying against the
header would confirm only that the headers agree with each other.

Also exports `verifyReceiptSignatureHeader` from the root, alongside `verifySignatureHeader`, and
adds receipt cases to `vectors/protocol.json`.

`emit` now refuses an ordering key that names nothing — empty or blank — and one longer than 500
characters, and exports `MAX_ORDERING_KEY_LENGTH`. The rail already refused both and held the
event, which is correct and is also the slowest way for a producer to find out; throwing inside
your transaction rolls it back where the mistake was made.

An empty key is not "no key". Omit `orderingKey` entirely for unordered events — an empty one is a
lane named the empty string, and every event that made the same mistake would be serialised
through it.

## 0.1.0-alpha.2

Adds `orderingKey` to `emit`, and outbox schema version 5 which is the column it is written to.

Events sharing a key are delivered to a destination one at a time, in the order CommitRail
accepted them; a delivery that fails holds the ones behind it rather than letting them pass.
Events without a key — which is most of them — are unaffected and keep being delivered
concurrently. Ordering is asked for and never inferred.

**Upgrading needs the migration.** `emit` writes the new column unconditionally, so a database
still on version 4 fails on every emit until `OUTBOX_SCHEMA_SQL` or migration 5 is applied.
Apply the schema first, then upgrade the package.

## 0.1.0-alpha.1

Prerelease. Corrects the notice, which said this package was not on the `latest` tag.

## 0.1.0-alpha.0

Prerelease.
