# Changelog

## 0.1.0-alpha.5

Adds `obligations` to `emit`, for the case configuration cannot express.

An obligation is what your business owes because something happened — _this invoice must reach
the ledger_, _this customer must receive it_. Usually you declare which events create which
obligations once, in configuration, and nothing in your code changes. This is for the duty that
depends on what is **in the row** rather than on the event's type, which no rule about types can
decide:

```ts
await emit(tx, {
  type: 'invoice.issued',
  data: { invoiceId, amountCents },
  // Only some invoices owe an approval, and only this transaction knows which.
  obligations: amountCents > 100_000 ? ['escalate-large-invoice'] : undefined,
});
```

Naming one here is the stronger of the two statements, because it commits with the business fact
itself. Nothing was inferred afterwards from a type: this row says the business owed it, and it
committed or it did not.

Names come from the vocabulary your rail declares. An event naming one your rail does not know is
held rather than dropped, and reported with the name it gave.

Validated at the boundary the way `subjects` is — at most 100 per event, 200 characters each, no
blank member, exact duplicates dropped with first-occurrence order kept, and `InvalidObligationsError`
thrown for anything malformed. It is thrown inside your transaction, which rolls back the write
that named it; the alternative is a row that cannot be accepted, discovered on the far side of a
network with nothing left to connect it to the line that wrote it. Catch it with
`InvalidObligationsError.is(error)` rather than `instanceof`, for the reason `InvalidSubjectsError`
says.

It is exported from `commitrail/postgres` and not from the root, unlike subjects. Subjects travel
in the delivered envelope, so both halves of this package need them; obligations do not — they
tell CommitRail what is owed, and the envelope a destination verifies does not carry them.

**Outbox schema 6.** `obligations TEXT[]`, added by a new migration. Re-run
`OUTBOX_SCHEMA_SQL` — it is safely re-runnable at any version and only moves forward — or apply
the migration yourself. **Upgrading is not urgent**: your rail keeps working on schema 5 exactly
as it does today, and the only thing you do not get is the ability to name an obligation on an
event. Nothing else in this release changes.

Nothing on the wire changed. The envelope, its canonical form and every signature are byte for
byte what `0.1.0-alpha.4` produced.

## 0.1.0-alpha.4

Editorial. The doc comments carried into the published type declarations were rewritten to
describe only this package's own surface; the runtime is byte-for-byte what `0.1.0-alpha.3`
shipped.

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
is that the signature covers _the delivery you are about to answer about_ — verifying against the
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
