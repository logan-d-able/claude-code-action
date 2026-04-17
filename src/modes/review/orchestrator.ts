/**
 * Multi-agent PR review orchestrator.
 *
 * Invariants (enforced by callers + tests):
 *   1. `prepareTagMode` has already run and created the tracking comment.
 *      We never read or mutate `prepareResult.commentId` — it belongs to tag
 *      mode's finally-block update flow.
 *   2. Workers run with a pure read-only allowlist and no MCP servers.
 *   3. The synthesis comment body begins with `SYNTHESIS_COMMENT_MARKER` so
 *      sticky-comment reuse never targets it.
 */

import { runClaude } from "../../../base-action/src/run-claude";
import type { ClaudeRunResult } from "../../../base-action/src/run-claude-sdk";
import type { Octokits } from "../../github/api/client";
import type { ParsedGitHubContext } from "../../github/context";
import { isPullRequestEvent } from "../../github/context";
import {
  fetchGitHubData,
  extractTriggerTimestamp,
  extractOriginalTitle,
  extractOriginalBody,
} from "../../github/data/fetcher";
import {
  formatBody,
  formatChangedFilesWithSHA,
  formatComments,
  formatContext,
  formatReviewComments,
} from "../../github/data/formatter";
import { prepareMcpConfig } from "../../mcp/install-mcp-server";
import type { PrepareTagResult } from "../tag";
import { DEFAULT_REVIEW_AGENTS } from "./agents";
import type { ReviewAgent } from "./agents";
import {
  buildGitHubContextMarkdown,
  writeAgentPrompt,
  writeDebatePrompt,
  writeSynthesisPrompt,
} from "./prompts";
import {
  AGENT_FINDINGS_SCHEMA,
  AGENT_REBUTTAL_SCHEMA,
  validateStructuredOutput,
} from "./schemas";
import type { AgentFindings, AgentRebuttal } from "./schemas";
import {
  buildFallbackSynthesisBody,
  createSynthesisComment,
  updateSynthesisComment,
} from "./synthesis-comment";

export type RunMultiAgentReviewParams = {
  context: ParsedGitHubContext;
  octokit: Octokits;
  githubToken: string;
  prepareResult: PrepareTagResult;
};

const WORKER_ALLOWED_TOOLS = ["Glob", "Grep", "LS", "Read"] as const;

/**
 * Parse `reviewDebateRounds`, guarding against NaN and clamping to [0, 1].
 * Only one rebuttal round is currently meaningful: subsequent rounds would
 * re-debate the same Round 1 findings (the loop does not feed earlier
 * rebuttals back in), so they produce redundant output with no new signal.
 */
