import { expect, it } from "vitest";
import { createToolRegistry, DEFAULT_RESPONSE_BYTE_BUDGET } from "./index.js";
import { MemoryBus, MemoryExecutor, MemoryPolicy, MemoryStore } from "./testing/fakes.js";
import { account, email } from "./testing/fixtures.js";

async function setup(responseByteBudget = DEFAULT_RESPONSE_BYTE_BUDGET) {
  const store = new MemoryStore(),
    policy = new MemoryPolicy();
  await store.accounts.upsert(account());
  const tools = createToolRegistry({
    store,
    policy,
    executor: new MemoryExecutor(store, policy),
    bus: new MemoryBus(),
    actor: { kind: "agent", id: "test" },
    selfAddresses: [],
    responseByteBudget,
  });
  return {
    store,
    call: (name: string, input: object) => tools.find((tool) => tool.name === name)!.handler(input),
  };
}
it("R14 caps an 11 MiB full body and all bodies in a multi-email response at 512 KiB total", async () => {
  const { store, call } = await setup();
  await store.emails.upsertMany([
    email({ textBody: "x".repeat(11 * 1024 * 1024), htmlBody: null }),
  ]);
  const one = await call("get_email", { emailId: "email-1", full: true });
  expect(Buffer.byteLength(JSON.stringify(one))).toBeLessThanOrEqual(DEFAULT_RESPONSE_BYTE_BUDGET);
  expect(one).toMatchObject({ truncated: true, continueFrom: (one.textBody as string).length });
  await store.emails.upsertMany([
    email({ id: "email-2", textBody: "z".repeat(600_000), htmlBody: null }),
  ]);
  const page = await call("search_emails", { full: true });
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(DEFAULT_RESPONSE_BYTE_BUDGET);
  expect(page).toHaveProperty("truncated", true);
  expect(page.items).toHaveLength(2);
});
it("R14 chunk offsets reconstruct Unicode/escaped bodies within a configurable total byte budget", async () => {
  const { store, call } = await setup(4096);
  const text = '😀\n"\\'.repeat(1800);
  await store.emails.upsertMany([email({ textBody: text, htmlBody: null })]);
  let offset = 0,
    body = "";
  for (let requests = 0; requests < 100; requests++) {
    const result = await call("get_email_body", { emailId: "email-1", offset, length: 1_000_000 });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096);
    expect(result.isError).not.toBe(true);
    body += result.textBody;
    if (!result.truncated) break;
    expect(result.continueFrom).toBeGreaterThan(offset);
    expect(result.textBody).not.toMatch(/[\uD800-\uDBFF]$/);
    offset = result.continueFrom as number;
  }
  expect(body).toBe(text);
  expect(
    await call("get_email_body", { emailId: "email-1", offset: text.length, length: 100 }),
  ).toMatchObject({ textBody: "", truncated: false });
  expect(
    await call("get_email_body", { emailId: "email-1", offset: -1, length: 1 }),
  ).toHaveProperty("isError", true);
});

it("R14 bounds validation errors as well as successful results and supports single-code-unit chunks", async () => {
  const { store, call } = await setup(4096);
  const result = await call("get_email", { ["x".repeat(100_000)]: true });
  expect(result.isError).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096);
  await store.emails.upsertMany([email({ textBody: "😀", htmlBody: null })]);
  const first = await call("get_email_body", { emailId: "email-1", offset: 0, length: 1 });
  expect(first.continueFrom).toBe(1);
  const second = await call("get_email_body", { emailId: "email-1", offset: 1, length: 1 });
  expect(String(first.textBody) + String(second.textBody)).toBe("😀");
});
