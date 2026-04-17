import {
  isEntityContext,
  isIssueCommentEvent,
  isPullRequestEvent,
  isPullRequestReviewCommentEvent,
  isPullRequestReviewEvent,
} from "../context";
import type { GitHubContext } from "../context";
import type { Octokits } from "../api/client";
import { validateBranchName } from "./branch";

/**
 * Resolve the PR base ref that restore-config should reset sensitive paths
 * from. Returns undefined for non-PR events.
 *
 * issue_comment payloads lack pull_request.base.ref, so this falls back to
 * the REST API for that case. Validation is performed inside so callers
 * don't have to re-derive which branch to pass to validateBranchName.
 */
export async function resolveRestoreBase(
  context: GitHubContext,
  octokit: Octokits,
): Promise<string | undefined> {
  if (!isEntityContext(context) || !context.isPR) return undefined;

  if (
    isPullRequestEvent(context) ||
    isPullRequestReviewEvent(context) ||
    isPullRequestReviewCommentEvent(context)
  ) {
    const ref = context.payload.pull_request.base.ref;
    validateBranchName(ref);
    return ref;
  }

  if (isIssueCommentEvent(context) && context.payload.issue.pull_request) {
    const { data: pr } = await octokit.rest.pulls.get({
      owner: context.repository.owner,
      repo: context.repository.repo,
      pull_number: context.entityNumber,
    });
    validateBranchName(pr.base.ref);
    return pr.base.ref;
  }

  return undefined;
}
