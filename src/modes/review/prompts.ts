/**
 * Prompt generators for the multi-agent review flow.
 *
 * Each generator writes its prompt to a fresh file under
 * `$RUNNER_TEMP/claude-review-prompts/` and returns the path. The directory
 * is separate from tag mode's `claude-prompts/` so a reviewer prompt can never
 * collide with (or be shadowed by) the base prompt file.
 */

import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { assertValidAgentId } from "./agents";
import type { ReviewAgent } from "./agents";
import type { AgentFindings, AgentRebuttal } from "./schemas";
import { AGENT_FINDINGS_SCHEMA, AGENT_REBUTTAL_SCHEMA } from "./schemas";

/** Required prefix on the synthesis comment body — locked so the sticky-comment
 * matcher in `create-initial.ts` never mistakes it for the next run's tracking
 * comment. Any change here MUST be matched by the fallback writer and the
 * synthesis prompt.
 */
export const SYNTHESIS_COMMENT_MARKER = "## Multi-agent review";

function promptsDir(): string {
  const base = process.env.RUNNER_TEMP ?? "/tmp";
  return join(base, "claude-review-prompts");
}

async function writePromptFile(
  filename: string,
  body: string,
): Promise<string> {
  const dir = promptsDir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, filename);
  await writeFile(path, body);
  return path;
}

function formatSchema(schema: unknown): string {
  return JSON.stringify(schema, null, 2);
}

function renderFindingsForDebate(findings: AgentFindings[]): string {
  return findings
    .map((f) => {
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
    .map((r) => {
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

/**
 * Round 1 prompt: independent findings from a single perspective.
 */
export async function writeAgentPrompt(params: {
  agent: ReviewAgent;
  githubContextMarkdown: string;
  teamGuidance?: string;
}): Promise<string> {
  const { agent, githubContextMarkdown, teamGuidance } = params;
  assertValidAgentId(agent.id);

  const body = `# Pull Request Review — ${agent.name}

You are reviewing a pull request from a specific perspective. Your perspective is:

${agent.perspective}

${teamGuidance ? `## Team guidance\n\n${teamGuidance}\n\n` : ""}## Pull Request Context

${githubContextMarkdown}

## Instructions

- Read the diff and the surrounding code (Read/Glob/Grep/LS tools only — you have no write access).
- Identify findings that fall strictly within your perspective. Ignore issues owned by other reviewers.
- For each finding, pick a severity: "critical" (blocks merge), "major" (should fix before merge), "minor" (nice to fix), "nit" (subjective).
- When possible, include the file path and line number.
- Be precise and specific. Avoid generic warnings.

## Required Output

You MUST return a single JSON object conforming to this schema:

\`\`\`json
${formatSchema(AGENT_FINDINGS_SCHEMA)}
\`\`\`

Set agent_id to "${agent.id}" and agent_name to "${agent.name}". If you find no issues, return an empty findings array with a short summary explaining what you checked.`;

  return writePromptFile(`r1-${agent.id}.txt`, body);
}

/**
 * Round 2 prompt: rebut or endorse peers' findings.
 */
export async function writeDebatePrompt(params: {
  agent: ReviewAgent;
  ownFindings: AgentFindings;
  otherFindings: AgentFindings[];
  teamGuidance?: string;
}): Promise<string> {
  const { agent, ownFindings, otherFindings, teamGuidance } = params;
  assertValidAgentId(agent.id);

  const body = `# Multi-Agent Review — Debate Round (${agent.name})

You previously submitted the findings below. Other reviewers have submitted theirs. Now respond to THEIR findings from your perspective.

${teamGuidance ? `## Team guidance\n\n${teamGuidance}\n\n` : ""}## Your perspective

${agent.perspective}

## Your original findings

\`\`\`json
${JSON.stringify(ownFindings, null, 2)}
\`\`\`

## Other reviewers' findings

${renderFindingsForDebate(otherFindings)}

## Instructions

- For each finding from another reviewer, decide: agree, disagree, or partial.
- Keep reasoning concise and specific to your perspective.
- Do NOT re-introduce your own findings here — focus on peers'.
- You may skip findings that are entirely outside your perspective.

## Required Output

Return a single JSON object conforming to this schema:

\`\`\`json
${formatSchema(AGENT_REBUTTAL_SCHEMA)}
\`\`\`

Set agent_id to "${agent.id}" and agent_name to "${agent.name}".`;

  return writePromptFile(`r2-${agent.id}.txt`, body);
}

/**
 * Final synthesis prompt. The synthesis agent updates the pre-created review
 * comment via `mcp__github_comment__update_claude_comment` and may post inline
 * comments via `mcp__github_inline_comment__create_inline_comment`.
 *
 * NOTE: the synthesis body MUST start with {@link SYNTHESIS_COMMENT_MARKER}
 * so that sticky-comment matching cannot reuse it on the next run.
 */
export async function writeSynthesisPrompt(params: {
  allFindings: AgentFindings[];
  allRebuttals: AgentRebuttal[];
  githubContextMarkdown: string;
  synthesisCommentId: number;
  teamGuidance?: string;
}): Promise<string> {
  const {
    allFindings,
    allRebuttals,
    githubContextMarkdown,
    synthesisCommentId,
    teamGuidance,
  } = params;

  const rebuttalSection = allRebuttals.length
    ? `## Debate round responses\n\n${renderRebuttals(allRebuttals)}\n\n`
    : "";

  const body = `# Multi-Agent Review Synthesis

You are the synthesis agent. Several reviewers have submitted findings; your job is to consolidate them into a single, useful review.

${teamGuidance ? `## Team guidance\n\n${teamGuidance}\n\n` : ""}## Pull Request Context

${githubContextMarkdown}

## Reviewer findings

${renderFindingsForDebate(allFindings)}

${rebuttalSection}## Your job

1. Deduplicate overlapping findings across reviewers.
2. Drop findings that were convincingly rebutted in the debate round.
3. Prioritize by severity (critical > major > minor > nit).
4. Write a consolidated review and post it by calling:

   \`mcp__github_comment__update_claude_comment\` with the body.

The comment id is already wired via MCP; you do not need to pass it explicitly.

**REQUIRED**: the body you post MUST start with exactly this line (no leading whitespace):

\`\`\`
${SYNTHESIS_COMMENT_MARKER}
\`\`\`

Then a blank line, then a one-sentence verdict (e.g. "Found 2 critical issues, 3 major, 1 minor."). Then the consolidated findings grouped by severity.

For each finding that has a concrete file/line, you SHOULD also call \`mcp__github_inline_comment__create_inline_comment\` with \`confirmed: true\` and a targeted message. Only use inline comments for specific, actionable feedback — keep prose in the main comment.

Do NOT modify any files. Do NOT create or update any other comments. Only update comment id ${synthesisCommentId} and post inline comments.`;

  return writePromptFile(`synthesis.txt`, body);
}

/**
 * Build a markdown summary of the PR that agents can reason about without
 * re-fetching. Stays compact — detail is in the code the agents can Read.
 */
export function buildGitHubContextMarkdown(params: {
  contextSummary: string;
  prBody: string;
  changedFilesBlock: string;
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
  if (params.commentsBlock?.trim()) {
    sections.push(`### Comments\n\n${params.commentsBlock.trim()}`);
  }
  if (params.reviewsBlock?.trim()) {
    sections.push(`### Existing reviews\n\n${params.reviewsBlock.trim()}`);
  }
  return sections.join("\n\n");
}
