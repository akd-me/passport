import { createHash } from "node:crypto";
import type {
  CalendarProvider,
  CalendarProviderKind,
  MailProvider,
  MailProviderKind,
  ProviderKind,
  ProviderRegistry,
  ProviderSetupDescriptor,
} from "@passport/types";
import { CalDavCalendarProvider } from "./caldav.js";
import { NotImplementedError, ProviderError, required } from "./errors.js";
import { GmailMailProvider } from "./gmail.js";
import { GoogleCalendarProvider } from "./google-calendar.js";
import { GraphMailProvider } from "./graph.js";
import { GraphCalendarProvider } from "./graph-calendar.js";
import { exchangeToken, googleTokenUrl, microsoftTokenUrl, type ProviderOptions } from "./http.js";
import { ImapMailProvider, type ImapProviderOptions } from "./imap.js";
import { JmapMailProvider } from "./jmap.js";
import { MockCalendarProvider, MockMailProvider } from "./mock.js";

type Field = ProviderSetupDescriptor["fields"][number];
const field = (
  id: string,
  label: string,
  secret = false,
  required = true,
  help?: string,
): Field => ({ id, label, secret, required, ...(help ? { help } : {}) });
export const GOOGLE_MAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];
export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.freebusy",
];
export const MICROSOFT_MAIL_SCOPES = [
  "offline_access",
  "https://graph.microsoft.com/Mail.ReadWrite",
  "https://graph.microsoft.com/Mail.Send",
];
export const MICROSOFT_CALENDAR_SCOPES = [
  "offline_access",
  "https://graph.microsoft.com/Calendars.ReadWrite",
];

