import * as core from "@actions/core";
import type { Octokits } from "../../github/api/client";
import type { GitHubContext, ParsedGitHubContext } from "../../github/context";
import { isEntityContext } from "../../github/context";
import { checkHumanActor } from "../../github/validation/actor";
import {
  configureGitAuth,
  setupSshSigning,
} from "../../github/operations/git-config";
import { setupBranch } from "../../github/operations/branch";
import {
  fetchGitHubData,
  extractTriggerTimestamp,
  extractOriginalTitle,
  extractOriginalBody,
} from "../../github/data/fetcher";
import { formatContext, formatBody } from "../../github/data/formatter";
import { prepareMcpConfig } from "../../mcp/install-mcp-server";
import { runClaude } from "../../../base-action/src/run-claude";
import type { ClaudeRunResult } from "../../../base-action/src/run-claude-sdk";
import { resolveAgents, type ReviewAgent } from "./agents";
import { AGENT_FINDINGS_SCHEMA, AGENT_REBUTTAL_SCHEMA } from "./schemas";
import type { AgentFindings, AgentRebuttal } from "./schemas";
import {
  generateAgentPrompt,
  generateDebatePrompt,
  generateSynthesisPrompt,
  buildAgentClaudeArgs,
} from "./prompts";
import { ReviewTracker } from "./tracking";
import { mergeExecutionFiles } from "./merge-execution";

type ReviewResult = {
  commentId: number | undefined;
  branchInfo: {
    baseBranch: string;
    currentBranch: string;
    claudeBranch: string | undefined;
  };
  executionFile?: string;
};

