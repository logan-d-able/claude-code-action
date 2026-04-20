/**
 * Triage sub-agent used by `multi_agent_review: "auto"`.
 *
 * Runs a single structured-output Claude call that reads the same PR context
 * markdown the review workers would see and returns `{decision, reason}`. The
 * caller uses this to route the PR to either the full multi-agent pipeline
 * (correctness + security + quality reviewers, optional debate, synthesis) or
 * to the standard single-agent tag-mode review.
 *
 * Invariants:
 *   1. Zero tools — triage cannot read files, post comments, or touch git.
 *      Its only output is the JSON payload validated against `TRIAGE_SCHEMA`.
 *   2. Errors never throw out of this function. Any failure (SDK timeout,
 *      missing structured output, schema violation) is caught and reduced to
 *      `{decision: "single", reason: "triage failed: …"}` so the caller can
 *      cleanly fall back to single-agent review without wrapping in try/catch.
 *   3. The model is inherited from `process.env.ANTHROPIC_MODEL` — same as the
 *      review workers and synthesis — so operators can tune once for the whole
 *      review flow.
 */

import { runClaude } from "../../../base-action/src/run-claude";
import type { ParsedGitHubContext } from "../../github/context";
import { retryWithBackoff } from "../../utils/retry";
import type { RetryOptions } from "../../utils/retry";
import { buildSubAgentClaudeArgs } from "./orchestrator";
import { buildSubAgentSystemPrompt } from "./prompts";
import { TRIAGE_SCHEMA, validateStructuredOutput } from "./schemas";
import type { TriageDecision } from "./schemas";

const TRIAGE_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 2,
  initialDelayMs: 2000,
  maxDelayMs: 10000,
};

const TRIAGE_TOOLS: ReadonlyArray<string> = [];

function triageExecutionFilePath(): string {
  const base = process.env.RUNNER_TEMP ?? "/tmp";
  return `${base}/claude-execution-review-triage.json`;
}

export type RunTriageAgentParams = {
  context: ParsedGitHubContext;
  githubContextMarkdown: string;
  promptFilePath: string;
};

export async function runTriageAgent(
  params: RunTriageAgentParams,
): Promise<TriageDecision> {
  const { githubContextMarkdown, promptFilePath } = params;

  try {
    return await retryWithBackoff(async () => {
      const result = await runClaude(promptFilePath, {
        claudeArgs: buildSubAgentClaudeArgs(TRIAGE_TOOLS, TRIAGE_SCHEMA),
        appendSystemPrompt: buildSubAgentSystemPrompt({
          role: "triage",
          githubContextMarkdown,
        }),
        model: process.env.ANTHROPIC_MODEL,
        pathToClaudeCodeExecutable:
          process.env.INPUT_PATH_TO_CLAUDE_CODE_EXECUTABLE,
        showFullOutput: process.env.INPUT_SHOW_FULL_OUTPUT,
        executionFilePath: triageExecutionFilePath(),
      });
      if (!result.structuredOutput) {
        throw new Error(
          `Triage returned no structured output (conclusion: ${result.conclusion})`,
        );
      }
      return validateStructuredOutput<TriageDecision>(
        result.structuredOutput,
        ["decision", "reason"],
        "Triage",
      );
    }, TRIAGE_RETRY_OPTIONS);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(
      `[triage] Failed after retries, falling back to single: ${msg}`,
    );
    return { decision: "single", reason: `triage failed: ${msg}` };
  }
}

/**
 * Render a triage decision as a single-line human-readable audit trail for
 * embedding in the synthesis comment body.
 */
export function formatTriageLine(decision: TriageDecision): string {
  // Reason is enforced <= 500 chars by the schema, but guard anyway in case a
  // fallback path constructs a decision without going through the schema.
  const reason = decision.reason.slice(0, 500).replace(/\s+/g, " ").trim();
  return `🔀 Triage: ${decision.decision} — ${reason}`;
}
