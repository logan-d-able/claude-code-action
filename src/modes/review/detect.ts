import {
  isEntityContext,
  isIssueCommentEvent,
  isPullRequestEvent,
  isPullRequestReviewCommentEvent,
} from "../../github/context";
import type { GitHubContext } from "../../github/context";
import { checkContainsTrigger } from "../../github/validation/trigger";

export const REVIEW_PR_ACTIONS = [
  "opened",
  "synchronize",
  "ready_for_review",
  "reopened",
] as const;

export function shouldEnterReviewMode(context: GitHubContext): boolean {
  const setting = context.inputs.multiAgentReview;
  if (setting !== "true" && setting !== "auto") return false;
  if (!isEntityContext(context) || !context.isPR) return false;

  const isPrOpenLike =
    isPullRequestEvent(context) &&
    context.eventAction !== undefined &&
    (REVIEW_PR_ACTIONS as readonly string[]).includes(context.eventAction);

  if (isPrOpenLike) return true;

  if (
    isIssueCommentEvent(context) ||
    isPullRequestReviewCommentEvent(context)
  ) {
    return checkContainsTrigger(context);
  }

  return false;
}
