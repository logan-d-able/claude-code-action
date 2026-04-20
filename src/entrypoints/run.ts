#!/usr/bin/env bun

/**
 * Unified entrypoint for the Claude Code Action.
 * Merges all previously separate action.yml steps (prepare, install, run, cleanup)
 * into a single TypeScript orchestrator.
 */

import * as core from "@actions/core";
import { dirname } from "path";
import { spawn } from "child_process";
import { appendFile } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { setupGitHubToken, WorkflowValidationSkipError } from "../github/token";
import { checkWritePermissions } from "../github/validation/permissions";
import { createOctokit } from "../github/api/client";
import type { Octokits } from "../github/api/client";
import {
  parseGitHubContext,
  isEntityContext,
  isPullRequestEvent,
  isPullRequestReviewEvent,
  isPullRequestReviewCommentEvent,
} from "../github/context";
import type { GitHubContext } from "../github/context";
import { detectMode } from "../modes/detector";
import { prepareTagMode } from "../modes/tag";
import { prepareAgentMode } from "../modes/agent";
import {
  buildContextMarkdown,
  formatTriageLine,
  parseDebateRounds,
  postTriageOnlyComment,
  runMultiAgentReview,
  runTriageAgent,
} from "../modes/review";
import { checkContainsTrigger } from "../github/validation/trigger";
import { restoreConfigFromBase } from "../github/operations/restore-config";
import { validateBranchName } from "../github/operations/branch";
import { collectActionInputsPresence } from "./collect-inputs";
import { updateCommentLink } from "./update-comment-link";
import { formatTurnsFromData } from "./format-turns";
import type { Turn } from "./format-turns";
// Base-action imports (used directly instead of subprocess)
import { validateEnvironmentVariables } from "../../base-action/src/validate-env";
import { setupClaudeCodeSettings } from "../../base-action/src/setup-claude-code-settings";
import { installPlugins } from "../../base-action/src/install-plugins";
import { preparePrompt } from "../../base-action/src/prepare-prompt";
import { runClaude } from "../../base-action/src/run-claude";
import type { ClaudeRunResult } from "../../base-action/src/run-claude-sdk";

/**
 * Install Claude Code CLI, handling retry logic and custom executable paths.
 */
async function installClaudeCode(): Promise<void> {
  const customExecutable = process.env.PATH_TO_CLAUDE_CODE_EXECUTABLE;
  if (customExecutable) {
    if (/[\x00-\x1f\x7f]/.test(customExecutable)) {
      throw new Error(
        "PATH_TO_CLAUDE_CODE_EXECUTABLE contains control characters (e.g. newlines), which is not allowed",
      );
    }
    console.log(`Using custom Claude Code executable: ${customExecutable}`);
    const claudeDir = dirname(customExecutable);
    // Add to PATH by appending to GITHUB_PATH
    const githubPath = process.env.GITHUB_PATH;
    if (githubPath) {
      await appendFile(githubPath, `${claudeDir}\n`);
    }
    // Also add to current process PATH
    process.env.PATH = `${claudeDir}:${process.env.PATH}`;
    return;
  }

  const claudeCodeVersion = "2.1.112";
  console.log(`Installing Claude Code v${claudeCodeVersion}...`);

  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`Installation attempt ${attempt}...`);
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          "bash",
          [
            "-c",
            `curl -fsSL https://claude.ai/install.sh | bash -s -- ${claudeCodeVersion}`,
          ],
          { stdio: "inherit" },
        );
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Install failed with exit code ${code}`));
        });
        child.on("error", reject);
      });
      console.log("Claude Code installed successfully");
      // Add to PATH
      const homeBin = `${process.env.HOME}/.local/bin`;
      const githubPath = process.env.GITHUB_PATH;
      if (githubPath) {
        await appendFile(githubPath, `${homeBin}\n`);
      }
      process.env.PATH = `${homeBin}:${process.env.PATH}`;
      return;
    } catch (error) {
      if (attempt === 3) {
        throw new Error(
          `Failed to install Claude Code after 3 attempts: ${error}`,
        );
      }
      console.log("Installation failed, retrying...");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

/**
 * Write the step summary from Claude's execution output file.
 */
async function writeStepSummary(executionFile: string): Promise<void> {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;

  try {
    const fileContent = readFileSync(executionFile, "utf-8");
    const data: Turn[] = JSON.parse(fileContent);
    const markdown = formatTurnsFromData(data);
    await appendFile(summaryFile, markdown);
    console.log("Successfully formatted Claude Code report");
  } catch (error) {
    console.error(`Failed to format output: ${error}`);
    // Fall back to raw JSON
    try {
      let fallback = "## Claude Code Report (Raw Output)\n\n";
      fallback +=
        "Failed to format output (please report). Here's the raw JSON:\n\n";
      fallback += "```json\n";
      fallback += readFileSync(executionFile, "utf-8");
      fallback += "\n```\n";
      await appendFile(summaryFile, fallback);
    } catch {
      console.error("Failed to write raw output to step summary");
    }
  }
}

