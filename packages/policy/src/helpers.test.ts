import { describe, expect, it } from "vitest";
import { classifyCounterparty, describeDecision, editDistanceRatio } from "./helpers.js";
import { person } from "./testing/fixtures.js";

describe("classifyCounterparty", () => {
  it("recognizes self case-insensitively without trusting a mixed recipient set", () => {
    expect(classifyCounterparty(null, [" ME@example.com "], ["me@example.com"])).toBe("self");
    expect(
      classifyCounterparty(null, ["me@example.com", "other@example.com"], ["me@example.com"]),
    ).toBe("stranger");
    expect(classifyCounterparty(null, [], ["me@example.com"])).toBe("stranger");
  });
  it.each([
    { patch: { verification: "blue" as const }, expected: "blue" },
    { patch: { verification: "green" as const }, expected: "green_known" },
    { patch: { relationship: "service" as const }, expected: "service" },
    { patch: { relationship: "self" as const, verifiedSelf: true }, expected: "self" },
    { patch: { relationship: "stranger" as const }, expected: "stranger" },
  ])("uses identity/relationship fields for $expected", ({ patch, expected }) => {
    expect(classifyCounterparty(person(patch), ["FRIEND@example.com"], [])).toBe(expected);
  });
  it("does not extend a verified identity to unrecognized addresses", () => {
    expect(
      classifyCounterparty(person({ verification: "blue" }), ["stranger@example.com"], []),
    ).toBe("stranger");
  });
});
describe("editDistanceRatio", () => {
  it.each([
    ["", "", 0],
    ["", "hello", 1],
    ["kitten", "sitting", 3 / 7],
    ["same", "same", 0],
    ["😀", "😃", 1],
  ])("normalizes %s -> %s", (a, b, ratio) => {
    expect(editDistanceRatio(a, b)).toBeCloseTo(ratio);
  });
  it("compares JSON leaves independently of object key order", () => {
    expect(editDistanceRatio({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 })).toBe(0);
    expect(editDistanceRatio({ a: 1, b: 2 }, { a: 1, b: 3 })).toBe(0.5);
    expect(editDistanceRatio({ a: 1 }, { a: 1, b: 2 })).toBe(0.5);
  });
});
it("describes the outcome, reason, risk, reversibility and trust level", () => {
  expect(
    describeDecision({
      outcome: "ask",
      reason: "Needs approval",
      risk: "high",
      reversibility: "delayed",
      trustLevel: "supervised",
      category: "other",
    }),
  ).toBe("ask: Needs approval (high risk, delayed, supervised)");
});
