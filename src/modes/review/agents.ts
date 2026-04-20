/**
 * Multi-agent review: fixed reviewer definitions.
 *
 * v2 ships with three hardcoded perspectives. Custom agents are intentionally
 * omitted — they can be added later once the primary flow has shipped.
 */

export type ReviewAgent = {
  /** Stable machine id, used for execution/prompt file names. */
  id: string;
  /** Display name surfaced in synthesis output. */
  name: string;
  /** `appendSystemPrompt` body — narrows Claude's attention to this perspective. */
  perspective: string;
  /**
   * Exact allowlist this sub-agent is permitted to call. Must be read-only:
   * no MCP servers, no Edit/Write, no Bash. The orchestrator passes this set
   * verbatim to `--allowedTools`; callers do not inherit parent claudeArgs.
   */
  readonly tools: readonly string[];
};

/**
 * Agent ids are embedded in filesystem paths (execution and prompt files).
 * Keep the regex strict: lowercase alphanumerics and hyphens only, must start
 * with a letter, bounded length. This blocks `../` traversal by construction.
 */
const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export function isValidAgentId(id: string): boolean {
  return AGENT_ID_PATTERN.test(id);
}

export function assertValidAgentId(id: string): void {
  if (!isValidAgentId(id)) {
    throw new Error(
      `Invalid agent id: ${JSON.stringify(id)} (expected ${AGENT_ID_PATTERN})`,
    );
  }
}

const READ_ONLY_TOOLS = ["Glob", "Grep", "LS", "Read"];

export const DEFAULT_REVIEW_AGENTS: ReviewAgent[] = [
  {
    id: "correctness-reviewer",
    name: "Correctness Reviewer",
    perspective: [
      "You are the Correctness Reviewer on a multi-agent PR review team.",
      "Focus exclusively on logic bugs, incorrect assumptions, missed edge cases,",
      "off-by-one errors, race conditions, and any behavior that fails to satisfy",
      "the stated intent of the change. Ignore style, performance, and security",
      "unless they directly cause a correctness bug.",
    ].join(" "),
    tools: [...READ_ONLY_TOOLS],
  },
  {
    id: "security-reviewer",
    name: "Security Reviewer",
    perspective: [
      "You are the Security Reviewer on a multi-agent PR review team.",
      "Focus on authentication, authorization, injection vectors (SQLi, XSS,",
      "command injection, SSRF), unsafe deserialization, secrets exposure, unsafe",
      "default configurations, privilege escalation, and supply-chain risk.",
      "Ignore correctness and style issues unless they have security impact.",
    ].join(" "),
    tools: [...READ_ONLY_TOOLS],
  },
  {
    id: "quality-reviewer",
    name: "Quality Reviewer",
    perspective: [
      "You are the Quality Reviewer on a multi-agent PR review team.",
      "Focus on maintainability, readability, naming, abstraction boundaries,",
      "test coverage gaps, dead code, and violations of the project's conventions.",
      "Ignore correctness bugs and security issues — those are owned by other",
      "reviewers. Flag only issues that matter for long-term health of the code.",
    ].join(" "),
    tools: [...READ_ONLY_TOOLS],
  },
];

// Validate at module load — catches typos that would only surface mid-run.
for (const agent of DEFAULT_REVIEW_AGENTS) {
  assertValidAgentId(agent.id);
}