async function run() {
  let githubToken: string | undefined;
  let commentId: number | undefined;
  let claudeBranch: string | undefined;
  let baseBranch: string | undefined;
  let executionFile: string | undefined;
  let claudeSuccess = false;
  let prepareSuccess = true;
  let prepareError: string | undefined;
  let context: GitHubContext | undefined;
  let octokit: Octokits | undefined;
  // Track whether we've completed prepare phase, so we can attribute errors correctly
  let prepareCompleted = false;
  try {
    // Phase 1: Prepare
    const actionInputsPresent = collectActionInputsPresence();
    context = parseGitHubContext();
    const modeName = detectMode(context);
    console.log(
      `Auto-detected mode: ${modeName} for event: ${context.eventName}`,
    );

    try {
      githubToken = await setupGitHubToken();
    } catch (error) {
      if (error instanceof WorkflowValidationSkipError) {
        core.setOutput("skipped_due_to_workflow_validation_mismatch", "true");
        console.log("Exiting due to workflow validation skip");
        return;
      }
      throw error;
    }

    octokit = createOctokit(githubToken);

    // Set GITHUB_TOKEN and GH_TOKEN in process env for downstream usage
    process.env.GITHUB_TOKEN = githubToken;
    process.env.GH_TOKEN = githubToken;

    // Check write permissions (only for entity contexts)
    if (isEntityContext(context)) {
      const hasWritePermissions = await checkWritePermissions(
        octokit.rest,
        context,
        context.inputs.allowedNonWriteUsers,
        !!process.env.OVERRIDE_GITHUB_TOKEN,
      );
      if (!hasWritePermissions) {
        throw new Error(
          "Actor does not have write permissions to the repository",
        );
      }
    }

    // Check trigger conditions
    //
    // Multi-agent review auto-fires on every PR event ("true"/"auto") without
    // requiring the @claude trigger phrase — the whole point of opt-in review
    // is zero-touch automation. The tag-mode trigger check only applies when
    // multi-agent review is disabled, in which case the classic "@claude in
    // body/title/comment" behavior is preserved.
    const multiAgentAutoTrigger =
      modeName === "tag" &&
      isEntityContext(context) &&
      context.isPR &&
      isPullRequestEvent(context) &&
      (context.inputs.multiAgentReview === "true" ||
        context.inputs.multiAgentReview === "auto");

    const containsTrigger =
      multiAgentAutoTrigger ||
      (modeName === "tag"
        ? isEntityContext(context) && checkContainsTrigger(context)
        : !!context.inputs?.prompt);
    console.log(`Mode: ${modeName}`);
    console.log(`Context prompt: ${context.inputs?.prompt || "NO PROMPT"}`);
    console.log(
      `Multi-agent auto-trigger: ${multiAgentAutoTrigger} (multi_agent_review=${context.inputs.multiAgentReview})`,
    );
    console.log(`Trigger result: ${containsTrigger}`);

    if (!containsTrigger) {
      console.log("No trigger found, skipping remaining steps");
      core.setOutput("github_token", githubToken);
      return;
    }

    // Run prepare
    console.log(
      `Preparing with mode: ${modeName} for event: ${context.eventName}`,
    );
    const tagPrepareResult =
      modeName === "tag"
        ? await prepareTagMode({ context, octokit, githubToken })
        : undefined;
    const prepareResult =
      tagPrepareResult ??
      (await prepareAgentMode({ context, octokit, githubToken }));

    commentId = prepareResult.commentId;
    claudeBranch = prepareResult.branchInfo.claudeBranch;
    baseBranch = prepareResult.branchInfo.baseBranch;
    prepareCompleted = true;

    // Phase 2: Install Claude Code CLI
    await installClaudeCode();

    // Phase 3: Run Claude (import base-action directly)
    // Set env vars needed by the base-action code
    process.env.INPUT_ACTION_INPUTS_PRESENT = actionInputsPresent;
    process.env.CLAUDE_CODE_ACTION = "1";
    process.env.DETAILED_PERMISSION_MESSAGES = "1";

    validateEnvironmentVariables();

    // On PRs, .claude/ and .mcp.json in the checkout are attacker-controlled.
    // Restore them from the base branch before the CLI reads them.
    //
    // We read pull_request.base.ref from the payload directly because agent
    // mode's branchInfo.baseBranch defaults to the repo's default branch rather
    // than the PR's actual target (agent/index.ts). For issue_comment on a PR the payload
    // lacks base.ref, so we fall back to the mode-provided value — tag mode
    // fetches it from GraphQL; agent mode on issue_comment is an edge case
    // that at worst restores from the wrong trusted branch (still secure).
    if (isEntityContext(context) && context.isPR) {
      let restoreBase = baseBranch;
      if (
        isPullRequestEvent(context) ||
        isPullRequestReviewEvent(context) ||
        isPullRequestReviewCommentEvent(context)
      ) {
        restoreBase = context.payload.pull_request.base.ref;
        validateBranchName(restoreBase);
      }
      if (restoreBase) {
        restoreConfigFromBase(restoreBase);
      }
    }

    await setupClaudeCodeSettings(process.env.INPUT_SETTINGS);

    await installPlugins(
      process.env.INPUT_PLUGIN_MARKETPLACES,
      process.env.INPUT_PLUGINS,
      process.env.INPUT_PATH_TO_CLAUDE_CODE_EXECUTABLE,
    );

    // Multi-agent review is an additive branch on top of tag mode: the tag
    // prepare step above has already created the tracking comment and branch.
    // We only redirect the *execution* step — finally-block cleanup and
    // updateCommentLink still run identically to upstream tag mode.
    const multiAgentEligible =
      !!tagPrepareResult &&
      isEntityContext(context) &&
      context.isPR &&
      isPullRequestEvent(context);
    const multiAgentInput = context.inputs.multiAgentReview;

    let claudeResult: ClaudeRunResult | undefined;
    if (
      multiAgentEligible &&
      multiAgentInput === "true" &&
      tagPrepareResult &&
      isEntityContext(context)
    ) {
      // Forced multi-agent review — uses `prepareResult.promptFilePath`
      // internally, so we don't need to validate the prompt file here.
      claudeResult = await runMultiAgentReview({
        context,
        octokit,
        githubToken,
        prepareResult: tagPrepareResult,
      });
    } else {
      // Source of truth for the prompt file: in tag mode `createPrompt`
      // already wrote it, so `tagPrepareResult.promptFilePath` is the actual
      // bytes on disk. Using it guarantees triage and any follow-up agent
      // read the exact same prompt. In agent/other mode there is no
      // `tagPrepareResult`; validate the user-supplied (or env-default) file
      // via `preparePrompt`.
      let promptFilePath: string;
      if (tagPrepareResult) {
        promptFilePath = tagPrepareResult.promptFilePath;
      } else {
        const promptFile =
          process.env.INPUT_PROMPT_FILE ||
          `${process.env.RUNNER_TEMP}/claude-prompts/claude-prompt.txt`;
        const promptConfig = await preparePrompt({ prompt: "", promptFile });
        promptFilePath = promptConfig.path;
      }

      if (
        multiAgentEligible &&
        multiAgentInput === "auto" &&
        tagPrepareResult &&
        isEntityContext(context)
      ) {
        // Auto mode: run a zero-tool triage sub-agent that decides per-PR
        // whether to spend the full multi-agent pipeline. Context markdown is
        // built exactly once and reused — `fetchPullRequestPatches` is
        // rate-limit sensitive and must not run twice.
        const githubContextMarkdown = await buildContextMarkdown({
          context,
          octokit,
          prepareResult: tagPrepareResult,
        });
        const triageDecision = await runTriageAgent({
          context,
          githubContextMarkdown,
          promptFilePath,
        });
        const triageLine = formatTriageLine(triageDecision);
        console.log(
          `[triage] decision=${triageDecision.decision} reason=${triageDecision.reason}`,
        );

        if (triageDecision.decision === "multi") {
          claudeResult = await runMultiAgentReview({
            context,
            octokit,
            githubToken,
            prepareResult: tagPrepareResult,
            preBuiltContextMarkdown: githubContextMarkdown,
            triageLine,
          });
        } else {
          // Single-path under auto: debate rounds are meaningless without
          // multiple reviewer agents. Warn so operators notice silent drops.
          if (parseDebateRounds(context.inputs.reviewDebateRounds) > 0) {
            console.warn(
              `[triage] review_debate_rounds=${context.inputs.reviewDebateRounds} ignored (triage routed to single-agent)`,
            );
          }
          await postTriageOnlyComment({ octokit, context, triageLine });
          // fall through to the shared `runClaude` call below
        }
      }

      // Shared single-agent execution for both the auto→single and the
      // standard-single paths. Consolidating here means any future security
      // fix or argument addition applies uniformly regardless of routing.
      if (!claudeResult) {
        claudeResult = await runClaude(promptFilePath, {
          claudeArgs: prepareResult.claudeArgs,
          appendSystemPrompt: process.env.APPEND_SYSTEM_PROMPT,
          model: process.env.ANTHROPIC_MODEL,
          pathToClaudeCodeExecutable:
            process.env.INPUT_PATH_TO_CLAUDE_CODE_EXECUTABLE,
          showFullOutput: process.env.INPUT_SHOW_FULL_OUTPUT,
        });
      }
    }

    claudeSuccess = claudeResult.conclusion === "success";
    executionFile = claudeResult.executionFile;

    // Set action-level outputs
    if (claudeResult.executionFile) {
      core.setOutput("execution_file", claudeResult.executionFile);
    }
    if (claudeResult.sessionId) {
      core.setOutput("session_id", claudeResult.sessionId);
    }
    if (claudeResult.structuredOutput) {
      core.setOutput("structured_output", claudeResult.structuredOutput);
    }
    core.setOutput("conclusion", claudeResult.conclusion);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // Only mark as prepare failure if we haven't completed the prepare phase
    if (!prepareCompleted) {
      prepareSuccess = false;
      prepareError = errorMessage;
    }
    core.setFailed(`Action failed with error: ${errorMessage}`);
  } finally {
    // Phase 4: Cleanup (always runs)

    // Update tracking comment
    if (
      commentId &&
      context &&
      isEntityContext(context) &&
      githubToken &&
      octokit
    ) {
      try {
        await updateCommentLink({
          commentId,
          githubToken,
          claudeBranch,
          baseBranch: baseBranch || context.repository.default_branch || "main",
          triggerUsername: context.actor,
          context,
          octokit,
          claudeSuccess,
          outputFile: executionFile,
          prepareSuccess,
          prepareError,
          useCommitSigning: context.inputs.useCommitSigning,
        });
      } catch (error) {
        console.error("Error updating comment with job link:", error);
      }
    }

    // Write step summary (unless display_report is set to false)
    if (
      executionFile &&
      existsSync(executionFile) &&
      process.env.DISPLAY_REPORT !== "false"
    ) {
      await writeStepSummary(executionFile);
    }

    // Set remaining action-level outputs
    core.setOutput("branch_name", claudeBranch);
    core.setOutput("github_token", githubToken);
  }
}

if (import.meta.main) {
  run();
}
