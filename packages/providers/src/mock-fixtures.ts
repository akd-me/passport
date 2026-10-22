import type { AccountCapabilities, Email, MailboxRole } from "@passport/types";
import { localId } from "./errors.js";
import { generatePreview, normalizeHeaders } from "./normalize/index.js";
import { parseAuthenticationResults } from "./verification.js";

export const mockCapabilities: AccountCapabilities = {
  mail: true,
  calendar: true,
  contacts: false,
  push: true,
  labels: true,
  submit: true,
  search: true,
  onDemand: true,
};

export const folderNames = [
  "Inbox",
  "Archive",
  "Drafts",
  "Sent",
  "Trash",
  "Junk",
  "Newsletters",
  "Receipts",
];

/** Special-use roles of the fixture folders; other folders are plain labels. */
export const folderRoles: Readonly<Record<string, MailboxRole>> = {
  Inbox: "inbox",
  Archive: "archive",
  Drafts: "drafts",
  Sent: "sent",
  Trash: "trash",
  Junk: "junk",
};

export const fixtureEpoch = Date.parse("2026-01-15T09:00:00Z");

export const clone = <T>(value: T): T => structuredClone(value);

/** Forty deterministic messages suitable for triage, trust, scheduling, and unsubscribe tests. */
export function createMockEmails(accountId: string, owner = "alex@example.com"): Email[] {
  const samples: Array<[string, string, string, string]> = [
    ...Array.from({ length: 10 }, (_, i): [string, string, string, string] => [
      "newsletters",
      "dispatch@weekly.example",
      `Systems Weekly #${101 + i}`,
      "This week: practical engineering, open source, and a reading list.",
    ]),
    ...Array.from({ length: 8 }, (_, i): [string, string, string, string] => [
      "receipts",
      "billing@shop.example",
      `Receipt for order #${2400 + i}`,
      `Thank you for your purchase. Total: $${19 + i}.00. Your order is confirmed.`,
    ]),
    ...Array.from({ length: 4 }, (_, i): [string, string, string, string] => [
      "replies_known",
      "sam@example.com",
      `Re: Garden project ${i + 1}`,
      "Thanks Alex! I reviewed the plan. Let's use the smaller design we discussed.",
    ]),
    [
      "replies_stranger",
      "pat@unknown.example",
      "An introduction",
      "We have not met. Could you share your team's plans for next quarter?",
    ],
    [
      "replies_stranger",
      "sales@unknown.example",
      "Quick product introduction",
      "I found your public project and wanted to introduce our service. May I send details?",
    ],
    ...Array.from({ length: 3 }, (_, i): [string, string, string, string] => [
      "other",
      "jordan@recruiting.example",
      `Engineering role ${i + 1}`,
      "I'm recruiting for an engineering team. Would you be open to a conversation?",
    ]),
    ...Array.from({ length: 4 }, (_, i): [string, string, string, string] => [
      "notifications",
      "notifications@code.example",
      `Build ${310 + i} completed`,
      "All checks passed. View the build report in your project dashboard.",
    ]),
    ...[
      "Can we meet Tuesday?",
      "Re: Can we meet Tuesday?",
      "Re: Can we meet Tuesday?",
      "Confirmed: Tuesday at 2",
    ].map((s, i): [string, string, string, string] => [
      "scheduling",
      "sam@example.com",
      s,
      [
        "Are you free at 2pm UTC?",
        "2pm works. Shall we use the usual room?",
        "Yes, see you there.",
        "Calendar invitation follows.",
      ][i]!,
    ]),
    ...Array.from({ length: 3 }, (_, i): [string, string, string, string] => [
      "scheduling",
      "sam@example.com",
      `Invitation: Design review ${i + 1}`,
      "Please join the design review. The attached calendar invitation has the details.",
    ]),
    [
      "other",
      "verified@service.example",
      "Authenticated delivery",
      "This message has a receiver-reported DKIM pass.",
    ],
    [
      "other",
      "spoof@service.example",
      "Suspicious delivery",
      "This message has a receiver-reported DKIM fail.",
    ],
  ];
  return samples.map(([category, from, subject, text], index) => {
    const providerId = `fixture-${String(index + 1).padStart(2, "0")}`,
      date = new Date(fixtureEpoch + index * 3600_000).toISOString();
    const headers = normalizeHeaders({
      "message-id": `<${providerId}@mock.passport>`,
      date,
      from,
      to: owner,
      "authentication-results": `mx.mock; dkim=${index === 39 ? "fail" : "pass"} header.d=${from.split("@")[1]}; spf=pass; dmarc=${index === 39 ? "fail" : "pass"}`,
      ...(category === "newsletters"
        ? {
            "list-id": "Systems Weekly <weekly.example>",
            "list-unsubscribe":
              "<https://weekly.example/unsubscribe>, <mailto:leave@weekly.example>",
            "list-unsubscribe-post": "List-Unsubscribe=One-Click",
          }
        : {}),
      ...(category === "replies_known" || (index >= 31 && index <= 34)
        ? {
            "in-reply-to": "<garden-start@mock.passport>",
            references: "<garden-start@mock.passport>",
          }
        : {}),
      ...(index === 38 ? { "x-passport-signature": "stub-fixture-not-a-verified-signature" } : {}),
    });
    const invite = index >= 35 && index <= 37;
    return {
      id: localId(accountId, "email", providerId),
      accountId,
      providerId,
      threadId: localId(
        accountId,
        "thread",
        category === "replies_known"
          ? "garden"
          : index >= 31 && index <= 34
            ? "scheduling"
            : providerId,
      ),
      mailboxIds: [
        localId(
          accountId,
          "mailbox",
          index < 10 ? "Newsletters" : index < 18 ? "Receipts" : "Inbox",
        ),
      ],
      keywords: index % 3 === 0 ? { $seen: true } : {},
      from: [
        { email: from, name: from === "sam@example.com" ? "Sam Rivera" : from.split("@")[0]! },
      ],
      to: [{ email: owner }],
      cc: [],
      bcc: [],
      replyTo: [],
      subject,
      sentAt: date,
      receivedAt: date,
      preview: generatePreview(text),
      textBody: text,
      htmlBody: `<p>${text}</p>`,
      headers,
      size: Buffer.byteLength(text) + 500,
      personIds: [],
      verification: parseAuthenticationResults(headers),
      attachments: invite
        ? [
            {
              id: localId(accountId, "attachment", providerId),
              name: "invite.ics",
              type: "text/calendar",
              size: Buffer.byteLength(mockInvite(providerId)),
              blobId: `mock-invite:${providerId}`,
              disposition: "attachment",
            },
          ]
        : [],
    };
  });
}

export function mockInvite(uid: string): string {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Passport//Mock//EN\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:${uid}@mock.passport\r\nDTSTAMP:20260115T090000Z\r\nDTSTART:20260120T140000Z\r\nDTEND:20260120T143000Z\r\nSUMMARY:Design review\r\nORGANIZER:mailto:sam@example.com\r\nATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:alex@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
}
