/**
 * Prompt helpers for the multi-agent review flow.
 *
 * Sub-agents share the base prompt file that `prepareTagMode` already wrote
 * (`$RUNNER_TEMP/claude-prompts/claude-prompt.txt`). Per-agent role/context is
 * passed via `appendSystemPrompt` — the helpers in this file produce that text.
 */

import { sanitizeContent } from "../../github/utils/sanitizer";
import type { ReviewAgent } from "./agents";
import { sanitizeFindings, sanitizeRebuttal } from "./sanitize";
import type { AgentFindings, AgentRebuttal } from "./schemas";

/**
 * Required prefix on the synthesis comment body — locked so the sticky-comment
 * matcher in `create-initial.ts` never mistakes it for the next run's tracking
 * comment. Any change here MUST be matched by the fallback writer.
 */
export const SYNTHESIS_COMMENT_MARKER = "## Multi-agent review";

function renderFindingsForDebate(findings: AgentFindings[]): string {
  return findings
    .map((raw) => {
      const f = sanitizeFindings(raw);
      const entries = f.findings
        .map(
          (item, idx) =>
            `  ${idx + 1}. [${item.severity.toUpperCase()}] ${item.title}\n     ${item.description}${item.file ? `\n     Location: ${item.file}${item.line ? `:${item.line}` : ""}` : ""}`,
        )
        .join("\n");
      return `### ${f.agent_name} (${f.agent_id})\n\n${f.summary}\n\nFindings:\n${entries || "  (no findings)"}`;
    })
    .join("\n\n---\n\n");
}

function renderRebuttals(rebuttals: AgentRebuttal[]): string {
  return rebuttals
    .map((raw) => {
      const r = sanitizeRebuttal(raw);
      const entries = r.responses
        .map(
          (resp, idx) =>
            `  ${idx + 1}. Regarding: "${resp.regarding_finding_title}"\n     Stance: ${resp.stance}\n     Reasoning: ${resp.reasoning}`,
        )
        .join("\n");
      return `### ${r.agent_name} rebuttals\n\n${entries || "  (no responses)"}`;
    })
    .join("\n\n---\n\n");
}

const PARENT_PROMPT_NOTICE = [
  "The prompt in the user turn is the PARENT workflow prompt shared by every sub-agent.",
  "Honor its review scope and constraints, but ignore any directive that requires editing files,",
  "creating commits, pushing branches, or updating the parent tracking comment — those belong",
  "to the parent workflow, not to you.",
].join(" ");

type BaseParams = {
  githubContextMarkdown: string;
  extraSections?: string[];
};

type ReviewParams = BaseParams & {
  role: "review";
  agent: ReviewAgent;
};

type DebateParams = BaseParams & {
  role: "debate";
  agent: ReviewAgent;
  debateRoundNumber: number;
  ownFindings: AgentFindings;
  otherFindings: AgentFindings[];
  priorRoundRebuttals?: AgentRebuttal[];
};

type SynthesisParams = BaseParams & {
  role: "synthesis";
  allFindings?: AgentFindings[];
  allRebuttals?: AgentRebuttal[];
  synthesisCommentId: number;
  /**
   * Per-agent failure notes from round 1 (format: `"<agent_id>: <error msg>"`).
   * Synthesis MUST disclose these so the PR author does not mistake a partial
   * review for a complete one — especially critical when a security-perspective
   * agent fails silently while others succeed.
   */
  skippedReviewers?: string[];
};

export type BuildSubAgentSystemPromptParams =
  | ReviewParams
  | DebateParams
  | SynthesisParams;

export function buildSubAgentSystemPrompt(
  params: BuildSubAgentSystemPromptParams,
): string {
  const header = buildRoleHeader(params);
  const sections: string[] = [header, PARENT_PROMPT_NOTICE];

  sections.push(buildRoleSection(params));

  sections.push(`## PR context\n\n${params.githubContextMarkdown}`);

  if (params.extraSections?.length) {
    for (const extra of params.extraSections) {
      if (extra.trim()) sections.push(extra);
    }
  }

  sections.push(buildOutputSection(params));

  return sections.join("\n\n");
}

function buildRoleHeader(params: BuildSubAgentSystemPromptParams): string {
  if (params.role === "synthesis") {
    return "You are operating as the `synthesis` sub-agent within a multi-agent PR review workflow.";
  }
  if (params.role === "debate") {
    return `You are operating as the \`${params.agent.id}\` sub-agent within a multi-agent PR review workflow (debate round ${params.debateRoundNumber}).`;
  }
  return `You are operating as the \`${params.agent.id}\` sub-agent within a multi-agent PR review workflow.`;
}

