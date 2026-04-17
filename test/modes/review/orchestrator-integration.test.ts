/**
 * Integration tests for `runMultiAgentReview`.
 *
 * These mock `runClaude` and module-level side-effecting helpers
 * (`fetchGitHubData`, `prepareMcpConfig`, prompt writers) so we can verify
 * the orchestration flow without hitting disk, the network, or the CLI.
 *
 * Covered scenarios:
 *   1. Happy path: R1 succeeds for all agents, synthesis succeeds.
 *   2. All R1 agents fail -> conclusion "failure", synthesis comment updated.
 *   3. Synthesis throws -> fallback body published with raw findings.
 *   4. Worker `runClaude` is never given GitHub MCP tools (byte-level).
 *   5. `prepareResult.commentId` (tag-mode tracking comment) is never
 *      referenced by the orchestrator — invariant #1 in orchestrator.ts.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Octokits } from "../../../src/github/api/client";
import type { ParsedGitHubContext } from "../../../src/github/context";

type MockRunClaudeCall = {
  promptPath: string;
  options: {
    claudeArgs?: string;
    appendSystemPrompt?: string;
    executionFilePath?: string;
  };
};

const TAG_TRACKING_COMMENT_ID = 111_111_111;
const SYNTHESIS_COMMENT_ID = 222_222_222;

function makeContext(
  overrides: Partial<ParsedGitHubContext["inputs"]> = {},
): ParsedGitHubContext {
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
      multiAgentReview: "true",
      reviewDebateRounds: "0",
      ...overrides,
    },
  };
}

function makeOctokit(): {
  octokit: Octokits;
  createCalls: Array<{ body: string }>;
  updateCalls: Array<{ comment_id: number; body: string }>;
} {
  const createCalls: Array<{ body: string }> = [];
  const updateCalls: Array<{ comment_id: number; body: string }> = [];
  const octokit = {
    rest: {
      issues: {
        createComment: async (args: any) => {
          createCalls.push({ body: args.body });
          return { data: { id: SYNTHESIS_COMMENT_ID } };
        },
        updateComment: async (args: any) => {
          updateCalls.push({ comment_id: args.comment_id, body: args.body });
          return { data: { id: args.comment_id } };
        },
      },
    },
  } as unknown as Octokits;
  return { octokit, createCalls, updateCalls };
}

const PREPARE_RESULT = {
  commentId: TAG_TRACKING_COMMENT_ID,
  branchInfo: {
    claudeBranch: "claude/review",
    baseBranch: "main",
    currentBranch: "feat/x",
  },
  mcpConfig: "{}",
  claudeArgs: "--permission-mode acceptEdits",
};

let runClaudeCalls: MockRunClaudeCall[] = [];
let runClaudeImpl: (
  promptPath: string,
  options: any,
) => Promise<any> = async () => ({ conclusion: "success" });

beforeEach(() => {
  runClaudeCalls = [];
  runClaudeImpl = async () => ({ conclusion: "success" });

  mock.module("../../../base-action/src/run-claude", () => ({
    runClaude: async (promptPath: string, options: any) => {
      runClaudeCalls.push({ promptPath, options });
      return runClaudeImpl(promptPath, options);
    },
  }));

  mock.module("../../../src/github/data/fetcher", () => ({
    fetchGitHubData: async () => ({
      contextData: { body: "pr body" },
      comments: [],
      changedFilesWithSHA: [],
      reviewData: [],
      imageUrlMap: new Map(),
    }),
    extractTriggerTimestamp: () => "2026-04-17T00:00:00Z",
    extractOriginalTitle: () => "title",
    extractOriginalBody: () => "body",
  }));

  mock.module("../../../src/github/data/formatter", () => ({
    formatContext: () => "ctx",
    formatBody: () => "body",
    formatChangedFilesWithSHA: () => "files",
    formatComments: () => "comments",
    formatReviewComments: () => "reviews",
  }));

  mock.module("../../../src/mcp/install-mcp-server", () => ({
    prepareMcpConfig: async () => '{"mcpServers":{}}',
  }));

  mock.module("../../../src/modes/review/prompts", () => ({
    SYNTHESIS_COMMENT_MARKER: "## Multi-agent review",
    buildGitHubContextMarkdown: () => "markdown",
    writeAgentPrompt: async ({ agent }: { agent: { id: string } }) =>
      `/tmp/prompt-r1-${agent.id}.txt`,
    writeDebatePrompt: async ({ agent }: { agent: { id: string } }) =>
      `/tmp/prompt-r2-${agent.id}.txt`,
    writeSynthesisPrompt: async () => "/tmp/prompt-synthesis.txt",
  }));
});

afterEach(() => {
  mock.restore();
});

describe("runMultiAgentReview", () => {
  it("happy path: runs 3 agents in R1 + synthesis, updates synthesis comment id only", async () => {
    runClaudeImpl = async (_promptPath, options) => {
      if (options.executionFilePath?.includes("synthesis")) {
        return {
          conclusion: "success",
          executionFile: options.executionFilePath,
          sessionId: "synthesis-session",
        };
      }
      // R1 agents — return structured findings
      return {
        conclusion: "success",
        structuredOutput: JSON.stringify({
          agent_id: inferAgentIdFromExecPath(options.executionFilePath),
          agent_name: "Agent",
          summary: "ok",
          findings: [],
        }),
      };
    };

    const { octokit, createCalls, updateCalls } = makeOctokit();
    const { runMultiAgentReview } = await import(
      "../../../src/modes/review/orchestrator"
    );
    const result = await runMultiAgentReview({
      context: makeContext(),
      octokit,
      githubToken: "token",
      prepareResult: PREPARE_RESULT,
    });

    expect(result.conclusion).toBe("success");
    expect(runClaudeCalls).toHaveLength(4); // 3 R1 + 1 synthesis
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]!.body.startsWith("## Multi-agent review")).toBe(true);
    // No updateComment on happy path — synthesis agent updates via MCP.
    expect(updateCalls).toHaveLength(0);
  });

  it("all R1 agents fail -> returns failure and updates synthesis comment", async () => {
    runClaudeImpl = async () => {
      throw new Error("worker crashed");
    };

    const { octokit, updateCalls } = makeOctokit();
    const { runMultiAgentReview } = await import(
      "../../../src/modes/review/orchestrator"
    );
    const result = await runMultiAgentReview({
      context: makeContext(),
      octokit,
      githubToken: "token",
      prepareResult: PREPARE_RESULT,
    });

    expect(result.conclusion).toBe("failure");
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.comment_id).toBe(SYNTHESIS_COMMENT_ID);
    expect(updateCalls[0]!.comment_id).not.toBe(TAG_TRACKING_COMMENT_ID);
    expect(updateCalls[0]!.body).toContain("## Multi-agent review");
    expect(updateCalls[0]!.body).toContain("worker crashed");
  });

  it("synthesis throws -> publishes raw findings as fallback body", async () => {
    runClaudeImpl = async (_promptPath, options) => {
      if (options.executionFilePath?.includes("synthesis")) {
        throw new Error("synthesis crashed");
      }
      return {
        conclusion: "success",
        structuredOutput: JSON.stringify({
          agent_id: inferAgentIdFromExecPath(options.executionFilePath),
          agent_name: "Agent",
          summary: "found stuff",
          findings: [
            {
              severity: "major",
              title: "Bad pattern",
              description: "unsafe",
              file: "x.ts",
              line: 5,
            },
          ],
        }),
      };
    };

    const { octokit, updateCalls } = makeOctokit();
    const { runMultiAgentReview } = await import(
      "../../../src/modes/review/orchestrator"
    );
    const result = await runMultiAgentReview({
      context: makeContext(),
      octokit,
      githubToken: "token",
      prepareResult: PREPARE_RESULT,
    });

    expect(result.conclusion).toBe("failure");
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.comment_id).toBe(SYNTHESIS_COMMENT_ID);
    expect(updateCalls[0]!.body).toContain("Synthesis agent failed");
    expect(updateCalls[0]!.body).toContain("synthesis crashed");
    expect(updateCalls[0]!.body).toContain("Bad pattern");
    expect(updateCalls[0]!.body).toContain("x.ts:5");
  });

  it("worker claudeArgs never include github MCP tools or write permissions", async () => {
    runClaudeImpl = async (_promptPath, options) => {
      if (options.executionFilePath?.includes("synthesis")) {
        return { conclusion: "success" };
      }
      return {
        conclusion: "success",
        structuredOutput: JSON.stringify({
          agent_id: inferAgentIdFromExecPath(options.executionFilePath),
          agent_name: "Agent",
          summary: "ok",
          findings: [],
        }),
      };
    };

    const { octokit } = makeOctokit();
    const { runMultiAgentReview } = await import(
      "../../../src/modes/review/orchestrator"
    );
    await runMultiAgentReview({
      context: makeContext(),
      octokit,
      githubToken: "token",
      prepareResult: PREPARE_RESULT,
    });

    const workerCalls = runClaudeCalls.filter(
      (c) => !c.options.executionFilePath?.includes("synthesis"),
    );
    expect(workerCalls.length).toBe(3);
    for (const call of workerCalls) {
      const args = call.options.claudeArgs ?? "";
      expect(args).not.toContain("mcp__github_comment");
      expect(args).not.toContain("mcp__github_file_ops");
      expect(args).not.toContain("mcp__github_inline_comment");
      expect(args).not.toContain("mcp__github_ci");
      expect(args).not.toContain("--mcp-config");
      expect(args).toContain('--allowedTools "Glob,Grep,LS,Read"');
    }
  });

  it("never reads prepareResult.commentId (tag-mode tracking comment invariant)", async () => {
    // Build a prepareResult whose commentId access would throw, to prove
    // the orchestrator only touches branchInfo, mcpConfig, claudeArgs.
    const trapPrepareResult = {
      ...PREPARE_RESULT,
      get commentId(): number {
        throw new Error(
          "INVARIANT VIOLATED: orchestrator read prepareResult.commentId",
        );
      },
    };

    runClaudeImpl = async (_promptPath, options) => {
      if (options.executionFilePath?.includes("synthesis")) {
        return { conclusion: "success" };
      }
      return {
        conclusion: "success",
        structuredOutput: JSON.stringify({
          agent_id: inferAgentIdFromExecPath(options.executionFilePath),
          agent_name: "Agent",
          summary: "ok",
          findings: [],
        }),
      };
    };

    const { octokit } = makeOctokit();
    const { runMultiAgentReview } = await import(
      "../../../src/modes/review/orchestrator"
    );
    await expect(
      runMultiAgentReview({
        context: makeContext(),
        octokit,
        githubToken: "token",
        prepareResult: trapPrepareResult as typeof PREPARE_RESULT,
      }),
    ).resolves.toBeDefined();
  });

  it("runs debate round when reviewDebateRounds=1", async () => {
    runClaudeImpl = async (_promptPath, options) => {
      if (options.executionFilePath?.includes("synthesis")) {
        return { conclusion: "success" };
      }
      if (options.executionFilePath?.includes("r2-")) {
        return {
          conclusion: "success",
          structuredOutput: JSON.stringify({
            agent_id: inferAgentIdFromExecPath(options.executionFilePath),
            agent_name: "Agent",
            responses: [
              {
                regarding_finding_title: "X",
                stance: "agree",
                reasoning: "because",
              },
            ],
          }),
        };
      }
      return {
        conclusion: "success",
        structuredOutput: JSON.stringify({
          agent_id: inferAgentIdFromExecPath(options.executionFilePath),
          agent_name: "Agent",
          summary: "ok",
          findings: [
            {
              severity: "minor",
              title: "X",
              description: "x",
            },
          ],
        }),
      };
    };

    const { octokit } = makeOctokit();
    const { runMultiAgentReview } = await import(
      "../../../src/modes/review/orchestrator"
    );
    await runMultiAgentReview({
      context: makeContext({ reviewDebateRounds: "1" }),
      octokit,
      githubToken: "token",
      prepareResult: PREPARE_RESULT,
    });
    // 3 R1 + 3 R2 + 1 synthesis
    expect(runClaudeCalls).toHaveLength(7);
  });
});

function inferAgentIdFromExecPath(execPath?: string): string {
  if (!execPath) return "unknown";
  const match = execPath.match(/r[12]-([a-z-]+)\.json/);
  return match?.[1] ?? "unknown";
}
