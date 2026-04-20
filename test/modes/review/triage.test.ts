/**
 * Unit tests for `runTriageAgent` — the zero-tool routing sub-agent used by
 * `multi_agent_review: "auto"`.
 *
 * Covered invariants:
 *   1. Success path returns the parsed `{decision, reason}` payload verbatim.
 *   2. A `null` structuredOutput triggers retry, then falls back to
 *      `{decision: "single"}` — never throws.
 *   3. A thrown error inside `runClaude` triggers retry, then falls back to
 *      single — never propagates.
 *   4. A schema violation (missing required field / invalid enum value)
 *      triggers retry, then falls back to single.
 *   5. `formatTriageLine` produces the audit-trail string embedded in the
 *      synthesis comment.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { ParsedGitHubContext } from "../../../src/github/context";

const PROMPT_FILE_PATH = "/tmp/claude-prompts/claude-prompt.txt";

function makeContext(): ParsedGitHubContext {
  return {
    runId: "run-1",
    eventName: "pull_request",
    eventAction: "opened",
    repository: {
      full_name: "acme/widgets",
      owner: "acme",
      repo: "widgets",
    },
    actor: "alice",
    payload: {
      action: "opened",
      pull_request: { number: 42 },
    } as any,
    entityNumber: 42,
    isPR: true,
    inputs: {
      prompt: "",
      triggerPhrase: "@claude",
      assigneeTrigger: "",
      labelTrigger: "",
      branchPrefix: "claude/",
      useStickyComment: false,
      classifyInlineComments: true,
      useCommitSigning: false,
      sshSigningKey: "",
      botId: "123",
      botName: "claude-bot",
      allowedBots: "",
      allowedNonWriteUsers: "",
      trackProgress: false,
      includeFixLinks: true,
      includeCommentsByActor: "",
      excludeCommentsByActor: "",
      multiAgentReview: "auto",
      reviewDebateRounds: "0",
    },
  };
}

type RunClaudeCall = { promptPath: string; options: any };

let runClaudeCalls: RunClaudeCall[] = [];
let runClaudeImpl: (promptPath: string, options: any) => Promise<any> = () =>
  Promise.reject(new Error("impl not set"));

beforeEach(() => {
  runClaudeCalls = [];
  runClaudeImpl = () => Promise.reject(new Error("impl not set"));

  mock.module("../../../base-action/src/run-claude", () => ({
    runClaude: async (promptPath: string, options: any) => {
      runClaudeCalls.push({ promptPath, options });
      return runClaudeImpl(promptPath, options);
    },
  }));
});

afterEach(() => {
  mock.restore();
});

describe("runTriageAgent", () => {
  it("returns the decision on the happy path (multi)", async () => {
    runClaudeImpl = async () => ({
      conclusion: "success",
      structuredOutput: JSON.stringify({
        decision: "multi",
        reason: "touches src/auth and adds SQL migration",
      }),
    });
    const { runTriageAgent } = await import("../../../src/modes/review/triage");

    const decision = await runTriageAgent({
      context: makeContext(),
      githubContextMarkdown: "pr-context",
      promptFilePath: PROMPT_FILE_PATH,
    });

    expect(decision.decision).toBe("multi");
    expect(decision.reason).toContain("src/auth");
    expect(runClaudeCalls).toHaveLength(1);
  });

  it("returns the decision on the happy path (single)", async () => {
    runClaudeImpl = async () => ({
      conclusion: "success",
      structuredOutput: JSON.stringify({
        decision: "single",
        reason: "docs-only, 12 lines changed",
      }),
    });
    const { runTriageAgent } = await import("../../../src/modes/review/triage");

    const decision = await runTriageAgent({
      context: makeContext(),
      githubContextMarkdown: "pr-context",
      promptFilePath: PROMPT_FILE_PATH,
    });

    expect(decision.decision).toBe("single");
    expect(decision.reason).toContain("docs-only");
  });

  it("passes zero tools and the triage schema to runClaude", async () => {
    runClaudeImpl = async () => ({
      conclusion: "success",
      structuredOutput: JSON.stringify({
        decision: "single",
        reason: "trivial",
      }),
    });
    const { runTriageAgent } = await import("../../../src/modes/review/triage");

    await runTriageAgent({
      context: makeContext(),
      githubContextMarkdown: "pr-context",
      promptFilePath: PROMPT_FILE_PATH,
    });

    const [call] = runClaudeCalls;
    const args: string = call!.options.claudeArgs ?? "";
    // empty allowedTools string means zero tools
    expect(args).toContain('--allowedTools ""');
    expect(args).not.toContain("--mcp-config");
    expect(args).toContain("--json-schema");
    // Triage schema has decision enum and reason maxLength
    expect(args).toContain('"decision"');
    expect(args).toContain('"reason"');
  });

  it("falls back to single when structuredOutput is missing (after retries)", async () => {
    runClaudeImpl = async () => ({
      conclusion: "success",
      // structuredOutput intentionally omitted
    });
    const { runTriageAgent } = await import("../../../src/modes/review/triage");

    const decision = await runTriageAgent({
      context: makeContext(),
      githubContextMarkdown: "pr-context",
      promptFilePath: PROMPT_FILE_PATH,
    });

    expect(decision.decision).toBe("single");
    expect(decision.reason).toBe("triage unavailable, see logs");
    // retry: maxAttempts=2
    expect(runClaudeCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("falls back to single when runClaude throws (after retries)", async () => {
    runClaudeImpl = async () => {
      throw new Error("SDK timeout");
    };
    const { runTriageAgent } = await import("../../../src/modes/review/triage");

    const decision = await runTriageAgent({
      context: makeContext(),
      githubContextMarkdown: "pr-context",
      promptFilePath: PROMPT_FILE_PATH,
    });

    expect(decision.decision).toBe("single");
    // Security invariant: raw SDK error must not leak into the public reason.
    expect(decision.reason).toBe("triage unavailable, see logs");
    expect(decision.reason).not.toContain("SDK timeout");
  });

  it("falls back to single on schema violation (missing field)", async () => {
    runClaudeImpl = async () => ({
      conclusion: "success",
      structuredOutput: JSON.stringify({ decision: "multi" }),
    });
    const { runTriageAgent } = await import("../../../src/modes/review/triage");

    const decision = await runTriageAgent({
      context: makeContext(),
      githubContextMarkdown: "pr-context",
      promptFilePath: PROMPT_FILE_PATH,
    });

    expect(decision.decision).toBe("single");
    expect(decision.reason).toBe("triage unavailable, see logs");
  });

  it("falls back to single on invalid JSON output", async () => {
    runClaudeImpl = async () => ({
      conclusion: "success",
      structuredOutput: "not-json-at-all",
    });
    const { runTriageAgent } = await import("../../../src/modes/review/triage");

    const decision = await runTriageAgent({
      context: makeContext(),
      githubContextMarkdown: "pr-context",
      promptFilePath: PROMPT_FILE_PATH,
    });

    expect(decision.decision).toBe("single");
    expect(decision.reason).toBe("triage unavailable, see logs");
  });
});

describe("formatTriageLine", () => {
  it("produces a single-line audit trail with the routing glyph", async () => {
    const { formatTriageLine } = await import(
      "../../../src/modes/review/triage"
    );
    const line = formatTriageLine({
      decision: "multi",
      reason: "touches src/auth and adds SQL migration",
    });
    expect(line).toBe(
      "🔀 Triage: multi — touches src/auth and adds SQL migration",
    );
    expect(line.includes("\n")).toBe(false);
  });

  it("collapses whitespace in reason", async () => {
    const { formatTriageLine } = await import(
      "../../../src/modes/review/triage"
    );
    const line = formatTriageLine({
      decision: "single",
      reason: "docs\nonly  change\twith  tabs",
    });
    expect(line).toBe("🔀 Triage: single — docs only change with tabs");
  });

  it("caps reason at 500 chars", async () => {
    const { formatTriageLine } = await import(
      "../../../src/modes/review/triage"
    );
    const longReason = "a".repeat(600);
    const line = formatTriageLine({ decision: "single", reason: longReason });
    // "🔀 Triage: single — " is 20 visible chars of prefix (emoji counted as 1 here)
    expect(line.length).toBeLessThanOrEqual(600);
    expect(line).not.toContain("a".repeat(501));
  });
});
