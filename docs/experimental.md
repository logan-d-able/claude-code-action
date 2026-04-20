# Experimental Features

**Note:** Experimental features are considered unstable and not supported for production use. They may change or be removed at any time.

## Automatic Mode Detection

The action intelligently detects the appropriate execution mode based on your workflow context, eliminating the need for manual mode configuration.

### Interactive Mode (Tag Mode)

Activated when Claude detects @mentions, issue assignments, or labels—without an explicit `prompt`.

- **Triggers**: `@claude` mentions in comments, issue assignment to claude user, label application
- **Features**: Creates tracking comments with progress checkboxes, full implementation capabilities
- **Use case**: Interactive code assistance, Q&A, and implementation requests

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    # No prompt needed - responds to @claude mentions
```

### Automation Mode (Agent Mode)

Automatically activated when you provide a `prompt` input.

- **Triggers**: Any GitHub event when `prompt` input is provided
- **Features**: Direct execution without requiring @claude mentions, streamlined for automation
- **Use case**: Automated PR reviews, scheduled tasks, workflow automation

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    prompt: |
      Check for outdated dependencies and create an issue if any are found.
    # Automatically runs in agent mode when prompt is provided
```

### How It Works

The action uses this logic to determine the mode:

1. **If `prompt` is provided** → Runs in **agent mode** for automation
2. **If no `prompt` but @claude is mentioned** → Runs in **tag mode** for interaction
3. **If neither** → No action is taken

This automatic detection ensures your workflows are simpler and more intuitive, without needing to understand or configure different modes.

### Advanced Mode Control

For specialized use cases, you can fine-tune behavior using `claude_args`:

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    prompt: "Review this PR"
    claude_args: |
      --max-turns 20
      --system-prompt "You are a code review specialist"
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Multi-Agent PR Review

Opt-in parallel-reviewer pipeline that runs alongside tag mode on `pull_request` events. When enabled, three specialized reviewers (correctness, security, quality) produce findings in parallel, optionally debate, and a synthesis agent posts a single consolidated comment.

Controlled by the `multi_agent_review` input:

| Value   | Behavior                                                        |
| ------- | --------------------------------------------------------------- |
| `false` | Disabled. Standard single-agent tag review (default).           |
| `true`  | Always runs the full multi-agent pipeline on every eligible PR. |
| `auto`  | Triage-based routing — see below.                               |

Invalid values are coerced to `false` with a warning at parse time.

### Triage-Based Auto-Routing

`multi_agent_review: auto` runs a lightweight triage sub-agent before spending the full multi-agent budget. The triage agent reads the same PR context as the reviewers, has **zero tools**, and returns a structured `{decision, reason}` JSON payload:

- `decision: "multi"` → full pipeline (reviewers + optional debate + synthesis).
- `decision: "single"` → standard single-agent review; reviewers and synthesis are skipped.

Intent: pay the multi-agent cost only on PRs that warrant it (security-sensitive paths, migrations, large diffs) and fall through to the cheap path for docs-only, test-only, or trivial changes.

#### Behavior

- **Model** is inherited from the same `ANTHROPIC_MODEL` used by the reviewer workers — configure once for the whole review flow.
- **Failure → single.** Any triage failure (SDK timeout, missing structured output, schema violation) falls back to single-agent review. Triage errors never take down the PR review.
- **Audit trail.** The triage decision is surfaced as a one-line prefix on the synthesis comment (or a dedicated terminal comment on the single path), so you can always see how a PR was routed:
  ```
  🔀 Triage: single — docs-only diff, 12 lines changed
  ```
- **`review_debate_rounds` on the single path** is ignored with a `console.warn` — debate requires multiple reviewer agents.
- **Anti-injection.** Triage ignores routing instructions embedded in the PR body/comments. The worst-case injection outcome is "multi → single" (quality degradation, never privilege escalation), since triage has no tools.

#### Example

```yaml
- uses: anthropics/claude-code-action@v1
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    multi_agent_review: auto
    review_debate_rounds: "1"
```
