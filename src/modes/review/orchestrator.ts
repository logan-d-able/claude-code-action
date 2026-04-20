/**
 * Multi-agent PR review orchestrator.
 *
 * Invariants (enforced by callers + tests):
 *   1. `prepareTagMode` has already run and created the tracking comment.
 *      We never read or mutate `prepareResult.commentId` — it belongs to tag
 *      mode's finally-block update flow.
 *   2. Workers run with a pure read-only allowlist derived from
 *      `ReviewAgent.tools` and NO MCP servers — they physically cannot touch
 *      GitHub.
 *   3. The synthesis comment body begins with `SYNTHESIS_COMMENT_MARKER` so
 *      sticky-comment reuse never targets it.
 *   4. Synthesis inherits the tag-mode claudeArgs builder, but with the MCP
 *      comment id rebound to the synthesis comment — NOT the tag tracking id.
 */

import { runClaude } from "../../../base-action/src/run-claude";
import type { ClaudeRunResult } from "../../../base-action/src/run-claude-sdk";
import type { Octokits } from "../../github/api/client";
import type { ParsedGitHubContext } from "../../github/context";
import { isPullRequestEvent } from "../../github/context";
import { fetchPullRequestPatches } from "../../github/data/fetcher";
import {
  formatBody,
  formatChangedFileDiffs,
  formatChangedFilesWithSHA,
  formatComments,
  formatContext,
  formatReviewComments,
} from "../../github/data/formatter";
import { sanitizeContent } from "../../github/utils/sanitizer";
import { prepareMcpConfig } from "../../mcp/install-mcp-server";
import type { PrepareTagResult } from "../tag";
import { DEFAULT_REVIEW_AGENTS } from "./agents";
import type { ReviewAgent } from "./agents";
import {
  buildGitHubContextMarkdown,
  buildSubAgentSystemPrompt,
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

/** Parse `reviewDebateRounds`, guarding against NaN and clamping to [0, 3]. */
export function parseDebateRounds(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(3, n));
}

/**
 * Build the `claudeArgs` string for a sub-agent (worker or debate). No MCP
 * servers — sub-agents are intentionally denied any tool that could edit
 * files, post comments, or touch git history. Schema is passed to enforce
 * structured JSON output.
 */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_:()*-]+$/;

