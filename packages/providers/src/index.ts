/** Provider adapters for composition roots. Mutations must be dispatched through ActionExecutor. */
export { createProviderRegistry, GOOGLE_MAIL_SCOPES, GOOGLE_CALENDAR_SCOPES, MICROSOFT_MAIL_SCOPES, MICROSOFT_CALENDAR_SCOPES } from "./registry.js";
export { ProviderError, NotImplementedError, SubmissionAcceptedError } from "./errors.js";
export type { ProviderOptions } from "./http.js";
export { parseAuthenticationResults, StubPassportVerifier } from "./verification.js";
export type { PassportVerifier, HeaderInput } from "./verification.js";
export { normalizeAddresses, toIso, generatePreview, htmlToText, parseListUnsubscribe, normalizeHeaders, normalizeMime } from "./normalize/index.js";
export { MockMailProvider, MockCalendarProvider, createMockEmails, mockCapabilities } from "./mock.js";
export { GmailMailProvider, normalizeGmail, gmailCapabilities } from "./gmail.js";
export { GraphMailProvider, normalizeGraph, graphCapabilities } from "./graph.js";
export { ImapMailProvider, imapFlagsToKeywords, imapCapabilities } from "./imap.js";
export type { ImapProviderOptions, SmtpClient } from "./imap.js";
export { JmapMailProvider, normalizeJmap, jmapCapabilities } from "./jmap.js";
export { GoogleCalendarProvider, normalizeGoogleEvent } from "./google-calendar.js";
export { GraphCalendarProvider, normalizeGraphEvent } from "./graph-calendar.js";
export { CalDavCalendarProvider, normalizeIcalendar } from "./caldav.js";