export async function prepareAndRunReview({
  context,
  octokit,
  githubToken,
}: {
  context: GitHubContext;
  octokit: Octokits;
  githubToken: string;
}): Promise<ReviewResult> {
  if (!isEntityContext(context)) {
    throw new Error("Review mode requires entity context (PR)");
  }
  if (!context.isPR) {
    throw new Error("Review mode is only supported for Pull Requests");
  }

  // Validate human actor
  await checkHumanActor(octokit.rest, context);

  // Resolve agents from spec file / input / defaults
  const { agents, debateRounds, synthesisPerspective } = await resolveAgents({
    reviewProtocolPath: context.inputs.reviewProtocolPath,
    reviewAgents: context.inputs.reviewAgents,
    reviewDebateRounds: context.inputs.reviewDebateRounds,
    reviewMaxAgents: context.inputs.reviewMaxAgents,
  });

  core.info(
    `Review mode: ${agents.length} agents, ${debateRounds} debate round(s)`,
  );

  // Configure git auth
  const useSshSigning = !!context.inputs.sshSigningKey;
  const useApiCommitSigning = context.inputs.useCommitSigning && !useSshSigning;

  if (useSshSigning) {
    await setupSshSigning(context.inputs.sshSigningKey);
    const user = {
      login: context.inputs.botName,
      id: parseInt(context.inputs.botId),
    };
    await configureGitAuth(githubToken, context, user);
  } else if (!useApiCommitSigning) {
    const user = {
      login: context.inputs.botName,
      id: parseInt(context.inputs.botId),
    };
    await configureGitAuth(githubToken, context, user);
  }

  // Fetch GitHub data once (shared across all agents)
  const triggerTime = extractTriggerTimestamp(context);
  const originalTitle = extractOriginalTitle(context);
  const originalBody = extractOriginalBody(context);

  const githubData = await fetchGitHubData({
    octokits: octokit,
    repository: `${context.repository.owner}/${context.repository.repo}`,
    prNumber: context.entityNumber.toString(),
    isPR: true,
    triggerUsername: context.actor,
    triggerTime,
    originalTitle,
    originalBody,
    includeCommentsByActor: context.inputs.includeCommentsByActor,
    excludeCommentsByActor: context.inputs.excludeCommentsByActor,
  });

  // Setup branch
  const branchInfo = await setupBranch(octokit, githubData, context);

  // Build GitHub context markdown (shared across all agents)
  const githubContextMarkdown = buildGitHubContextMarkdown(githubData, context);

  // Create tracking comment
  const tracker = new ReviewTracker(
    octokit.rest,
    context.repository.owner,
    context.repository.repo,
    agents,
  );
  const trackingCommentId = await tracker.createComment(context.entityNumber);

  // Prepare MCP config (read-only for review agents)
  const mcpConfig = await prepareMcpConfig({
    githubToken,
    owner: context.repository.owner,
    repo: context.repository.repo,
    branch: branchInfo.claudeBranch || branchInfo.currentBranch,
    baseBranch: branchInfo.baseBranch,
    claudeCommentId: trackingCommentId.toString(),
    allowedTools: [],
    mode: "review",
    context,
  });

  const baseClaudeArgs = buildBaseClaudeArgs(mcpConfig);
  const executionFiles: string[] = [];

  // === Round 1: Independent Reviews ===
  const allFindings: AgentFindings[] = [];

  for (const agent of agents) {
    await tracker.updateAgentStatus(agent.name, "running");

    try {
      const findings = await runReviewAgent(
        agent,
        githubContextMarkdown,
        baseClaudeArgs,
        `review-r1-${agent.id}`,
      );

      allFindings.push(findings);
      await tracker.updateAgentStatus(agent.name, "complete", findings);

      // Collect execution file
      const execFile = `${process.env.RUNNER_TEMP}/claude-execution-review-r1-${agent.id}.json`;
      executionFiles.push(execFile);
    } catch (error) {
      core.warning(`Agent ${agent.id} failed: ${error}`);
      await tracker.updateAgentStatus(agent.name, "error");
    }
  }

  // === Round 2: Debate ===
  const allRebuttals: AgentRebuttal[] = [];

  if (debateRounds > 0 && allFindings.length > 1) {
    await tracker.updateDebateStatus("running");

    for (const agent of agents) {
      const ownFindings = allFindings.find((f) => f.agent_id === agent.id);
      if (!ownFindings) continue;

      const otherFindings = allFindings.filter((f) => f.agent_id !== agent.id);

      try {
        const rebuttal = await runDebateAgent(
          agent,
          ownFindings,
          otherFindings,
          baseClaudeArgs,
          `review-r2-${agent.id}`,
        );
        allRebuttals.push(rebuttal);

        const execFile = `${process.env.RUNNER_TEMP}/claude-execution-review-r2-${agent.id}.json`;
        executionFiles.push(execFile);
      } catch (error) {
        core.warning(`Debate agent ${agent.id} failed: ${error}`);
      }
    }

    await tracker.updateDebateStatus("complete");
  } else if (debateRounds === 0) {
    await tracker.updateDebateStatus("complete");
  }

  // === Synthesis ===
  await tracker.updateSynthesisStatus("running");

  try {
    await runSynthesisAgent(
      synthesisPerspective,
      allFindings,
      allRebuttals,
      githubToken,
      context,
      trackingCommentId,
    );

    const execFile = `${process.env.RUNNER_TEMP}/claude-execution-review-synthesis.json`;
    executionFiles.push(execFile);
    await tracker.updateSynthesisStatus("complete");
  } catch (error) {
    core.warning(`Synthesis agent failed: ${error}`);
    await tracker.updateSynthesisStatus("error");
  }

  // Merge all execution files
  const mergedExecutionFile = `${process.env.RUNNER_TEMP}/claude-execution-output.json`;
  await mergeExecutionFiles(executionFiles, mergedExecutionFile);

  return {
    commentId: trackingCommentId,
    branchInfo: {
      baseBranch: branchInfo.baseBranch,
      currentBranch: branchInfo.currentBranch,
      claudeBranch: branchInfo.claudeBranch,
    },
    executionFile: mergedExecutionFile,
  };
}

async function runReviewAgent(
  agent: ReviewAgent,
  githubContextMarkdown: string,
  baseClaudeArgs: string,
  executionId: string,
): Promise<AgentFindings> {
  const promptPath = await generateAgentPrompt(agent, githubContextMarkdown);
  const claudeArgs = buildAgentClaudeArgs(
    baseClaudeArgs,
    AGENT_FINDINGS_SCHEMA,
  );
  const executionFilePath = `${process.env.RUNNER_TEMP}/claude-execution-${executionId}.json`;

  core.info(`Running review agent: ${agent.name} (${agent.id})`);

  const result = await runClaude(promptPath, {
    claudeArgs,
    appendSystemPrompt: agent.perspective,
    model: agent.model,
    maxTurns: String(agent.maxTurns),
    showFullOutput: process.env.INPUT_SHOW_FULL_OUTPUT,
    executionFilePath,
  });

  if (!result.structuredOutput) {
    throw new Error(`Agent ${agent.id} did not produce structured output`);
  }

  return JSON.parse(result.structuredOutput) as AgentFindings;
}

