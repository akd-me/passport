import type {
  Account,
  ActionCategory,
  CalendarEvent,
  Email,
  Matter,
  Person,
  Store,
} from "@passport/types";
import { DEFAULT_POLICY_CONFIG } from "@passport/types";

export const CATEGORIES: ActionCategory[] = [
  "triage",
  "newsletters",
  "receipts",
  "notifications",
  "scheduling",
  "replies_known",
  "replies_stranger",
  "money",
  "legal",
  "unsubscribe",
  "matters",
  "other",
];
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
export const demoCapabilities = {
  mail: true,
  calendar: true,
  contacts: true,
  push: false,
  labels: true,
  submit: true,
};
export async function seedDemo(store: Store): Promise<void> {
  const account: Account = {
    id: "account-demo",
    kind: "mock",
    displayName: "Personal workspace",
    emailAddress: "alex@passport.demo",
    capabilities: demoCapabilities,
    settings: {},
    createdAt: ago(720),
    updatedAt: ago(1),
    lastSyncAt: ago(0.1),
  };
  await store.accounts.upsert(account);
  await store.mailboxes.upsertMany(
    ["inbox", "archive", "sent", "drafts", "trash"].map((role) => ({
      id: `mailbox-${role}`,
      accountId: account.id,
      providerId: role,
      name: role[0]!.toUpperCase() + role.slice(1),
      role: role as "inbox",
      totalEmails: 0,
      unreadEmails: 0,
    })),
  );
  const names = [
    ["Maya Chen", "maya@northstar.studio", "Design partner"],
    ["Oliver Grant", "oliver@fieldwork.co", "Project lead"],
    ["Priya Shah", "priya@acorn.finance", "Your accountant"],
    ["Sam Rivera", "sam@hey.com", "Friend · travel companion"],
    ["Nina Park", "nina@atelier.design", "Brand designer"],
    ["Theo Brooks", "theo@greenhouse.io", "Hiring partner"],
    ["Field Notes", "letters@fieldnotes.email", "Weekly design newsletter"],
    ["Harbor House", "stay@harborhouse.example", "Portland reservation"],
  ];
  const people: Person[] = names.map(([name, email, notes], i) => ({
    id: `person-${i}`,
    displayName: name!,
    primaryEmail: email!,
    emails: [email!],
    verification: i < 2 || i === 4 ? "blue" : "green",
    lastSeenBlueAt: i === 2 ? ago(80) : i < 2 ? ago(2) : null,
    relationship: i > 5 ? "service" : "known",
    notes,
    stats: { sent: 5 + i * 3, received: 12 + i * 4, lastContactAt: ago(i + 1) },
    createdAt: ago(1440),
    updatedAt: ago(i),
  }));
  for (const person of people) {
    await store.people.upsert(person);
  }
  const titles = [
    "Northstar · autumn launch",
    "A long weekend in Portland",
    "October books & receipts",
    "A new home for the brand",
    "Finding our next engineer",
    "Reading room",
  ];
  const summaries = [
    "Maya has shared the final launch assets. The team is aligned on Thursday; a short confirmation is all that remains.",
    "Sam found a small hotel by the water. Your room is reserved for November 6–9; confirm the arrival time with Harbor House.",
    "Priya is closing the October books. Two receipts need a quick review before she can finish the monthly reconciliation.",
    "Nina has sent two identity directions. The quieter typographic approach fits the brief; feedback is due Friday.",
    "Theo has shortlisted three engineers. The next step is to find a time for a conversation with the strongest candidate.",
    "Thoughtful things saved for later. Design writing, field notes, and a few links worth coming back to.",
  ];
  const matterPeople = [[0, 1], [3, 7], [2], [4], [5], [6]];
  const matters: Matter[] = titles.map((title, i) => ({
    id: `matter-${i}`,
    title,
    summary: summaries[i]!,
    status: i === 1 || i === 4 ? "waiting" : "active",
    kind: ["project", "trip", "personal", "project", "hiring", "subscription"][i],
    personIds: matterPeople[i]!.map((p) => `person-${p}`),
    emailIds: [],
    eventIds: [],
    nextStep: [
      "Confirm Thursday’s launch with Maya.",
      "Share your estimated arrival time.",
      "Review the two outstanding receipts.",
      "Send feedback on direction two.",
      "Confirm interview availability.",
      "Read whenever you have a quiet moment.",
    ][i],
    dueAt: i === 0 ? ago(-24) : null,
    createdAt: ago(240),
    updatedAt: ago(i * 2),
  }));
  const subjects = [
    "Final assets are ready for Thursday",
    "A little place by the water",
    "October reconciliation — two quick questions",
    "Identity exploration, round two",
    "Three people I think you should meet",
    "Field Notes: making space for good work",
  ];
  const bodies = [
    "Hi Alex,\n\nThe final assets are in the shared folder. Everything is ready for Thursday’s launch. Can you confirm we’re good to go at 10?\n\nThanks,\nMaya",
    "Hey Alex,\n\nI booked Harbor House for our Portland weekend. It’s right on the water and looks lovely. Let me know when your train arrives and we can meet for coffee.\n\nSam",
    "Hi Alex,\n\nI’m wrapping up the October books. Could you check the studio equipment receipt and confirm which project the travel expense belongs to?\n\nBest,\nPriya",
    "Hi Alex,\n\nHere are the two directions we discussed. I’m leaning toward the second, with the quieter typography. I’d love to hear what feels right to you by Friday.\n\nNina",
    "Hi Alex,\n\nI’ve narrowed the search to three strong candidates. Are you free on Tuesday afternoon for an introductory call? I can take care of the scheduling.\n\nTheo",
    "This week: a slower approach to making things. A collection of observations on creative work, patient design, and leaving enough room to think. Save this one for a quiet afternoon.",
  ];
  const emails: Email[] = Array.from({ length: 40 }, (_, i) => {
    const m = i % 6,
      person = people[matterPeople[m]![0]!]!,
      id = `email-${i}`;
    matters[m]!.emailIds.push(id);
    return {
      id,
      accountId: account.id,
      providerId: `demo-${i}`,
      threadId: `thread-${m}`,
      mailboxIds: [i < 12 ? "mailbox-inbox" : "mailbox-archive"],
      keywords: i > 5 ? { $seen: true } : {},
      from: [{ name: person.displayName, email: person.primaryEmail }],
      to: [{ name: "Alex Morgan", email: account.emailAddress }],
      cc: [],
      bcc: [],
      replyTo: [],
      subject: i < 6 ? subjects[m]! : `Re: ${subjects[m]}`,
      receivedAt: ago(i * 2 + 0.5),
      sentAt: ago(i * 2 + 0.6),
      preview: bodies[m]!.replace(/\n/g, " ").slice(0, 150),
      textBody: bodies[m],
      attachments: [],
      headers: {
        messageId: `<${id}@passport.demo>`,
        inReplyTo: null,
        references: [],
        authenticationResults: ["demo.local; dkim=pass; spf=pass; dmarc=pass"],
      },
      size: 1200,
      verification: {
        dkim: "pass",
        spf: "pass",
        dmarc: "pass",
        passport: person.verification === "blue" ? "blue" : m === 2 ? "downgraded" : "green",
        signer: person.primaryEmail.split("@")[1],
      },
      matterId: `matter-${m}`,
      personIds: [person.id],
      category: (
        [
          "replies_known",
          "scheduling",
          "money",
          "replies_known",
          "scheduling",
          "newsletters",
        ] as const
      )[m],
    };
  });
  await store.emails.upsertMany(emails);
  await store.threads.upsertMany(
    matters.map((m, i) => ({
      id: `thread-${i}`,
      accountId: account.id,
      emailIds: m.emailIds,
    })),
  );
  await store.calendars.upsertMany([
    {
      id: "calendar-demo",
      accountId: account.id,
      providerId: "primary",
      name: "Personal",
      isPrimary: true,
      timeZone: "America/New_York",
    },
  ]);
  const events: CalendarEvent[] = [
    "Launch check-in",
    "Portland arrival",
    "October books review",
    "Engineering conversations",
  ].map((title, i) => ({
    id: `event-${i}`,
    accountId: account.id,
    calendarId: "calendar-demo",
    providerId: `event-${i}`,
    title,
    start: ago(-24 * (i + 1)),
    end: ago(-24 * (i + 1) - 0.5),
    allDay: false,
    status: "confirmed",
    participants: [
      {
        email: people[i]!.primaryEmail,
        name: people[i]!.displayName,
        status: "accepted",
      },
    ],
    matterId: `matter-${i}`,
    updatedAt: ago(2),
    location: i === 1 ? "Harbor House, Portland" : "Video call",
  }));
  await store.events.upsertMany(events);
  for (const event of events) {
    matters.find((m) => m.id === event.matterId)!.eventIds.push(event.id);
  }
  for (const matter of matters) {
    await store.matters.upsert(matter);
  }
  await store.trust.setConfig(structuredClone(DEFAULT_POLICY_CONFIG));
  for (const [i, category] of CATEGORIES.entries()) {
    await store.trust.upsert({
      category,
      level: i < 4 ? "auto" : "supervised",
      score: i < 4 ? 0.82 - i * 0.06 : 0.31 + i * 0.02,
      stage: i < 4 ? "trusted" : "learning",
      approvals: i < 4 ? 24 + i * 3 : 8,
      approvalsUnchanged: i < 4 ? 22 + i * 3 : 6,
      edits: 2,
      rejections: i > 6 ? 1 : 0,
      lastActivityAt: ago(i),
    });
  }
  await store.kv.set(
    "user-profile",
    "# Alex Morgan\n\nKeep my replies warm, brief, and direct. Protect mornings for focused work.\n\nAlways ask before committing money or agreeing to legal terms. Maya and Oliver are my collaborators at Northstar.\n",
  );
}
