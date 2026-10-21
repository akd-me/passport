/** Provider adapters for composition roots. Mutations must be dispatched through ActionExecutor. */

export { CalDavCalendarProvider, normalizeIcalendar } from "./caldav.js";
export { NotImplementedError, ProviderError, SubmissionAcceptedError } from "./errors.js";
export { GmailMailProvider, gmailCapabilities, normalizeGmail } from "./gmail.js";
export { GoogleCalendarProvider, normalizeGoogleEvent } from "./google-calendar.js";
export { GraphMailProvider, graphCapabilities, normalizeGraph } from "./graph.js";
export { GraphCalendarProvider, normalizeGraphEvent } from "./graph-calendar.js";
export type { ProviderOptions } from "./http.js";
export type { ImapProviderOptions, SmtpClient } from "./imap.js";
export { ImapMailProvider, imapCapabilities, imapFlagsToKeywords } from "./imap.js";
export { JmapMailProvider, jmapCapabilities, normalizeJmap } from "./jmap.js";
export {
  createMockEmails,
  MockCalendarProvider,
  MockMailProvider,
  mockCapabilities,
} from "./mock.js";
export {
  generatePreview,
  htmlToText,
  normalizeAddresses,
  normalizeHeaders,
  normalizeMime,
  parseListUnsubscribe,
  toIso,
} from "./normalize/index.js";
export {
  createProviderRegistry,
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_MAIL_SCOPES,
  MICROSOFT_CALENDAR_SCOPES,
  MICROSOFT_MAIL_SCOPES,
} from "./registry.js";
export type { HeaderInput, PassportVerifier } from "./verification.js";
export { parseAuthenticationResults, StubPassportVerifier } from "./verification.js";