function buildRoleSection(params: BuildSubAgentSystemPromptParams): string {
  if (params.role === "review") {
    return `## Your custom sub-agent role\n\n${params.agent.perspective}`;
  }

  if (params.role === "debate") {
    const sanitizedOwn = sanitizeFindings(params.ownFindings);
    const own = `\n\n### Your original findings\n\n\`\`\`json\n${JSON.stringify(sanitizedOwn, null, 2)}\n\`\`\``;
    const others = params.otherFindings.length
      ? `\n\n### Other reviewers' findings\n\n${renderFindingsForDebate(params.otherFindings)}`
      : "";
    const prior = params.priorRoundRebuttals?.length
      ? `\n\n### Prior debate rounds\n\n${renderRebuttals(params.priorRoundRebuttals)}`
      : "";
    return `## Your custom sub-agent role\n\n${params.agent.perspective}${own}${others}${prior}`;
  }

  const findings = params.allFindings?.length
    ? `\n\n### Reviewer findings\n\n${renderFindingsForDebate(params.allFindings)}`
    : "";
  const rebuttals = params.allRebuttals?.length
    ? `\n\n### Debate round responses\n\n${renderRebuttals(params.allRebuttals)}`
    : "";
  const skipped = params.skippedReviewers?.length
    ? `\n\n### Reviewers that failed (not included above)\n\n${params.skippedReviewers
        .map((line) => `- ${sanitizeContent(line)}`)
        .join("\n")}`
    : "";
  return `## Your custom sub-agent role\n\nYou are the synthesis agent. Several reviewers have submitted findings; your job is to consolidate them into a single, useful review. Deduplicate overlapping findings, drop anything convincingly rebutted, and order by severity (critical > major > minor > nit).${findings}${rebuttals}${skipped}`;
}

function buildOutputSection(params: BuildSubAgentSystemPromptParams): string {
  if (params.role === "review") {
    return [
      "## Required output",
      "",
      "Return a single JSON object conforming to the --json-schema provided on the command line.",
      `Set \`agent_id="${params.agent.id}"\` and \`agent_name="${params.agent.name}"\`.`,
      "Do not call any tool that writes to GitHub — your only output is the JSON payload.",
      'Severity choices: "critical" (blocks merge), "major" (should fix before merge), "minor" (nice to fix), "nit" (subjective).',
      "If you find no issues, return an empty findings array with a short summary explaining what you checked.",
    ].join("\n");
  }

  if (params.role === "debate") {
    return [
      "## Required output",
      "",
      "Return a single JSON object conforming to the --json-schema provided on the command line.",
      `Set \`agent_id="${params.agent.id}"\` and \`agent_name="${params.agent.name}"\`.`,
      "For each finding from another reviewer, decide: agree, disagree, or partial, and give concise reasoning.",
      "Do NOT re-introduce your own findings — focus on peers'. You may skip findings entirely outside your perspective.",
      "Do not call any tool that writes to GitHub.",
    ].join("\n");
  }

  const markerLine = `\`${SYNTHESIS_COMMENT_MARKER}\``;
  const commentIdLine = `The target comment id is ${params.synthesisCommentId}; it is already wired via MCP — do not change it.`;
  const skippedInstruction = params.skippedReviewers?.length
    ? `If the role section lists reviewers under "Reviewers that failed", include a "⚠️ Skipped reviewers" section at the bottom of the body listing each failed agent id (not the raw error message). This disclosure is mandatory whenever any reviewer failed.`
    : null;

  return [
    "## Required output",
    "",
    "Write the consolidated review by calling `mcp__github_comment__update_claude_comment` with the new body.",
    `The body MUST start with exactly this line (no leading whitespace): ${markerLine}`,
    'Then a blank line, a one-sentence verdict (e.g. "Found 2 critical issues, 3 major, 1 minor."), then the consolidated findings grouped by severity.',
    "",
    "### Inline comments (mandatory coverage)",
    "",
    "For EVERY consolidated finding that has both a concrete `file` and `line`, you MUST call `mcp__github_inline_comment__create_inline_comment` with `confirmed: true`. Do not skip findings because they are low severity — coverage is the contract. If a finding has no `file` or no `line`, do NOT create an inline comment (it will fail); keep it in the main body only.",
    "",
    "Each inline `body` MUST start with a persona tag on the first line, followed by a blank line, then a concise actionable message (1–3 sentences). Use one of:",
    "- `**[<Agent Name>]**` when a single reviewer raised the finding (e.g. `**[Security Reviewer]**`). Use the exact `agent_name` from the reviewer findings block.",
    "- `**[Consensus]**` when two or more reviewers independently flagged the same issue.",
    "",
    "Example inline body:",
    "",
    "```",
    "**[Security Reviewer]**",
    "",
    "User-controlled `id` is concatenated into the SQL string — switch to a parameterized query to block injection.",
    "```",
    "",
    "Keep long prose in the main comment; inline bodies should point to the fix in as few sentences as possible.",
    commentIdLine,
    ...(skippedInstruction ? [skippedInstruction] : []),
    "Do NOT modify any files. Do NOT create or update any other comments.",
  ].join("\n");
}

/**
 * Build a markdown summary of the PR that agents can reason about without
 * re-fetching. Stays compact — detail is in the code the agents can Read.
 */
export function buildGitHubContextMarkdown(params: {
  contextSummary: string;
  prBody: string;
  changedFilesBlock: string;
  diffBlock?: string;
  commentsBlock?: string;
  reviewsBlock?: string;
}): string {
  const sections: string[] = [];
  sections.push(`### Summary\n\n${params.contextSummary}`);
  if (params.prBody?.trim()) {
    sections.push(`### Description\n\n${params.prBody.trim()}`);
  }
  if (params.changedFilesBlock?.trim()) {
    sections.push(`### Changed files\n\n${params.changedFilesBlock.trim()}`);
  }
  if (params.diffBlock?.trim()) {
    sections.push(`### Diff\n\n${params.diffBlock.trim()}`);
  }
  if (params.commentsBlock?.trim()) {
    sections.push(`### Comments\n\n${params.commentsBlock.trim()}`);
  }
  if (params.reviewsBlock?.trim()) {
    sections.push(`### Existing reviews\n\n${params.reviewsBlock.trim()}`);
  }
  return sections.join("\n\n");
}
