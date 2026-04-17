import * as core from "@actions/core";
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
 * the REST API for that case. The API call is wrapped in try/catch: a
 * transient failure degrades to "skip restore" (caller-safe fallback)
 * instead of crashing the entire run. Validation happens inside so
 * callers don't have to re-derive which branch to pass to
 * validateBranchName.
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
    try {
      const { data: pr } = await octokit.rest.pulls.get({
        owner: context.repository.owner,
        repo: context.repository.repo,
        pull_number: context.entityNumber,
      });
      validateBranchName(pr.base.ref);
      return pr.base.ref;
    } catch (err) {
      core.warning(
        `Failed to resolve PR base ref for restore-config: ${(err as Error).message}. ` +
          `Skipping restore-config step.`,
      );
      return undefined;
    }
  }

  return undefined;
}
