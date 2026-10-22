/** Provider adapters for composition roots. Mutations must be dispatched through ActionExecutor. */

export { CalDavCalendarProvider, normalizeIcalendar } from "./caldav.js";
export {
  NotImplementedError,
  ProviderError,
  RateLimitedError,
  SubmissionAcceptedError,
} from "./errors.js";
export { GmailMailProvider, gmailCapabilities, normalizeGmail } from "./gmail.js";
export type { GmailCostEntry } from "./gmail-reader.js";
export { GmailMailReader } from "./gmail-reader.js";
export { GMAIL_METADATA_HEADERS } from "./gmail-reader-support.js";
export { GoogleCalendarProvider, normalizeGoogleEvent } from "./google-calendar.js";
export { GraphMailProvider, graphCapabilities, normalizeGraph } from "./graph.js";
export { GraphCalendarProvider, normalizeGraphEvent } from "./graph-calendar.js";
export type { GraphCostEntry, GraphReaderOptions, GraphReadResult } from "./graph-reader.js";
export { GraphMailReader } from "./graph-reader.js";
export type { ProviderOptions, RequestPolicy } from "./http.js";
export type { ImapProviderOptions, SmtpClient } from "./imap.js";
export { ImapMailProvider, imapCapabilities, imapFlagsToKeywords } from "./imap.js";
export type { ImapReaderHost } from "./imap-reader.js";
export { ImapMailReader } from "./imap-reader.js";
export { IMAP_DELETE_SWEEP_MS } from "./imap-reader-changes.js";
export { IMAP_SCAN_CAP } from "./imap-reader-scan.js";
export type { ImapExtension } from "./imap-reader-support.js";
export { IMAP_EXTENSIONS } from "./imap-reader-support.js";
export { JmapMailProvider, jmapCapabilities, normalizeJmap } from "./jmap.js";
export type { JmapInvocation, JmapReaderHost } from "./jmap-reader.js";
export { JmapMailReader } from "./jmap-reader.js";
export {
  createMockEmails,
  MockCalendarProvider,
  MockMailProvider,
  mockCapabilities,
} from "./mock.js";
export type { MockMailOptions } from "./mock-mail.js";
export type { MockCostEntry, MockReaderSource } from "./mock-reader.js";
export { MOCK_CHANGE_RETENTION_MS, MockMailReader } from "./mock-reader.js";
export {
  generatePreview,
  htmlToText,
  normalizeAddresses,
  normalizeHeaders,
  normalizeMime,
  parseListUnsubscribe,
  toIso,
} from "./normalize/index.js";
export type { QueryAst, QueryField, QueryNode } from "./query.js";
export {
  PORTABLE_CONTAINERS,
  parsePortableQuery,
  queryScopesSpamTrash,
  relativeCutoff,
} from "./query.js";
export type { MatchableEmail, MatchContext, MatchLabel } from "./query-match.js";
export { matchesQuery } from "./query-match.js";
export type { GraphQueryPlan, ImapPlanOptions, ImapQueryPlan } from "./query-render.js";
export {
  listFilterToAst,
  renderGmailQuery,
  renderGraphQuery,
  renderImapQuery,
} from "./query-render.js";
export type { AcquireOptions, QuotaGovernorOptions, QuotaLease } from "./quota.js";
export { QuotaGovernor } from "./quota.js";
export type { QuotaClock } from "./quota-clock.js";
export { ManualClock, systemClock } from "./quota-clock.js";
export type { QuotaConfig, ThrottleSignal } from "./quota-presets.js";
export {
  BACKGROUND_SHARE,
  GMAIL_UNIT_COSTS,
  INTERACTIVE_MAX_WAIT_MS,
  QUOTA_PRESETS,
} from "./quota-presets.js";
export {
  AttachmentTooLargeError,
  cloudLinkHost,
  NotDownloadableError,
} from "./reader-attachments.js";
export { clipJson, gmailRawGetUnits } from "./reader-raw-get.js";
export { setReaderTokenSecret } from "./reader-tokens.js";
export {
  createProviderRegistry,
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_MAIL_SCOPES,
  MICROSOFT_CALENDAR_SCOPES,
  MICROSOFT_MAIL_SCOPES,
} from "./registry.js";
export type { HeaderInput, PassportVerifier } from "./verification.js";
export { parseAuthenticationResults, StubPassportVerifier } from "./verification.js";