function oauthDescriptor(kind: ProviderKind, options: ProviderOptions): ProviderSetupDescriptor {
  const google = kind === "gmail" || kind === "google-calendar";
  function providerScopes() {
    if (kind === "gmail") {
      return GOOGLE_MAIL_SCOPES;
    }
    if (kind === "google-calendar") {
      return GOOGLE_CALENDAR_SCOPES;
    }
    if (kind === "graph") {
      return MICROSOFT_MAIL_SCOPES;
    }
    return MICROSOFT_CALENDAR_SCOPES;
  }
  const scopes = [...providerScopes()];
  return {
    kind,
    label: (
      {
        gmail: "Gmail",
        graph: "Microsoft Outlook",
        "google-calendar": "Google Calendar",
        "graph-calendar": "Microsoft Calendar",
      } as Record<string, string>
    )[kind]!,
    fields: [
      field("clientId", "Your OAuth client ID"),
      field("clientSecret", "Your OAuth client secret", true, false),
      ...(!google
        ? [
            field(
              "tenantId",
              "Tenant ID",
              false,
              false,
              "Use common for personal and work accounts, or your directory tenant ID",
            ),
          ]
        : []),
      ...(kind.includes("calendar")
        ? [
            field(
              "calendarId",
              "Calendar ID",
              false,
              false,
              google
                ? "Defaults to primary; one calendar per account"
                : "Leave unset: v1.0 delta sync uses the primary calendar",
            ),
          ]
        : []),
      field(
        "codeVerifier",
        "PKCE code verifier",
        true,
        false,
        "Optional for confidential clients; required for public clients. Retain only for the current authorization attempt.",
      ),
    ],
    docsUrl: google
      ? "https://developers.google.com/identity/protocols/oauth2/web-server"
      : "https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow",
    oauth: {
      scopes,
      buildAuthUrl(settings, redirectUri, state) {
        required(state, "OAuth state");
        const tenant = encodeURIComponent(settings.tenantId ?? "common");
        const url = new URL(
          google
            ? "https://accounts.google.com/o/oauth2/v2/auth"
            : `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
        );
        url.search = new URLSearchParams({
          client_id: required(settings.clientId, "clientId"),
          redirect_uri: redirectUri,
          response_type: "code",
          scope: settings.scopes ?? scopes.join(" "),
          state,
          ...(google ? { access_type: "offline", prompt: "consent" } : { response_mode: "query" }),
          ...(settings.codeVerifier
            ? {
                code_challenge: createHash("sha256")
                  .update(settings.codeVerifier)
                  .digest("base64url"),
                code_challenge_method: "S256",
              }
            : {}),
        }).toString();
        return url.href;
      },
      async exchangeCode(settings, redirectUri, code) {
        if (!google && !settings.clientSecret && !settings.codeVerifier) {
          throw new ProviderError(
            "CONFIG_REQUIRED",
            "Microsoft public clients require a PKCE codeVerifier",
          );
        }
        if (google && !settings.clientSecret && !settings.codeVerifier) {
          throw new ProviderError(
            "CONFIG_REQUIRED",
            "Google public clients require a PKCE codeVerifier",
          );
        }
        const credentials = await exchangeToken(
          options.fetch ?? globalThis.fetch,
          google ? googleTokenUrl : microsoftTokenUrl(settings.tenantId),
          {
            grant_type: "authorization_code",
            client_id: required(settings.clientId, "clientId"),
            redirect_uri: redirectUri,
            code: required(code, "authorization code"),
            ...(settings.clientSecret ? { client_secret: settings.clientSecret } : {}),
            ...(settings.codeVerifier ? { code_verifier: settings.codeVerifier } : {}),
            ...(!google ? { scope: settings.scopes ?? scopes.join(" ") } : {}),
          },
        );
        // Preserve the user's confidential client credential for refresh; never place it in Account.settings.
        return {
          ...credentials,
          ...(settings.clientSecret ? { clientSecret: settings.clientSecret } : {}),
        };
      },
    },
  };
}

/** Registry methods are factories: keep one connected instance for each configured account. */
export function createProviderRegistry(options: ImapProviderOptions = {}): ProviderRegistry {
  return {
    mail(kind: MailProviderKind): MailProvider {
      switch (kind) {
        case "gmail":
          return new GmailMailProvider(options);
        case "graph":
          return new GraphMailProvider(options);
        case "imap":
          return new ImapMailProvider(options);
        case "jmap":
          return new JmapMailProvider(options);
        case "mock":
          return new MockMailProvider(options);
        default:
          throw new ProviderError("UNKNOWN_PROVIDER", "Unknown mail provider kind");
      }
    },
    calendar(kind: CalendarProviderKind): CalendarProvider {
      switch (kind) {
        case "google-calendar":
          return new GoogleCalendarProvider(options);
        case "graph-calendar":
          return new GraphCalendarProvider(options);
        case "caldav":
          return new CalDavCalendarProvider(options);
        case "mock":
          return new MockCalendarProvider();
        case "jmap-calendar":
          throw new NotImplementedError(
            "JMAP Calendar is outside this package's current adapter set",
          );
        default:
          throw new ProviderError("UNKNOWN_PROVIDER", "Unknown calendar provider kind");
      }
    },
    describe(kind: ProviderKind): ProviderSetupDescriptor {
      if (["gmail", "graph", "google-calendar", "graph-calendar"].includes(kind)) {
        return oauthDescriptor(kind, options);
      }
      if (kind === "mock") {
        return { kind, label: "Demo mail and calendar", fields: [] };
      }
      if (kind === "jmap") {
        return {
          kind,
          label: "JMAP",
          docsUrl: "https://jmap.io/spec.html",
          fields: [
            field(
              "sessionUrl",
              "HTTPS session discovery URL",
              false,
              true,
              "Usually https://mail.example.com/.well-known/jmap",
            ),
            field("token", "Bearer token", true),
            field("jmapAccountId", "JMAP account ID", false, false),
          ],
        };
      }
      if (kind === "caldav") {
        return {
          kind,
          label: "CalDAV",
          fields: [
            field("calendarUrl", "HTTPS calendar collection URL"),
            field("username", "Username", false, false, "Defaults to the account email address"),
            field("password", "App password", true),
            field(
              "timeZone",
              "Timezone for floating events",
              false,
              false,
              "IANA timezone; defaults to UTC",
            ),
          ],
        };
      }
      if (kind === "imap") {
        return {
          kind,
          label: "IMAP / SMTP",
          fields: [
            field("host", "IMAP host"),
            field("port", "IMAP port", false, false, "Defaults to 993"),
            field(
              "tls",
              "IMAP implicit TLS",
              false,
              false,
              "Defaults to true; false requires STARTTLS",
            ),
            field("username", "IMAP username", false, false),
            field("password", "IMAP app password", true),
            field("smtpHost", "SMTP host", false, true, "Required to send mail"),
            field("smtpPort", "SMTP port", false, false, "Defaults to 465"),
            field(
              "smtpTls",
              "SMTP implicit TLS",
              false,
              false,
              "Defaults to true; false requires STARTTLS",
            ),
            field("smtpUsername", "SMTP username", false, false),
            field("smtpPassword", "SMTP app password", true, false),
            ...["drafts", "sent", "trash"].map((role) =>
              field(
                `${role}Folder`,
                `${role} folder path`,
                false,
                false,
                "Optional override for the server's SPECIAL-USE folder",
              ),
            ),
          ],
        };
      }
      throw new NotImplementedError("No setup descriptor is available for JMAP Calendar");
    },
  };
}
