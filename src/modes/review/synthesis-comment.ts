/**
 * Helpers that create and update the separate synthesis comment used by
 * multi-agent review.
 *
 * The synthesis comment is distinct from tag mode's tracking comment. It lives
 * on the same issue/PR but is never matched by the sticky-comment reuse logic
 * in `create-initial.ts` because its body starts with a unique marker.
 */

import type { Octokits } from "../../github/api/client";
import type { ParsedGitHubContext } from "../../github/context";
import { SYNTHESIS_COMMENT_MARKER } from "./prompts";
import { sanitizeFindings } from "./sanitize";
import type { AgentFindings } from "./schemas";

export async function createSynthesisComment(params: {
  octokit: Octokits;
  context: ParsedGitHubContext;
  agentCount: number;
}): Promise<number> {
  const { octokit, context, agentCount } = params;
  const body = `${SYNTHESIS_COMMENT_MARKER}\n\n⏳ Running ${agentCount} reviewer agent${agentCount === 1 ? "" : "s"}...`;
  const response = await octokit.rest.issues.createComment({
    owner: context.repository.owner,
    repo: context.repository.repo,
    issue_number: context.entityNumber,
    body,
  });
  return response.data.id;
}

export async function updateSynthesisComment(params: {
  octokit: Octokits;
  context: ParsedGitHubContext;
  commentId: number;
  body: string;
}): Promise<void> {
  const { octokit, context, commentId, body } = params;
  const normalized = body.startsWith(SYNTHESIS_COMMENT_MARKER)
    ? body
    : `${SYNTHESIS_COMMENT_MARKER}\n\n${body}`;
  await octokit.rest.issues.updateComment({
    owner: context.repository.owner,
    repo: context.repository.repo,
    comment_id: commentId,
    body: normalized,
  });
}

/**
 * Build a markdown fallback body from raw agent findings. Used when the
 * synthesis agent itself fails — we still want the PR author to see the
 * reviewers' output instead of a dead "Running..." comment.
 */
export function buildFallbackSynthesisBody(
  allFindings: AgentFindings[],
  failureReason?: string,
): string {
  const header = failureReason
    ? `⚠️ Synthesis agent failed (${failureReason}). Showing raw reviewer output below.`
    : "";
  const agentSections = allFindings
    .map((raw) => {
      const f = sanitizeFindings(raw);
      if (f.findings.length === 0) {
        return `### ${f.agent_name}\n\n_No findings._\n\n> ${f.summary}`;
      }
      const items = f.findings
        .map(
          (item) =>
            `- **[${item.severity.toUpperCase()}] ${item.title}** — ${item.description}${item.file ? ` _(${item.file}${item.line ? `:${item.line}` : ""})_` : ""}`,
        )
        .join("\n");
      return `### ${f.agent_name}\n\n> ${f.summary}\n\n${items}`;
    })
    .join("\n\n---\n\n");
  return [header, agentSections].filter(Boolean).join("\n\n");
}
