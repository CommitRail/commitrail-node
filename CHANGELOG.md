# Changelog

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