export function parseDebateRounds(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Build the `claudeArgs` string for a worker agent. No MCP servers — workers
 * are intentionally denied any tool that could edit files, post comments, or
 * touch git history.
 */
export function buildWorkerClaudeArgs(): string {
  return `--permission-mode acceptEdits --allowedTools "${WORKER_ALLOWED_TOOLS.join(",")}" --json-schema '${JSON.stringify(AGENT_FINDINGS_SCHEMA)}'`;
}

function buildDebateClaudeArgs(): string {
  return `--permission-mode acceptEdits --allowedTools "${WORKER_ALLOWED_TOOLS.join(",")}" --json-schema '${JSON.stringify(AGENT_REBUTTAL_SCHEMA)}'`;
}

async function buildSynthesisClaudeArgs(params: {
  githubToken: string;
  context: ParsedGitHubContext;
  synthesisCommentId: number;
  branchInfo: PrepareTagResult["branchInfo"];
}): Promise<string> {
  const { githubToken, context, synthesisCommentId, branchInfo } = params;

  const allowedTools = [
    "Glob",
    "Grep",
    "LS",
    "Read",
    "mcp__github_comment__update_claude_comment",
    "mcp__github_inline_comment__create_inline_comment",
  ];

  // Reuse prepareMcpConfig so the synthesis comment server is wired with the
  // synthesis comment id — NOT the tag-mode tracking comment id.
  const mcpConfig = await prepareMcpConfig({
    githubToken,
    owner: context.repository.owner,
    repo: context.repository.repo,
    branch: branchInfo.claudeBranch || branchInfo.currentBranch,
    baseBranch: branchInfo.baseBranch,
    claudeCommentId: synthesisCommentId.toString(),
    allowedTools,
    mode: "tag",
    context,
  });

  const escaped = mcpConfig.replace(/'/g, "'\\''");
  return `--mcp-config '${escaped}' --permission-mode acceptEdits --allowedTools "${allowedTools.join(",")}"`;
}

function executionFilePath(suffix: string): string {
  const base = process.env.RUNNER_TEMP ?? "/tmp";
  return `${base}/claude-execution-review-${suffix}.json`;
}

async function fetchAndFormatContext(params: {
  context: ParsedGitHubContext;
  octokit: Octokits;
}): Promise<string> {
  const { context, octokit } = params;
  const triggerTime = extractTriggerTimestamp(context);
  const originalTitle = extractOriginalTitle(context);
  const originalBody = extractOriginalBody(context);

  const data = await fetchGitHubData({
    octokits: octokit,
    repository: `${context.repository.owner}/${context.repository.repo}`,
    prNumber: context.entityNumber.toString(),
    isPR: context.isPR,
    triggerUsername: context.actor,
    triggerTime,
    originalTitle,
    originalBody,
    includeCommentsByActor: context.inputs.includeCommentsByActor,
    excludeCommentsByActor: context.inputs.excludeCommentsByActor,
  });

  return buildGitHubContextMarkdown({
    contextSummary: formatContext(data.contextData, context.isPR),
    prBody: formatBody(data.contextData.body ?? "", data.imageUrlMap),
    changedFilesBlock: formatChangedFilesWithSHA(data.changedFilesWithSHA),
    commentsBlock: formatComments(data.comments, data.imageUrlMap),
    reviewsBlock: formatReviewComments(data.reviewData, data.imageUrlMap),
  });
}

async function runAgentRoundOne(params: {
  agent: ReviewAgent;
  githubContextMarkdown: string;
}): Promise<AgentFindings> {
  const promptPath = await writeAgentPrompt({
    agent: params.agent,
    githubContextMarkdown: params.githubContextMarkdown,
  });

  const result = await runClaude(promptPath, {
    claudeArgs: buildWorkerClaudeArgs(),
    appendSystemPrompt: params.agent.perspective,
    model: process.env.ANTHROPIC_MODEL,
    pathToClaudeCodeExecutable:
      process.env.INPUT_PATH_TO_CLAUDE_CODE_EXECUTABLE,
    showFullOutput: process.env.INPUT_SHOW_FULL_OUTPUT,
    executionFilePath: executionFilePath(`r1-${params.agent.id}`),
  });

  if (!result.structuredOutput) {
    throw new Error(
      `Agent ${params.agent.id} returned no structured output (conclusion: ${result.conclusion})`,
    );
  }
  return validateStructuredOutput<AgentFindings>(
    result.structuredOutput,
    ["agent_id", "agent_name", "summary", "findings"],
    `Agent ${params.agent.id} Round 1`,
  );
}

async function runAgentDebate(params: {
  agent: ReviewAgent;
  ownFindings: AgentFindings;
  otherFindings: AgentFindings[];
}): Promise<AgentRebuttal> {
  const promptPath = await writeDebatePrompt({
    agent: params.agent,
    ownFindings: params.ownFindings,
    otherFindings: params.otherFindings,
  });

  const result = await runClaude(promptPath, {
    claudeArgs: buildDebateClaudeArgs(),
    appendSystemPrompt: params.agent.perspective,
    model: process.env.ANTHROPIC_MODEL,
    pathToClaudeCodeExecutable:
      process.env.INPUT_PATH_TO_CLAUDE_CODE_EXECUTABLE,
    showFullOutput: process.env.INPUT_SHOW_FULL_OUTPUT,
    executionFilePath: executionFilePath(`r2-${params.agent.id}`),
  });

  if (!result.structuredOutput) {
    throw new Error(
      `Agent ${params.agent.id} returned no structured output in debate round`,
    );
  }
  return validateStructuredOutput<AgentRebuttal>(
    result.structuredOutput,
    ["agent_id", "agent_name", "responses"],
    `Agent ${params.agent.id} Debate`,
  );
}

export async function runMultiAgentReview(
  params: RunMultiAgentReviewParams,
): Promise<ClaudeRunResult> {
  const { context, octokit, githubToken, prepareResult } = params;

  if (!context.isPR) {
    throw new Error("Multi-agent review requires a pull request context");
  }
  if (!isPullRequestEvent(context)) {
    throw new Error(
      "Multi-agent review only runs on pull_request events (current: " +
        context.eventName +
        ")",
    );
  }

  const agents = DEFAULT_REVIEW_AGENTS;
  const debateRounds = parseDebateRounds(context.inputs.reviewDebateRounds);

  // Fetch GitHub data once; every agent reuses the same markdown so we don't
  // multiply API calls by the agent count.
  const githubContextMarkdown = await fetchAndFormatContext({
    context,
    octokit,
  });

  // Pre-create the synthesis comment so we have a stable id to hand to the
  // synthesis agent's MCP server. Failure here is fatal — without this id we
  // have nowhere to publish results.
  const synthesisCommentId = await createSynthesisComment({
    octokit,
    context,
    agentCount: agents.length,
  });

  // Round 1: independent reviews in parallel.
  const round1Results = await Promise.allSettled(
    agents.map((agent) => runAgentRoundOne({ agent, githubContextMarkdown })),
  );

  const allFindings: AgentFindings[] = [];
  const round1Errors: string[] = [];
  round1Results.forEach((res, idx) => {
    const agentId = agents[idx]!.id;
    if (res.status === "fulfilled") {
      allFindings.push(res.value);
    } else {
      const msg =
        res.reason instanceof Error ? res.reason.message : String(res.reason);
      console.error(`[review] Round 1 failed for ${agentId}: ${msg}`);
      round1Errors.push(`${agentId}: ${msg}`);
    }
  });

  if (allFindings.length === 0) {
    const body = `No reviewer agents produced findings.\n\n${round1Errors.length ? `Errors:\n\n- ${round1Errors.join("\n- ")}` : ""}`;
    await updateSynthesisComment({
      octokit,
      context,
      commentId: synthesisCommentId,
      body,
    });
    return { conclusion: "failure" };
  }

  // Round 2: optional debate. Only agents that produced findings in round 1
  // participate — others have nothing to defend.
  const allRebuttals: AgentRebuttal[] = [];
  if (debateRounds > 0) {
    const participating = agents.filter((agent) =>
      allFindings.some((f) => f.agent_id === agent.id),
    );

    for (let round = 0; round < debateRounds; round++) {
      const debateResults = await Promise.allSettled(
        participating.map((agent) => {
          const own = allFindings.find((f) => f.agent_id === agent.id);
          if (!own) {
            return Promise.reject(
              new Error(`No Round 1 findings for ${agent.id}`),
            );
          }
          const others = allFindings.filter((f) => f.agent_id !== agent.id);
          return runAgentDebate({
            agent,
            ownFindings: own,
            otherFindings: others,
          });
        }),
      );

      debateResults.forEach((res, idx) => {
        const agentId = participating[idx]!.id;
        if (res.status === "fulfilled") {
          allRebuttals.push(res.value);
        } else {
          const msg =
            res.reason instanceof Error
              ? res.reason.message
              : String(res.reason);
          console.error(
            `[review] Debate round ${round + 1} failed for ${agentId}: ${msg}`,
          );
        }
      });
    }
  }

  // Synthesis. This is the only agent permitted to touch GitHub.
  try {
    const synthesisPromptPath = await writeSynthesisPrompt({
      allFindings,
      allRebuttals,
      githubContextMarkdown,
      synthesisCommentId,
    });
    const synthesisArgs = await buildSynthesisClaudeArgs({
      githubToken,
      context,
      synthesisCommentId,
      branchInfo: prepareResult.branchInfo,
    });
    const synthesisResult = await runClaude(synthesisPromptPath, {
      claudeArgs: synthesisArgs,
      model: process.env.ANTHROPIC_MODEL,
      pathToClaudeCodeExecutable:
        process.env.INPUT_PATH_TO_CLAUDE_CODE_EXECUTABLE,
      showFullOutput: process.env.INPUT_SHOW_FULL_OUTPUT,
      executionFilePath: executionFilePath("synthesis"),
    });

    return {
      conclusion: synthesisResult.conclusion,
      executionFile: synthesisResult.executionFile,
      sessionId: synthesisResult.sessionId,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[review] Synthesis failed: ${reason}`);
    // Best-effort fallback: publish raw findings so the PR author still sees
    // something actionable.
    try {
      await updateSynthesisComment({
        octokit,
        context,
        commentId: synthesisCommentId,
        body: buildFallbackSynthesisBody(allFindings, reason),
      });
    } catch (fallbackError) {
      console.error(
        `[review] Fallback synthesis update also failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
      );
    }
    return { conclusion: "failure" };
  }
}
