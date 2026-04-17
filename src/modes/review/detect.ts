import {
  isEntityContext,
  isIssueCommentEvent,
  isPullRequestEvent,
  isPullRequestReviewCommentEvent,
} from "../../github/context";
import type { GitHubContext } from "../../github/context";
import { escapeRegExp } from "../../github/validation/trigger";

export const REVIEW_PR_ACTIONS = [
  "opened",
  "synchronize",
  "ready_for_review",
  "reopened",
] as const;

const REVIEW_OPT_IN = new Set<string>(["true", "auto"]);

// Matches the trigger phrase directly in a comment body. Unlike
// checkContainsTrigger, this does not short-circuit to `true` when
// `prompt` is set — that short-circuit is correct for agent/tag entry
// but breaks review mode, where `prompt` carries team guidance and
// must not imply "trigger on every comment". Bot-authored comments
// are filtered before body matching so the orchestrator's own tracking
// comment (and other automation chatter) can't re-enter review.
export function hasCommentTriggerPhrase(context: GitHubContext): boolean {
  if (!isEntityContext(context)) return false;
  const phrase = context.inputs.triggerPhrase;
  if (!phrase) return false;

  let body: string | undefined;
  let actorType: string | undefined;

  if (isIssueCommentEvent(context)) {
    body = context.payload.comment.body;
    actorType = context.payload.comment.user?.type;
  } else if (isPullRequestReviewCommentEvent(context)) {
    body = context.payload.comment.body;
    actorType = context.payload.comment.user?.type;
  } else {
    return false;
  }

  if (actorType === "Bot") return false;
  if (!body) return false;

  const regex = new RegExp(`(^|\\s)${escapeRegExp(phrase)}([\\s.,!?;:]|$)`);
  return regex.test(body);
}

export function shouldEnterReviewMode(context: GitHubContext): boolean {
  if (!REVIEW_OPT_IN.has(context.inputs.multiAgentReview)) return false;
  if (!isEntityContext(context) || !context.isPR) return false;

  const isPrOpenLike =
    isPullRequestEvent(context) &&
    context.eventAction !== undefined &&
    (REVIEW_PR_ACTIONS as readonly string[]).includes(context.eventAction);

  if (isPrOpenLike) return true;
  return hasCommentTriggerPhrase(context);
}
