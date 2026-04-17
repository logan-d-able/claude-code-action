import { describe, expect, it, mock, spyOn } from "bun:test";
import * as core from "@actions/core";
import { resolveRestoreBase } from "../../../src/github/operations/resolve-base";
import type { GitHubContext } from "../../../src/github/context";
import type { Octokits } from "../../../src/github/api/client";

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
  multiAgentReview: "false",
  reviewDebateRounds: 1,
  reviewMaxAgents: 5,
};

const baseCtx = {
  runId: "test-run",
  eventAction: "opened",
  repository: {
    owner: "test-owner",
    repo: "test-repo",
    full_name: "test-owner/test-repo",
  },
  actor: "test-user",
  inputs: baseInputs,
};

function makeOctokit(getImpl: (args: any) => Promise<any>): Octokits {
  return {
    rest: {
      pulls: { get: getImpl },
    },
  } as unknown as Octokits;
}

describe("resolveRestoreBase", () => {
  it("returns base.ref from pull_request payload", async () => {
    const ctx: GitHubContext = {
      ...baseCtx,
      eventName: "pull_request",
      eventAction: "opened",
      payload: {
        pull_request: { number: 1, base: { ref: "main" } },
      } as any,
      entityNumber: 1,
      isPR: true,
    };
    const octokit = makeOctokit(async () => {
      throw new Error("should not be called");
    });
    expect(await resolveRestoreBase(ctx, octokit)).toBe("main");
  });

  it("returns base.ref from pull_request_review payload", async () => {
    const ctx: GitHubContext = {
      ...baseCtx,
      eventName: "pull_request_review",
      eventAction: "submitted",
      payload: {
        pull_request: { number: 1, base: { ref: "develop" } },
      } as any,
      entityNumber: 1,
      isPR: true,
    };
    expect(
      await resolveRestoreBase(
        ctx,
        makeOctokit(async () => {
          throw new Error("unused");
        }),
      ),
    ).toBe("develop");
  });

  it("looks up base.ref via API for issue_comment on a PR", async () => {
    const ctx: GitHubContext = {
      ...baseCtx,
      eventName: "issue_comment",
      eventAction: "created",
      payload: {
        issue: { number: 7, pull_request: { url: "..." }, body: "" },
        comment: { body: "@claude" },
      } as any,
      entityNumber: 7,
      isPR: true,
    };
    const octokit = makeOctokit(async (args: any) => {
      expect(args).toEqual({
        owner: "test-owner",
        repo: "test-repo",
        pull_number: 7,
      });
      return { data: { base: { ref: "release/1" } } };
    });
    expect(await resolveRestoreBase(ctx, octokit)).toBe("release/1");
  });

  it("returns undefined and warns when API lookup fails", async () => {
    const warnSpy = spyOn(core, "warning").mockImplementation(() => {});
    const ctx: GitHubContext = {
      ...baseCtx,
      eventName: "issue_comment",
      eventAction: "created",
      payload: {
        issue: { number: 7, pull_request: { url: "..." }, body: "" },
        comment: { body: "@claude" },
      } as any,
      entityNumber: 7,
      isPR: true,
    };
    const octokit = makeOctokit(async () => {
      throw new Error("API rate limited");
    });
    const result = await resolveRestoreBase(ctx, octokit);
    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("API rate limited");
    warnSpy.mockRestore();
  });

  it("returns undefined for issue_comment on a non-PR issue", async () => {
    const ctx: GitHubContext = {
      ...baseCtx,
      eventName: "issue_comment",
      eventAction: "created",
      payload: {
        issue: { number: 1, body: "" },
        comment: { body: "@claude" },
      } as any,
      entityNumber: 1,
      isPR: false,
    };
    const octokit = makeOctokit(async () => {
      throw new Error("should not be called");
    });
    expect(await resolveRestoreBase(ctx, octokit)).toBeUndefined();
  });

  it("returns undefined for non-entity context", async () => {
    const automationCtx = {
      eventName: "workflow_dispatch",
      runId: "x",
      inputs: baseInputs,
    } as unknown as GitHubContext;
    const octokit = makeOctokit(async () => {
      throw new Error("should not be called");
    });
    expect(await resolveRestoreBase(automationCtx, octokit)).toBeUndefined();
  });
});

// Silence unused-var complaints for test-only `mock` import if the bundler
// removes it — keep the import to preserve spy semantics.
void mock;
