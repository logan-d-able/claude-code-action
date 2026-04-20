/**
 * Unit tests for `synthesis-comment.ts` helpers.
 *
 * Covers the two comment shapes produced by `multi_agent_review: "auto"`:
 *   - `postTriageOnlyComment`  — posted when triage routes to single.
 *   - `createSynthesisComment` — posted when triage routes to multi; its body
 *     optionally embeds a triage line audit trail above the "Running..." text.
 *
 * Route verification ("when triage=single, runMultiAgentReview is not called")
 * lives in the run.ts integration flow itself — these tests lock down the
 * observable comment body format and GitHub API parameters at the helper
 * boundary, which is the public contract the routing depends on.
 */

import { describe, expect, it } from "bun:test";
import type { Octokits } from "../../../src/github/api/client";
import type { ParsedGitHubContext } from "../../../src/github/context";
import {
  createSynthesisComment,
  postTriageOnlyComment,
} from "../../../src/modes/review/synthesis-comment";

const SYNTHESIS_COMMENT_ID = 987_654_321;

function makeContext(): ParsedGitHubContext {
  return {
    runId: "run-1",
    eventName: "pull_request",
    eventAction: "opened",
    repository: {
      full_name: "acme/widgets",
      owner: "acme",
      repo: "widgets",
    },
    actor: "alice",
    payload: {
      action: "opened",
      pull_request: { number: 42 },
    } as any,
    entityNumber: 42,
    isPR: true,
    inputs: {
      prompt: "",
      triggerPhrase: "@claude",
      assigneeTrigger: "",
      labelTrigger: "",
      branchPrefix: "claude/",
      useStickyComment: false,
      classifyInlineComments: true,
      useCommitSigning: false,
      sshSigningKey: "",
      botId: "123",
      botName: "claude-bot",
      allowedBots: "",
      allowedNonWriteUsers: "",
      trackProgress: false,
      includeFixLinks: true,
      includeCommentsByActor: "",
      excludeCommentsByActor: "",
      multiAgentReview: "auto",
      reviewDebateRounds: "0",
    },
  };
}

function makeOctokit(): {
  octokit: Octokits;
  createCalls: Array<{
    owner: string;
    repo: string;
    issue_number: number;
    body: string;
  }>;
} {
  const createCalls: Array<{
    owner: string;
    repo: string;
    issue_number: number;
    body: string;
  }> = [];
  const octokit = {
    rest: {
      issues: {
        createComment: async (args: any) => {
          createCalls.push({
            owner: args.owner,
            repo: args.repo,
            issue_number: args.issue_number,
            body: args.body,
          });
          return { data: { id: SYNTHESIS_COMMENT_ID } };
        },
      },
    },
  } as unknown as Octokits;
  return { octokit, createCalls };
}

describe("postTriageOnlyComment", () => {
  it("posts a single comment with synthesis marker, triage line, and single-path footer", async () => {
    const { octokit, createCalls } = makeOctokit();
    const triageLine = "🔀 Triage: single — docs-only change, 12 lines";

    const commentId = await postTriageOnlyComment({
      octokit,
      context: makeContext(),
      triageLine,
    });

    expect(commentId).toBe(SYNTHESIS_COMMENT_ID);
    expect(createCalls).toHaveLength(1);

    const call = createCalls[0]!;
    expect(call.owner).toBe("acme");
    expect(call.repo).toBe("widgets");
    expect(call.issue_number).toBe(42);
    // Marker must be the first line so future sticky-comment reuse logic can
    // identify it as a synthesis-slot comment, not a regular tracking comment.
    expect(call.body.startsWith("## Multi-agent review")).toBe(true);
    expect(call.body).toContain(triageLine);
    expect(call.body).toContain(
      "_Single-agent review posted in the tracking comment above._",
    );
    // Body must not contain the running-workers text — this is the terminal
    // artifact for the single path.
    expect(call.body).not.toContain("Running");
    expect(call.body).not.toContain("reviewer agent");
  });
});

describe("createSynthesisComment", () => {
  it("embeds triage line above the running-workers text when provided", async () => {
    const { octokit, createCalls } = makeOctokit();
    const triageLine = "🔀 Triage: multi — security-sensitive diff";

    const commentId = await createSynthesisComment({
      octokit,
      context: makeContext(),
      agentCount: 3,
      triageLine,
    });

    expect(commentId).toBe(SYNTHESIS_COMMENT_ID);
    expect(createCalls).toHaveLength(1);

    const body = createCalls[0]!.body;
    expect(body.startsWith("## Multi-agent review")).toBe(true);
    expect(body).toContain(triageLine);
    expect(body).toContain("⏳ Running 3 reviewer agents...");
    // Triage line must appear before the running text, not after.
    expect(body.indexOf(triageLine)).toBeLessThan(body.indexOf("⏳ Running"));
  });

  it("omits the triage prefix when triageLine is not provided (forced multi path)", async () => {
    const { octokit, createCalls } = makeOctokit();

    await createSynthesisComment({
      octokit,
      context: makeContext(),
      agentCount: 1,
    });

    const body = createCalls[0]!.body;
    expect(body).not.toContain("🔀 Triage");
    expect(body).toContain("⏳ Running 1 reviewer agent...");
  });
});
