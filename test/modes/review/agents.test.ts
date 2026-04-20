import { describe, expect, it } from "bun:test";
import {
  DEFAULT_REVIEW_AGENTS,
  assertValidAgentId,
  isValidAgentId,
} from "../../../src/modes/review/agents";

describe("isValidAgentId", () => {
  it("accepts lowercase alphanumeric + hyphen ids", () => {
    expect(isValidAgentId("correctness-reviewer")).toBe(true);
    expect(isValidAgentId("a")).toBe(true);
    expect(isValidAgentId("a1")).toBe(true);
    expect(isValidAgentId("agent-123")).toBe(true);
  });

  it("rejects ids that would enable path traversal", () => {
    expect(isValidAgentId("../evil")).toBe(false);
    expect(isValidAgentId("foo/bar")).toBe(false);
    expect(isValidAgentId("foo.bar")).toBe(false);
    expect(isValidAgentId("foo\\bar")).toBe(false);
  });

  it("rejects ids that do not start with a letter", () => {
    expect(isValidAgentId("1agent")).toBe(false);
    expect(isValidAgentId("-agent")).toBe(false);
    expect(isValidAgentId("")).toBe(false);
  });

  it("rejects uppercase and whitespace", () => {
    expect(isValidAgentId("Agent")).toBe(false);
    expect(isValidAgentId("agent name")).toBe(false);
  });

  it("rejects ids longer than 64 chars", () => {
    expect(isValidAgentId("a".repeat(64))).toBe(true);
    expect(isValidAgentId("a".repeat(65))).toBe(false);
  });
});

describe("assertValidAgentId", () => {
  it("is a no-op for valid ids", () => {
    expect(() => assertValidAgentId("quality-reviewer")).not.toThrow();
  });

  it("throws for invalid ids", () => {
    expect(() => assertValidAgentId("../nope")).toThrow(/Invalid agent id/);
  });
});

describe("DEFAULT_REVIEW_AGENTS", () => {
  it("ships the three canonical perspectives", () => {
    const ids = DEFAULT_REVIEW_AGENTS.map((a) => a.id).sort();
    expect(ids).toEqual([
      "correctness-reviewer",
      "quality-reviewer",
      "security-reviewer",
    ]);
  });

  it("has unique ids", () => {
    const ids = DEFAULT_REVIEW_AGENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has non-empty perspectives", () => {
    for (const agent of DEFAULT_REVIEW_AGENTS) {
      expect(agent.perspective.length).toBeGreaterThan(20);
      expect(agent.name.length).toBeGreaterThan(0);
    }
  });

  it("all ids pass the validation regex", () => {
    for (const agent of DEFAULT_REVIEW_AGENTS) {
      expect(isValidAgentId(agent.id)).toBe(true);
    }
  });
});
