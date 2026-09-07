/**
 * The protocol, as a customer needs it.
 *
 * Everything here is something you use to integrate with CommitRail, and every export is one
 * we intend to support.
 *
 * Each side has a subpath of its own: `commitrail/postgres` produces, `commitrail/webhooks`
 * receives, and neither is re-exported here.
 */
export { SPEC_VERSION, HEADERS, type CommitRailEvent } from './envelope.js';
export { InvalidSubjectsError, SUBJECT_LIMITS, type EventSubject } from './subjects.js';
export { verifySignatureHeader, verifyReceiptSignatureHeader } from './signing.js';
