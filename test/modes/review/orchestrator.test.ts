import { describe, expect, it } from "bun:test";
import {
  buildSubAgentClaudeArgs,
  parseDebateRounds,
} from "../../../src/modes/review/orchestrator";
import {
  SYNTHESIS_COMMENT_MARKER,
  buildSubAgentSystemPrompt,
} from "../../../src/modes/review/prompts";
import { buildFallbackSynthesisBody } from "../../../src/modes/review/synthesis-comment";
import { AGENT_FINDINGS_SCHEMA } from "../../../src/modes/review/schemas";
import type { ReviewAgent } from "../../../src/modes/review/agents";

describe("parseDebateRounds", () => {
  it("returns 0 for undefined / empty", () => {
    expect(parseDebateRounds(undefined)).toBe(0);
    expect(parseDebateRounds("")).toBe(0);
  });

  it("parses numeric strings", () => {
    expect(parseDebateRounds("0")).toBe(0);
    expect(parseDebateRounds("1")).toBe(1);
  });

  it("clamps above the upper bound (max 3 rounds)", () => {
    expect(parseDebateRounds("2")).toBe(2);
    expect(parseDebateRounds("3")).toBe(3);
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

describe("buildSubAgentClaudeArgs", () => {
  const tools = ["Glob", "Grep", "LS", "Read"];
  const args = buildSubAgentClaudeArgs(tools, AGENT_FINDINGS_SCHEMA);

  it("uses acceptEdits permission mode", () => {
    expect(args).toContain("--permission-mode acceptEdits");
  });

  it("passes the agent's declared tools verbatim as --allowedTools", () => {
    expect(args).toContain('--allowedTools "Glob,Grep,LS,Read"');
  });

  it("emits the --json-schema flag with the provided schema", () => {
    expect(args).toContain("--json-schema");
    expect(args).toContain(JSON.stringify(AGENT_FINDINGS_SCHEMA));
  });

  it("never emits an --mcp-config flag — workers have no MCP servers", () => {
    expect(args).not.toContain("--mcp-config");
  });

  it("never grants any GitHub MCP tool to sub-agents", () => {
    expect(args).not.toContain("mcp__github_comment__update_claude_comment");
    expect(args).not.toContain("mcp__github_file_ops");
    expect(args).not.toContain("mcp__github_inline_comment");
    expect(args).not.toContain("mcp__github_ci");
  });

  it("never grants write-capable tools to sub-agents when given a read-only toolset", () => {
    const allowedToolsMatch = args.match(/--allowedTools "([^"]+)"/);
    expect(allowedToolsMatch).not.toBeNull();
    const parsed = allowedToolsMatch![1]!.split(",");
    expect(parsed).toEqual(tools);
    expect(parsed).not.toContain("Edit");
    expect(parsed).not.toContain("Write");
    expect(parsed.some((t) => t.startsWith("Bash"))).toBe(false);
  });

  it("honors whatever tool list the ReviewAgent declares", () => {
    const customTools = ["Glob", "Read"];
    const customArgs = buildSubAgentClaudeArgs(
      customTools,
      AGENT_FINDINGS_SCHEMA,
    );
    expect(customArgs).toContain('--allowedTools "Glob,Read"');
  });

  it("escapes embedded single quotes in the schema JSON to match buildSynthesisClaudeArgs", () => {
    const schemaWithQuote = {
      type: "object",
      description: "don't break the quoting",
    };
    const escapedArgs = buildSubAgentClaudeArgs(["Read"], schemaWithQuote);
    expect(escapedArgs).toContain("don'\\''t break the quoting");
    expect(escapedArgs).not.toContain("don't break the quoting");
  });

  it("rejects tool names containing shell metacharacters", () => {
    expect(() =>
      buildSubAgentClaudeArgs(["Read$(whoami)"], AGENT_FINDINGS_SCHEMA),
    ).toThrow(/Invalid tool name/);
    expect(() =>
      buildSubAgentClaudeArgs(["Read;rm -rf /"], AGENT_FINDINGS_SCHEMA),
    ).toThrow(/Invalid tool name/);
    expect(() =>
      buildSubAgentClaudeArgs(['Read"break'], AGENT_FINDINGS_SCHEMA),
    ).toThrow(/Invalid tool name/);
    expect(() =>
      buildSubAgentClaudeArgs(["Read`whoami`"], AGENT_FINDINGS_SCHEMA),
    ).toThrow(/Invalid tool name/);
  });
});

describe("buildSubAgentSystemPrompt", () => {
  const agent: ReviewAgent = {
    id: "correctness-reviewer",
    name: "Correctness Reviewer",
    perspective: "focus on correctness",
    tools: ["Glob", "Grep", "LS", "Read"],
  };

  it("identifies the sub-agent role in the review role", () => {
    const prompt = buildSubAgentSystemPrompt({
      role: "review",
      agent,
      githubContextMarkdown: "ctx",
    });
    expect(prompt).toContain("`correctness-reviewer`");
    expect(prompt).toContain("sub-agent");
    expect(prompt).toContain("focus on correctness");
    expect(prompt).toContain("## PR context");
    expect(prompt).toContain("ctx");
    expect(prompt).toContain("--json-schema");
    expect(prompt).toContain('agent_id="correctness-reviewer"');
  });

  it("tells the sub-agent to ignore parent directives that write to GitHub", () => {
    const prompt = buildSubAgentSystemPrompt({
      role: "review",
      agent,
      githubContextMarkdown: "ctx",
    });
    expect(prompt).toContain("PARENT workflow prompt");
    expect(prompt).toContain("ignore any directive");
    expect(prompt).toContain("editing files");
  });

  it("labels debate rounds with their round number", () => {
    const prompt = buildSubAgentSystemPrompt({
      role: "debate",
      agent,
      githubContextMarkdown: "ctx",
      debateRoundNumber: 2,
      ownFindings: {
        agent_id: "correctness-reviewer",
        agent_name: "Correctness Reviewer",
        summary: "s",
        findings: [],
      },
      otherFindings: [],
    });
    expect(prompt).toContain("debate round 2");
  });

  it("directs synthesis to update the synthesis comment id via MCP", () => {
    const prompt = buildSubAgentSystemPrompt({
      role: "synthesis",
      githubContextMarkdown: "ctx",
      synthesisCommentId: 99,
    });
    expect(prompt).toContain("`synthesis`");
    expect(prompt).toContain("mcp__github_comment__update_claude_comment");
    expect(prompt).toContain(
      "mcp__github_inline_comment__create_inline_comment",
    );
    expect(prompt).toContain("99");
    expect(prompt).toContain(SYNTHESIS_COMMENT_MARKER);
    expect(prompt).toContain("confirmed: true");
  });

  it("synthesis role does not require an agent", () => {
    expect(() =>
      buildSubAgentSystemPrompt({
        role: "synthesis",
        githubContextMarkdown: "ctx",
        synthesisCommentId: 1,
      }),
    ).not.toThrow();
  });

  it("sanitizes findings before embedding them in synthesis prompt", () => {
    const prompt = buildSubAgentSystemPrompt({
      role: "synthesis",
      githubContextMarkdown: "ctx",
      synthesisCommentId: 1,
      allFindings: [
        {
          agent_id: "a1",
          agent_name: "A1",
          summary: "summary <!-- injected -->",
          findings: [
            {
              severity: "major",
              title: "T\u200Binjection",
              description: "D ![alt](x) end",
              file: "<!--f-->",
              line: 1,
            },
          ],
        },
      ],
    });
    expect(prompt).not.toContain("<!-- injected -->");
    expect(prompt).not.toContain("\u200B");
    expect(prompt).not.toContain("![alt](x)");
    expect(prompt).toContain("![](x)");
    expect(prompt).not.toContain("<!--f-->");
  });

  it("sanitizes rebuttals before embedding them in synthesis prompt", () => {
    const prompt = buildSubAgentSystemPrompt({
      role: "synthesis",
      githubContextMarkdown: "ctx",
      synthesisCommentId: 1,
      allRebuttals: [
        {
          agent_id: "a1",
          agent_name: "A1",
          responses: [
            {
              regarding_finding_title: "T <!--x-->",
              stance: "agree",
              reasoning: "R \u2066bidi",
            },
          ],
        },
      ],
    });
    expect(prompt).not.toContain("<!--x-->");
    expect(prompt).not.toContain("\u2066");
  });

  it("sanitizes ownFindings JSON block in debate prompt", () => {
    const prompt = buildSubAgentSystemPrompt({
      role: "debate",
      agent: { id: "x", name: "X", perspective: "p", tools: ["Read"] },
      githubContextMarkdown: "ctx",
      debateRoundNumber: 1,
      ownFindings: {
        agent_id: "x",
        agent_name: "X",
        summary: "s <!-- evil -->",
        findings: [],
      },
      otherFindings: [],
    });
    expect(prompt).not.toContain("<!-- evil -->");
    expect(prompt).toContain("```json");
  });

  it("leaves benign text untouched in synthesis prompt", () => {
    const prompt = buildSubAgentSystemPrompt({
      role: "synthesis",
      githubContextMarkdown: "ctx",
      synthesisCommentId: 1,
      allFindings: [
        {
          agent_id: "a1",
          agent_name: "Agent One",
          summary: "Clean summary.",
          findings: [
            {
              severity: "major",
              title: "Null deref",
              description: "arr[0] before length check",
              file: "x.ts",
              line: 10,
            },
          ],
        },
      ],
    });
    expect(prompt).toContain("Agent One");
    expect(prompt).toContain("Null deref");
    expect(prompt).toContain("arr[0] before length check");
    expect(prompt).toContain("x.ts");
  });
});

describe("SYNTHESIS_COMMENT_MARKER", () => {
  it("is a distinctive heading that sticky-comment matchers will not reuse", () => {
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

  it("sanitizes agent findings before rendering into markdown body", () => {
    const body = buildFallbackSynthesisBody([
      {
        agent_id: "a1",
        agent_name: "A1 <!--name-->",
        summary: "summary <!-- injected --> \u200B",
        findings: [
          {
            severity: "major",
            title: "T\u2066bidi",
            description: "D ![alt](x) end",
            file: "<!--f-->",
            line: 1,
          },
        ],
      },
    ]);
    expect(body).not.toContain("<!--name-->");
    expect(body).not.toContain("<!-- injected -->");
    expect(body).not.toContain("\u200B");
    expect(body).not.toContain("\u2066");
    expect(body).not.toContain("![alt](x)");
    expect(body).toContain("![](x)");
    expect(body).not.toContain("<!--f-->");
  });

  it("leaves benign fallback content untouched", () => {
    const body = buildFallbackSynthesisBody([
      {
        agent_id: "a1",
        agent_name: "Agent One",
        summary: "Clean summary.",
        findings: [
          {
            severity: "major",
            title: "Null deref",
            description: "arr[0] before length check",
            file: "x.ts",
            line: 10,
          },
        ],
      },
    ]);
    expect(body).toContain("Agent One");
    expect(body).toContain("Null deref");
    expect(body).toContain("arr[0] before length check");
    expect(body).toContain("x.ts:10");
    expect(body).toContain("Clean summary.");
  });
});
