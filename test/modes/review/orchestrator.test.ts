import { describe, expect, it } from "bun:test";
import {
  buildWorkerClaudeArgs,
  parseDebateRounds,
} from "../../../src/modes/review/orchestrator";
import { SYNTHESIS_COMMENT_MARKER } from "../../../src/modes/review/prompts";
import { buildFallbackSynthesisBody } from "../../../src/modes/review/synthesis-comment";

describe("parseDebateRounds", () => {
  it("returns 0 for undefined / empty", () => {
    expect(parseDebateRounds(undefined)).toBe(0);
    expect(parseDebateRounds("")).toBe(0);
  });

  it("parses numeric strings", () => {
    expect(parseDebateRounds("0")).toBe(0);
    expect(parseDebateRounds("1")).toBe(1);
    expect(parseDebateRounds("2")).toBe(2);
    expect(parseDebateRounds("3")).toBe(3);
  });

  it("clamps above the upper bound", () => {
    expect(parseDebateRounds("4")).toBe(3);
    expect(parseDebateRounds("100")).toBe(3);
  });

  it("clamps below the lower bound", () => {
    expect(parseDebateRounds("-1")).toBe(0);
    expect(parseDebateRounds("-999")).toBe(0);
  });

  it("treats non-numeric input as 0", () => {
    expect(parseDebateRounds("not-a-number")).toBe(0);
    expect(parseDebateRounds("NaN")).toBe(0);
  });
});

describe("buildWorkerClaudeArgs", () => {
  const args = buildWorkerClaudeArgs();

  it("uses acceptEdits permission mode", () => {
    expect(args).toContain("--permission-mode acceptEdits");
  });

  it("allows only the four read-only tools", () => {
    expect(args).toContain('--allowedTools "Glob,Grep,LS,Read"');
  });

  it("contains a JSON schema flag", () => {
    expect(args).toContain("--json-schema");
  });

  it("never grants any GitHub MCP tool to workers", () => {
    expect(args).not.toContain("mcp__github_comment__update_claude_comment");
    expect(args).not.toContain("mcp__github_file_ops");
    expect(args).not.toContain("mcp__github_inline_comment");
    expect(args).not.toContain("mcp__github_ci");
  });

  it("never grants write-capable tools to workers", () => {
    const allowedToolsMatch = args.match(/--allowedTools "([^"]+)"/);
    expect(allowedToolsMatch).not.toBeNull();
    const tools = allowedToolsMatch![1]!.split(",");
    expect(tools).toEqual(["Glob", "Grep", "LS", "Read"]);
    expect(tools).not.toContain("Edit");
    expect(tools).not.toContain("Write");
    expect(tools.some((t) => t.startsWith("Bash"))).toBe(false);
  });
});

describe("SYNTHESIS_COMMENT_MARKER", () => {
  it("is a distinctive heading that sticky-comment matchers will not reuse", () => {
    // The sticky-comment matcher in create-initial.ts matches on exact body
    // equality against the tag-mode template. The synthesis marker must be
    // different from any phrase the tag template produces.
    expect(SYNTHESIS_COMMENT_MARKER).toBe("## Multi-agent review");
    expect(SYNTHESIS_COMMENT_MARKER.startsWith("#")).toBe(true);
  });
});

describe("buildFallbackSynthesisBody", () => {
  it("includes each agent's summary and findings", () => {
    const body = buildFallbackSynthesisBody(
      [
        {
          agent_id: "a1",
          agent_name: "Agent One",
          summary: "Saw nothing concerning",
          findings: [],
        },
        {
          agent_id: "a2",
          agent_name: "Agent Two",
          summary: "Found an issue",
          findings: [
            {
              severity: "major",
              title: "Null deref",
              description: "arr[0] before length",
              file: "x.ts",
              line: 10,
            },
          ],
        },
      ],
      "synthesis-crashed",
    );

    expect(body).toContain("Agent One");
    expect(body).toContain("Agent Two");
    expect(body).toContain("Saw nothing concerning");
    expect(body).toContain("Found an issue");
    expect(body).toContain("Null deref");
    expect(body).toContain("x.ts:10");
    expect(body).toContain("synthesis-crashed");
  });

  it("omits the failure banner when no reason is given", () => {
    const body = buildFallbackSynthesisBody([
      {
        agent_id: "a1",
        agent_name: "Agent One",
        summary: "fine",
        findings: [],
      },
    ]);
    expect(body).not.toContain("Synthesis agent failed");
  });
});
