import { describe, expect, it } from "vitest";
import { decisionLink, linkFromArgv, routeFor, taskLink } from "./deep-links";

describe("routeFor", () => {
  it.each([
    ["passport://task/tsk_01HZX", "/tasks/tsk_01HZX"],
    [taskLink("abc-123"), "/tasks/abc-123"],
    ["passport://needs-you", "/needs-you"],
    ["passport://needs-you/", "/needs-you"],
    ["passport://tasks", "/tasks"],
    [decisionLink("act_1"), "/?decision=act_1"],
    ["passport://matter/m1", "/matters/m1"],
    ["passport://settings/trust", "/trust"],
    ["passport://settings", "/accounts"],
    ["passport://open", "/"],
  ])("%s → %s", (link, route) => {
    expect(routeFor(link)).toBe(route);
  });

  it.each([
    "passport://task",
    "passport://task/a/b",
    "passport://task/..%2Fsettings",
    `passport://task/${"x".repeat(65)}`,
    "passport://needs-you/extra",
    "passport://tasks/t1",
    "https://example.com/task/t1",
    "not a url",
  ])("rejects %s", (link) => {
    expect(routeFor(link)).toBeNull();
  });
});

describe("linkFromArgv", () => {
  it("finds the passport:// argument", () => {
    expect(linkFromArgv(["/Applications/Passport.app", "passport://task/t1"])).toBe(
      "passport://task/t1",
    );
    expect(linkFromArgv(["--hidden"])).toBeUndefined();
  });
});