export function buildSubAgentClaudeArgs(
  tools: ReadonlyArray<string>,
  schema: unknown,
): string {
  for (const tool of tools) {
    if (!TOOL_NAME_PATTERN.test(tool)) {
      throw new Error(`Invalid tool name: ${JSON.stringify(tool)}`);
    }
  }
  const toolList = tools.join(",");
  const schemaJson = JSON.stringify(schema).replace(/'/g, "'\\''");
  return `--permission-mode acceptEdits --allowedTools "${toolList}" --json-schema '${schemaJson}'`;
}

/**
 * Synthesis agent tool allowlist. Intentionally minimal and fixed:
 *
 *   - read-only filesystem tools (Glob/Grep/LS/Read) so synthesis can verify
 *     findings against the source tree
 *   - exactly two MCP write tools targeting the synthesis comment and inline
 *     review comments on this PR
 *
 * Synthesis does NOT inherit tag mode's git CLI (`git add/commit/rm`,
 * git-push wrapper) or `mcp__github_file_ops__*`. Those capabilities would
 * let a prompt-injected PR (via worker findings threaded into synthesis's
 * system prompt) push arbitrary commits. Synthesis also does not forward the
 * user's `CLAUDE_ARGS` MCP tools — it is an internal sub-agent with a narrow
 * remit, not a user-facing Claude invocation.
 */
const SYNTHESIS_TOOLS: ReadonlyArray<string> = [
  "Glob",
  "Grep",
  "LS",
  "Read",
  "mcp__github_comment__update_claude_comment",
  "mcp__github_inline_comment__create_inline_comment",
];

/**
 * Build the `claudeArgs` for the synthesis agent. Constructs its own MCP
 * config with the synthesis comment id rebound, and emits exactly the tools
 * in `SYNTHESIS_TOOLS` — no tag-mode inheritance, no git CLI, no file ops.
 */
async function buildSynthesisClaudeArgs(params: {
  githubToken: string;
  context: ParsedGitHubContext;
  synthesisCommentId: number;
  branchInfo: PrepareTagResult["branchInfo"];
}): Promise<string> {
  const { context, githubToken, synthesisCommentId, branchInfo } = params;

  // Force-disable commit signing for synthesis. `prepareMcpConfig` starts the
  // `github_file_ops` MCP server whenever `useCommitSigning` is true; synthesis
  // never uses that server (see `SYNTHESIS_TOOLS`), but a live server would
  // give a prompt-injected agent an out-of-band path to commit files if the
  // `--allowedTools` boundary ever leaks. Defence in depth.
  const synthesisContext: ParsedGitHubContext = {
    ...context,
    inputs: { ...context.inputs, useCommitSigning: false },
  };

  const mcpConfig = await prepareMcpConfig({
    githubToken,
    owner: synthesisContext.repository.owner,
    repo: synthesisContext.repository.repo,
    branch: branchInfo.claudeBranch || branchInfo.currentBranch,
    baseBranch: branchInfo.baseBranch,
    claudeCommentId: synthesisCommentId.toString(),
    allowedTools: Array.from(SYNTHESIS_TOOLS),
    mode: "tag",
    context: synthesisContext,
  });

  const escapedConfig = mcpConfig.replace(/'/g, "'\\''");
  return (
    `--mcp-config '${escapedConfig}'` +
    ` --permission-mode acceptEdits` +
    ` --allowedTools "${SYNTHESIS_TOOLS.join(",")}"`
  );
}

function executionFilePath(suffix: string): string {
  const base = process.env.RUNNER_TEMP ?? "/tmp";
  return `${base}/claude-execution-review-${suffix}.json`;
}

async function buildContextMarkdown(params: {
  context: ParsedGitHubContext;
  octokit: Octokits;
  prepareResult: PrepareTagResult;
}): Promise<string> {
  const { context, octokit, prepareResult } = params;
  const data = prepareResult.githubData;

  const patches = context.isPR
    ? await fetchPullRequestPatches({
        octokits: octokit,
        owner: context.repository.owner,
        repo: context.repository.repo,
        prNumber: context.entityNumber.toString(),
      })
    : new Map<string, string | undefined>();

  return buildGitHubContextMarkdown({
    contextSummary: formatContext(data.contextData, context.isPR),
    prBody: formatBody(data.contextData.body ?? "", data.imageUrlMap),
    changedFilesBlock: formatChangedFilesWithSHA(data.changedFilesWithSHA),
    diffBlock: formatChangedFileDiffs(data.changedFilesWithSHA, patches),
    commentsBlock: formatComments(data.comments, data.imageUrlMap),
    reviewsBlock: formatReviewComments(data.reviewData, data.imageUrlMap),
  });
}

async function runAgentRoundOne(params: {
  agent: ReviewAgent;
  githubContextMarkdown: string;
  promptFilePath: string;
}): Promise<AgentFindings> {
  const { agent, githubContextMarkdown, promptFilePath } = params;
  const appendSystemPrompt = buildSubAgentSystemPrompt({
    role: "review",
    agent,
    githubContextMarkdown,
  });

  const result = await runClaude(promptFilePath, {
    claudeArgs: buildSubAgentClaudeArgs(agent.tools, AGENT_FINDINGS_SCHEMA),
    appendSystemPrompt,
    model: process.env.ANTHROPIC_MODEL,
    pathToClaudeCodeExecutable:
      process.env.INPUT_PATH_TO_CLAUDE_CODE_EXECUTABLE,
    showFullOutput: process.env.INPUT_SHOW_FULL_OUTPUT,
    executionFilePath: executionFilePath(`r1-${agent.id}`),
  });

  if (!result.structuredOutput) {
    throw new Error(
      `Agent ${agent.id} returned no structured output (conclusion: ${result.conclusion})`,
    );
  }
  return validateStructuredOutput<AgentFindings>(
    result.structuredOutput,
    ["agent_id", "agent_name", "summary", "findings"],
    `Agent ${agent.id} Round 1`,
  );
}

async function runAgentDebate(params: {
  agent: ReviewAgent;
  ownFindings: AgentFindings;
  otherFindings: AgentFindings[];
  priorRoundRebuttals?: AgentRebuttal[];
  roundNumber: number;
  githubContextMarkdown: string;
  promptFilePath: string;
}): Promise<AgentRebuttal> {
  const {
    agent,
    ownFindings,
    otherFindings,
    priorRoundRebuttals,
    roundNumber,
    githubContextMarkdown,
    promptFilePath,
  } = params;

  const appendSystemPrompt = buildSubAgentSystemPrompt({
    role: "debate",
    agent,
    githubContextMarkdown,
    debateRoundNumber: roundNumber,
    ownFindings,
    otherFindings,
    priorRoundRebuttals,
  });

  const result = await runClaude(promptFilePath, {
    claudeArgs: buildSubAgentClaudeArgs(agent.tools, AGENT_REBUTTAL_SCHEMA),
    appendSystemPrompt,
    model: process.env.ANTHROPIC_MODEL,
    pathToClaudeCodeExecutable:
      process.env.INPUT_PATH_TO_CLAUDE_CODE_EXECUTABLE,
    showFullOutput: process.env.INPUT_SHOW_FULL_OUTPUT,
    // Include the round number — without it, debate rounds 2+ overwrite
    // each earlier round's log for the same agent and the audit trail is
    // silently lost.
    executionFilePath: executionFilePath(`r2-${roundNumber}-${agent.id}`),
  });

  if (!result.structuredOutput) {
    throw new Error(
      `Agent ${agent.id} returned no structured output in debate round`,
    );
  }
  return validateStructuredOutput<AgentRebuttal>(
    result.structuredOutput,
    ["agent_id", "agent_name", "responses"],
    `Agent ${agent.id} Debate`,
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

  // Reuse the tag-mode fetched GitHub data; do not re-call fetchGitHubData.
  const githubContextMarkdown = await buildContextMarkdown({
    context,
    octokit,
    prepareResult,
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
    agents.map((agent) =>
      runAgentRoundOne({
        agent,
        githubContextMarkdown,
        promptFilePath: prepareResult.promptFilePath,
      }),
    ),
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
    // Route raw error strings through sanitizeContent before embedding them in
    // a GitHub-rendered comment body — same invariant applied by
    // `buildFallbackSynthesisBody` on the peer path.
    const errorBlock = round1Errors.length
      ? `Errors:\n\n${round1Errors.map((e) => `- ${sanitizeContent(e)}`).join("\n")}`
      : "";
    const body = `No reviewer agents produced findings.${errorBlock ? `\n\n${errorBlock}` : ""}`;
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
  // Debate-round failures feed the same skipped-reviewers disclosure as round 1.
  // Without this, a debate failure for (e.g.) security-reviewer is only logged
  // to stderr — synthesis still runs with the round-1 findings and the PR
  // author sees no indication that the debate perspective was missing.
  const debateErrors: string[] = [];
  if (debateRounds > 0) {
    const participating = agents.filter((agent) =>
      allFindings.some((f) => f.agent_id === agent.id),
    );

    for (let round = 0; round < debateRounds; round++) {
      // Snapshot rebuttals from prior rounds before this round's results are
      // appended. Each debater sees only closed-out rounds — never peers'
      // in-flight responses from the current round.
      const priorRoundRebuttals = allRebuttals.slice();
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
            priorRoundRebuttals,
            roundNumber: round + 1,
            githubContextMarkdown,
            promptFilePath: prepareResult.promptFilePath,
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
          debateErrors.push(`${agentId} (debate round ${round + 1}): ${msg}`);
        }
      });
    }
  }

  // Synthesis. This is the only agent permitted to touch GitHub.
  try {
    const synthesisArgs = await buildSynthesisClaudeArgs({
      githubToken,
      context,
      synthesisCommentId,
      branchInfo: prepareResult.branchInfo,
    });
    const synthesisAppendSystemPrompt = buildSubAgentSystemPrompt({
      role: "synthesis",
      githubContextMarkdown,
      allFindings,
      allRebuttals,
      synthesisCommentId,
      skippedReviewers: [...round1Errors, ...debateErrors],
    });

    const synthesisResult = await runClaude(prepareResult.promptFilePath, {
      claudeArgs: synthesisArgs,
      appendSystemPrompt: synthesisAppendSystemPrompt,
      model: process.env.ANTHROPIC_MODEL,
      pathToClaudeCodeExecutable:
        process.env.INPUT_PATH_TO_CLAUDE_CODE_EXECUTABLE,
      showFullOutput: process.env.INPUT_SHOW_FULL_OUTPUT,
      executionFilePath: executionFilePath("synthesis"),
    });

    if (synthesisResult.conclusion !== "success") {
      const reason = `synthesis conclusion: ${synthesisResult.conclusion}`;
      try {
        await updateSynthesisComment({
          octokit,
          context,
          commentId: synthesisCommentId,
          body: buildFallbackSynthesisBody(allFindings, reason, [
            ...round1Errors,
            ...debateErrors,
          ]),
        });
      } catch (fallbackError) {
        console.error(
          `[review] Fallback synthesis update failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
        );
      }
    }

    return {
      conclusion: synthesisResult.conclusion,
      executionFile: synthesisResult.executionFile,
      sessionId: synthesisResult.sessionId,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[review] Synthesis failed: ${reason}`);
    try {
      await updateSynthesisComment({
        octokit,
        context,
        commentId: synthesisCommentId,
        body: buildFallbackSynthesisBody(allFindings, reason, [
          ...round1Errors,
          ...debateErrors,
        ]),
      });
    } catch (fallbackError) {
      console.error(
        `[review] Fallback synthesis update also failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
      );
    }
    return { conclusion: "failure" };
  }
}