async function runDebateAgent(
  agent: ReviewAgent,
  ownFindings: AgentFindings,
  otherFindings: AgentFindings[],
  baseClaudeArgs: string,
  executionId: string,
): Promise<AgentRebuttal> {
  const promptPath = await generateDebatePrompt(
    agent,
    ownFindings,
    otherFindings,
  );
  const claudeArgs = buildAgentClaudeArgs(
    baseClaudeArgs,
    AGENT_REBUTTAL_SCHEMA,
  );
  const executionFilePath = `${process.env.RUNNER_TEMP}/claude-execution-${executionId}.json`;

  core.info(`Running debate agent: ${agent.name} (${agent.id})`);

  const result = await runClaude(promptPath, {
    claudeArgs,
    appendSystemPrompt: agent.perspective,
    model: agent.model,
    maxTurns: String(agent.maxTurns),
    showFullOutput: process.env.INPUT_SHOW_FULL_OUTPUT,
    executionFilePath,
  });

  if (!result.structuredOutput) {
    throw new Error(
      `Debate agent ${agent.id} did not produce structured output`,
    );
  }

  return JSON.parse(result.structuredOutput) as AgentRebuttal;
}

async function runSynthesisAgent(
  synthesisPerspective: string,
  allFindings: AgentFindings[],
  allRebuttals: AgentRebuttal[],
  githubToken: string,
  context: ParsedGitHubContext,
  trackingCommentId: number,
): Promise<ClaudeRunResult> {
  const promptPath = await generateSynthesisPrompt(
    synthesisPerspective,
    allFindings,
    allRebuttals,
  );
  const executionFilePath = `${process.env.RUNNER_TEMP}/claude-execution-review-synthesis.json`;

  // Synthesis agent gets the comment MCP server to post its review
  const synthesisMcpConfig = await prepareMcpConfig({
    githubToken,
    owner: context.repository.owner,
    repo: context.repository.repo,
    branch: "",
    baseBranch: "",
    claudeCommentId: trackingCommentId.toString(),
    allowedTools: ["mcp__github_comment__update_claude_comment"],
    mode: "review",
    context,
  });

  const escapedConfig = synthesisMcpConfig.replace(/'/g, "'\\''");
  const claudeArgs = `--mcp-config '${escapedConfig}' --permission-mode acceptEdits --allowedTools "Glob,Grep,Read,mcp__github_comment__update_claude_comment"`;

  core.info("Running synthesis agent");

  return runClaude(promptPath, {
    claudeArgs,
    appendSystemPrompt: synthesisPerspective,
    maxTurns: "15",
    showFullOutput: process.env.INPUT_SHOW_FULL_OUTPUT,
    executionFilePath,
  });
}

function buildBaseClaudeArgs(mcpConfig: string): string {
  const escapedConfig = mcpConfig.replace(/'/g, "'\\''");
  // Review agents are read-only — no file write tools
  return `--mcp-config '${escapedConfig}' --permission-mode acceptEdits --allowedTools "Glob,Grep,Read,LS"`;
}

function buildGitHubContextMarkdown(
  githubData: Awaited<ReturnType<typeof fetchGitHubData>>,
  context: ParsedGitHubContext,
): string {
  const sections: string[] = [];

  sections.push(`## Repository
${context.repository.owner}/${context.repository.repo}`);

  if (githubData.contextData) {
    sections.push(
      `## PR Context\n${formatContext(githubData.contextData, true)}`,
    );
  }

  if (githubData.contextData.body) {
    sections.push(
      `## PR Description\n${formatBody(githubData.contextData.body, githubData.imageUrlMap || new Map())}`,
    );
  }

  return sections.join("\n\n");
}
