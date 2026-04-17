import { describe, expect, it } from "bun:test";
import {
  hasCommentTriggerPhrase,
  shouldEnterReviewMode,
} from "../../../src/modes/review/detect";
import type { GitHubContext } from "../../../src/github/context";

const baseInputs = {
  prompt: "",
  triggerPhrase: "@claude",
  assigneeTrigger: "",
  labelTrigger: "",
  branchPrefix: "claude/",
  useStickyComment: false,
  classifyInlineComments: true,
  useCommitSigning: false,
  sshSigningKey: "",
  botId: "123456",
  botName: "claude-bot",
  allowedBots: "",
  allowedNonWriteUsers: "",
  trackProgress: false,
  includeFixLinks: true,
  includeCommentsByActor: "",
  excludeCommentsByActor: "",
  multiAgentReview: "auto",
  reviewDebateRounds: 1,
  reviewMaxAgents: 5,
};

const baseContext = {
  runId: "test-run",
  eventAction: "created",
  repository: {
    owner: "test-owner",
    repo: "test-repo",
    full_name: "test-owner/test-repo",
  },
  actor: "test-user",
  inputs: baseInputs,
};

function issueCommentCtx(
  body: string | undefined,
  userType: string | undefined,
  overrides: Partial<typeof baseInputs> = {},
): GitHubContext {
  return {
    ...baseContext,
    eventName: "issue_comment",
    eventAction: "created",
    payload: {
      issue: { number: 1, body: "Test" },
      comment: body === undefined ? {} : { body, user: { type: userType } },
    } as any,
    entityNumber: 1,
    isPR: true,
    inputs: { ...baseInputs, ...overrides },
  };
}

describe("hasCommentTriggerPhrase", () => {
  it("returns false when triggerPhrase is empty", () => {
    const ctx = issueCommentCtx("@claude review", "User", {
      triggerPhrase: "",
    });
    expect(hasCommentTriggerPhrase(ctx)).toBe(false);
  });

  it("returns false for Bot-authored comments even when body matches", () => {
    const ctx = issueCommentCtx("@claude review", "Bot");
    expect(hasCommentTriggerPhrase(ctx)).toBe(false);
  });

  it("returns true for User-authored comments with trigger phrase", () => {
    const ctx = issueCommentCtx("@claude review", "User");
    expect(hasCommentTriggerPhrase(ctx)).toBe(true);
  });

  it("returns true when user.type is absent (treated as non-Bot)", () => {
    const ctx = issueCommentCtx("@claude help", undefined);
    expect(hasCommentTriggerPhrase(ctx)).toBe(true);
  });

  it("returns false when body is missing", () => {
    const ctx = issueCommentCtx(undefined, "User");
    expect(hasCommentTriggerPhrase(ctx)).toBe(false);
  });

  it("returns false when body lacks the trigger phrase", () => {
    const ctx = issueCommentCtx("lgtm", "User");
    expect(hasCommentTriggerPhrase(ctx)).toBe(false);
  });

  it("is not fooled by substring matches within words", () => {
    const ctx = issueCommentCtx("not-@claude-something", "User");
    expect(hasCommentTriggerPhrase(ctx)).toBe(false);
  });

  it("returns false for pull_request_review events (excluded from comment gate)", () => {
    const ctx: GitHubContext = {
      ...baseContext,
      eventName: "pull_request_review",
      eventAction: "submitted",
      payload: {
        pull_request: { number: 1, body: "PR body" },
        review: { body: "@claude take a look" },
      } as any,
      entityNumber: 1,
      isPR: true,
      inputs: baseInputs,
    };
    expect(hasCommentTriggerPhrase(ctx)).toBe(false);
  });

  it("matches trigger phrase in pull_request_review_comment events", () => {
    const ctx: GitHubContext = {
      ...baseContext,
      eventName: "pull_request_review_comment",
      eventAction: "created",
      payload: {
        pull_request: { number: 1, body: "PR body" },
        comment: { body: "@claude check", user: { type: "User" } },
      } as any,
      entityNumber: 1,
      isPR: true,
      inputs: baseInputs,
    };
    expect(hasCommentTriggerPhrase(ctx)).toBe(true);
  });
});

describe("shouldEnterReviewMode", () => {
  it("returns false when multiAgentReview is 'false'", () => {
    const ctx: GitHubContext = {
      ...baseContext,
      eventName: "pull_request",
      eventAction: "opened",
      payload: { pull_request: { number: 1 } } as any,
      entityNumber: 1,
      isPR: true,
      inputs: { ...baseInputs, multiAgentReview: "false" },
    };
    expect(shouldEnterReviewMode(ctx)).toBe(false);
  });

  it("returns false for allowlist typo 'TRUE'", () => {
    const ctx: GitHubContext = {
      ...baseContext,
      eventName: "pull_request",
      eventAction: "opened",
      payload: { pull_request: { number: 1 } } as any,
      entityNumber: 1,
      isPR: true,
      inputs: { ...baseInputs, multiAgentReview: "TRUE" },
    };
    expect(shouldEnterReviewMode(ctx)).toBe(false);
  });

  it("returns true for pull_request.opened with 'true'", () => {
    const ctx: GitHubContext = {
      ...baseContext,
      eventName: "pull_request",
      eventAction: "opened",
      payload: { pull_request: { number: 1 } } as any,
      entityNumber: 1,
      isPR: true,
      inputs: { ...baseInputs, multiAgentReview: "true" },
    };
    expect(shouldEnterReviewMode(ctx)).toBe(true);
  });

  it("returns false for pull_request.closed even with 'auto'", () => {
    const ctx: GitHubContext = {
      ...baseContext,
      eventName: "pull_request",
      eventAction: "closed",
      payload: { pull_request: { number: 1 } } as any,
      entityNumber: 1,
      isPR: true,
      inputs: { ...baseInputs, multiAgentReview: "auto" },
    };
    expect(shouldEnterReviewMode(ctx)).toBe(false);
  });

  it("returns false for issue_comment on non-PR issue", () => {
    const ctx = issueCommentCtx("@claude review", "User");
    const nonPr = { ...ctx, isPR: false } as unknown as GitHubContext;
    expect(shouldEnterReviewMode(nonPr)).toBe(false);
  });

  it("returns true for issue_comment on PR by User with trigger phrase", () => {
    const ctx = issueCommentCtx("@claude review", "User");
    expect(shouldEnterReviewMode(ctx)).toBe(true);
  });

  it("returns false for issue_comment on PR by Bot even with trigger phrase", () => {
    const ctx = issueCommentCtx("@claude review", "Bot");
    expect(shouldEnterReviewMode(ctx)).toBe(false);
  });
});
