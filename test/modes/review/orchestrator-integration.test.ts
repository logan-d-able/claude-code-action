/**
 * Integration tests for `runMultiAgentReview`.
 *
 * These mock `runClaude` and module-level side-effecting helpers
 * (`prepareMcpConfig`, `fetchPullRequestPatches`) so we can verify the
 * orchestration flow without hitting disk, the network, or the CLI.
 *
 * Covered scenarios:
 *   1. Happy path: R1 succeeds for all agents, synthesis succeeds.
 *   2. All R1 agents fail -> conclusion "failure", synthesis comment updated.
 *   3. Synthesis throws -> fallback body published with raw findings.
 *   4. Worker `runClaude` is never given GitHub MCP tools (byte-level).
 *   5. `prepareResult.commentId` (tag-mode tracking comment) is never
 *      referenced by the orchestrator — invariant #1 in orchestrator.ts.
 *   6. Synthesis claudeArgs rebinds MCP comment id to synthesis id.
 *   7. `fetchGitHubData` is never called from orchestrator (data reused from
 *      `prepareResult.githubData`).
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
const PROMPT_FILE_PATH = "/tmp/claude-prompts/claude-prompt.txt";

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
  listFilesCalls: Array<Record<string, unknown>>;
} {
  const createCalls: Array<{ body: string }> = [];
  const updateCalls: Array<{ comment_id: number; body: string }> = [];
  const listFilesCalls: Array<Record<string, unknown>> = [];
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
      pulls: {
        listFiles: async (args: any) => {
          listFilesCalls.push(args);
          return { data: [] };
        },
      },
    },
  } as unknown as Octokits;
  return { octokit, createCalls, updateCalls, listFilesCalls };
}

const PREPARE_RESULT = {
  commentId: TAG_TRACKING_COMMENT_ID,
  branchInfo: {
    claudeBranch: "claude/review",
    baseBranch: "main",
    currentBranch: "feat/x",
  },
  promptFilePath: PROMPT_FILE_PATH,
  mcpConfig: "{}",
  claudeArgs: "--permission-mode acceptEdits",
  githubData: {
    contextData: { body: "pr body", title: "title" } as any,
    comments: [],
    changedFiles: [],
    changedFilesWithSHA: [],
    reviewData: null,
    imageUrlMap: new Map(),
  },
};

let runClaudeCalls: MockRunClaudeCall[] = [];
let runClaudeImpl: (
  promptPath: string,
  options: any,
) => Promise<any> = async () => ({ conclusion: "success" });
let fetchGitHubDataCalled = 0;
let prepareMcpConfigCalls: Array<Record<string, unknown>> = [];

beforeEach(() => {
  runClaudeCalls = [];
  fetchGitHubDataCalled = 0;
  prepareMcpConfigCalls = [];
  runClaudeImpl = async () => ({ conclusion: "success" });

  mock.module("../../../base-action/src/run-claude", () => ({
    runClaude: async (promptPath: string, options: any) => {
      runClaudeCalls.push({ promptPath, options });
      return runClaudeImpl(promptPath, options);
    },
  }));

  mock.module("../../../src/github/data/fetcher", () => ({
    fetchGitHubData: async () => {
      fetchGitHubDataCalled++;
      throw new Error(
        "INVARIANT: fetchGitHubData must not be called from the review orchestrator",
      );
    },
    fetchPullRequestPatches: async () => new Map<string, string | undefined>(),
    extractTriggerTimestamp: () => "2026-04-17T00:00:00Z",
    extractOriginalTitle: () => "title",
    extractOriginalBody: () => "body",
  }));

  mock.module("../../../src/github/data/formatter", () => ({
    formatContext: () => "ctx",
    formatBody: () => "pr-body",
    formatChangedFileDiffs: () => "diffs",
    formatChangedFilesWithSHA: () => "files",
    formatComments: () => "comments",
    formatReviewComments: () => "reviews",
  }));

  mock.module("../../../src/mcp/install-mcp-server", () => ({
    prepareMcpConfig: async (params: Record<string, unknown>) => {
      prepareMcpConfigCalls.push(params);
      return JSON.stringify({
        mcpServers: {
          github_comment: {
            env: { CLAUDE_COMMENT_ID: String(params.claudeCommentId) },
          },
        },
      });
    },
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

  it("worker claudeArgs never include github MCP tools, --mcp-config, or write permissions", async () => {
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

  it("worker promptPath equals prepareResult.promptFilePath (base prompt reused)", async () => {
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

    for (const call of runClaudeCalls) {
      expect(call.promptPath).toBe(PROMPT_FILE_PATH);
    }
  });

  it("worker appendSystemPrompt identifies the sub-agent role and ignores parent write directives", async () => {
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
    for (const call of workerCalls) {
      const appendSystemPrompt = call.options.appendSystemPrompt ?? "";
      expect(appendSystemPrompt).toContain("sub-agent");
      expect(appendSystemPrompt).toContain("PARENT workflow prompt");
      expect(appendSystemPrompt).toContain("ignore any directive");
    }
  });

  it("synthesis claudeArgs rebind MCP comment id to synthesis id, not tag tracking id", async () => {
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

    const synthesisCall = runClaudeCalls.find((c) =>
      c.options.executionFilePath?.includes("synthesis"),
    );
    expect(synthesisCall).toBeDefined();
    const args = synthesisCall!.options.claudeArgs ?? "";
    // Synthesis must still have the comment-update and inline-comment MCP tools.
    expect(args).toContain("mcp__github_comment__update_claude_comment");
    // The MCP config the synthesis agent receives must carry the synthesis
    // comment id, NOT the tag-mode tracking comment id.
    expect(args).toContain(String(SYNTHESIS_COMMENT_ID));
    expect(args).not.toContain(String(TAG_TRACKING_COMMENT_ID));

    // And prepareMcpConfig must have been called with synthesis id for the
    // synthesis build.
    const synthesisPrepareCall = prepareMcpConfigCalls.find(
      (p) => p.claudeCommentId === String(SYNTHESIS_COMMENT_ID),
    );
    expect(synthesisPrepareCall).toBeDefined();
  });

  it("synthesis claudeArgs never include git CLI, file_ops, CI tools, or user CLAUDE_ARGS", async () => {
    // Prompt-injection defense: worker findings are threaded into synthesis's
    // appendSystemPrompt verbatim. If synthesis inherited git write tools,
    // malicious PR content could coerce arbitrary commits. Enforce at the
    // tool-allowlist level.
    const originalClaudeArgs = process.env.CLAUDE_ARGS;
    process.env.CLAUDE_ARGS = '--model "claude-opus-4-7"';
    try {
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

      const synthesisCall = runClaudeCalls.find((c) =>
        c.options.executionFilePath?.includes("synthesis"),
      );
      expect(synthesisCall).toBeDefined();
      const args = synthesisCall!.options.claudeArgs ?? "";

      // No git CLI — synthesis must never be able to stage, commit, or push.
      expect(args).not.toContain("Bash(git add");
      expect(args).not.toContain("Bash(git commit");
      expect(args).not.toContain("Bash(git rm");
      expect(args).not.toContain("git-push.sh");
      // No file-ops MCP — blocks the API-signing commit path too.
      expect(args).not.toContain("mcp__github_file_ops");
      // CI introspection tools aren't relevant to synthesis; keep surface small.
      expect(args).not.toContain("mcp__github_ci__");
      // User's CLAUDE_ARGS must not be appended — synthesis is an internal
      // sub-agent, not a user-facing Claude invocation.
      expect(args).not.toContain('--model "claude-opus-4-7"');

      // Verify the allowlist is exactly the synthesis minimum (6 tools).
      const match = args.match(/--allowedTools "([^"]+)"/);
      expect(match).not.toBeNull();
      const tools = match![1]!.split(",").sort();
      expect(tools).toEqual(
        [
          "Glob",
          "Grep",
          "LS",
          "Read",
          "mcp__github_comment__update_claude_comment",
          "mcp__github_inline_comment__create_inline_comment",
        ].sort(),
      );
    } finally {
      if (originalClaudeArgs === undefined) {
        delete process.env.CLAUDE_ARGS;
      } else {
        process.env.CLAUDE_ARGS = originalClaudeArgs;
      }
    }
  });

  it("never reads prepareResult.commentId (tag-mode tracking comment invariant)", async () => {
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

  it("never calls fetchGitHubData from orchestrator (reuses prepareResult.githubData)", async () => {
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

    expect(fetchGitHubDataCalled).toBe(0);
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

  it("honors reviewDebateRounds values above 1 and threads prior rebuttals", async () => {
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
      context: makeContext({ reviewDebateRounds: "3" }),
      octokit,
      githubToken: "token",
      prepareResult: PREPARE_RESULT,
    });

    expect(runClaudeCalls).toHaveLength(13); // 3 R1 + 9 R2 + 1 synthesis
    const r2Calls = runClaudeCalls.filter((c) =>
      c.options.executionFilePath?.includes("r2-"),
    );
    expect(r2Calls).toHaveLength(9);
    // Each debate-round/agent pair must have a unique executionFilePath so
    // later rounds don't silently overwrite earlier ones' audit trail.
    const r2Paths = r2Calls.map((c) => c.options.executionFilePath);
    expect(new Set(r2Paths).size).toBe(9);
    // Paths must embed the round number.
    expect(r2Paths.filter((p) => p?.includes("r2-1-")).length).toBe(3);
    expect(r2Paths.filter((p) => p?.includes("r2-2-")).length).toBe(3);
    expect(r2Paths.filter((p) => p?.includes("r2-3-")).length).toBe(3);
    // Third round's appendSystemPrompt should surface the "Prior debate
    // rounds" header, proving rebuttals thread through.
    const round3Calls = r2Calls.slice(6);
    for (const call of round3Calls) {
      expect(call.options.appendSystemPrompt).toContain("Prior debate rounds");
    }
  });
});

function inferAgentIdFromExecPath(execPath?: string): string {
  if (!execPath) return "unknown";
  // r1 paths: `...r1-<agent>.json`
  // r2 paths: `...r2-<round>-<agent>.json` (round number inserted to prevent
  // debate-round log overwrites — see orchestrator.ts)
  const match = execPath.match(/r[12]-(?:\d+-)?([a-z-]+)\.json/);
  return match?.[1] ?? "unknown";
}
