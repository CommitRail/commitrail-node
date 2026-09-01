/**
 * The protocol, as a customer needs it.
 *
 * Everything here is something you use to integrate with CommitRail. Nothing is here because
 * CommitRail's own server happens to need it: the server implements this same protocol from its
 * own private code and imports nothing from this package, so the public surface is a decision
 * about your integration rather than a projection of our internals.
 *
 * What that costs is the ability to say "we sign with exactly the function you verify with".
 * What it buys is that every export here is one we intend to support, and the guarantee is kept
 * where it can actually be kept for every language — by conformance vectors both implementations
 * are tested against, and by end-to-end tests that verify what CommitRail sends using this
 * verifier. A Go verifier could never have shared our functions either.
 *
 * Each side has a subpath of its own: `commitrail/postgres` produces, `commitrail/webhooks`
 * receives, and neither is re-exported here.
 */
export { SPEC_VERSION, HEADERS, type CommitRailEvent } from './envelope.js';
export { InvalidSubjectsError, SUBJECT_LIMITS, type EventSubject } from './subjects.js';
export { verifySignatureHeader, verifyReceiptSignatureHeader } from './signing.js';
