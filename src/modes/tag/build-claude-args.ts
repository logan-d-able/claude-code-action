import { prepareMcpConfig } from "../../mcp/install-mcp-server";
import type { GitHubContext } from "../../github/context";
import { parseAllowedTools } from "../agent/parse-tools";

export type BuildTagModeClaudeArgsParams = {
  context: GitHubContext;
  githubToken: string;
  branchInfo: {
    claudeBranch?: string;
    baseBranch: string;
    currentBranch: string;
  };
  claudeCommentId: string;
  /**
   * Additional tools to merge into the tag-mode allowlist. Used by the
   * multi-agent review synthesis agent to request the inline-comment MCP
   * tool, which tag mode itself does not need.
   */
  extraTools?: ReadonlyArray<string>;
};

export type BuildTagModeClaudeArgsResult = {
  claudeArgs: string;
  mcpConfig: string;
};

export async function buildTagModeClaudeArgs({
  context,
  githubToken,
  branchInfo,
  claudeCommentId,
  extraTools,
}: BuildTagModeClaudeArgsParams): Promise<BuildTagModeClaudeArgsResult> {
  const userClaudeArgs = process.env.CLAUDE_ARGS || "";
  const userAllowedMCPTools = parseAllowedTools(userClaudeArgs).filter((tool) =>
    tool.startsWith("mcp__github_"),
  );

  const gitPushWrapper = `${process.env.GITHUB_ACTION_PATH}/scripts/git-push.sh`;

  const useSshSigning = !!context.inputs.sshSigningKey;
  const useApiCommitSigning = context.inputs.useCommitSigning && !useSshSigning;

  // Build claude_args for tag mode with required tools.
  // Edit/MultiEdit/Write are intentionally omitted: acceptEdits permission mode (set below)
  // auto-allows file edits inside $GITHUB_WORKSPACE and denies writes outside (e.g. ~/.bashrc).
  // Listing them here would grant blanket write access to the whole runner (Asana 1213310082312048).
  const tagModeTools = [
    "Glob",
    "Grep",
    "LS",
    "Read",
    "mcp__github_comment__update_claude_comment",
    "mcp__github_ci__get_ci_status",
    "mcp__github_ci__get_workflow_run_details",
    "mcp__github_ci__download_job_log",
    ...userAllowedMCPTools,
    ...(extraTools ?? []),
  ];

  // Add git commands when using git CLI (no API commit signing, or SSH signing)
  // SSH signing still uses git CLI, just with signing enabled
  if (!useApiCommitSigning) {
    tagModeTools.push(
      "Bash(git add:*)",
      "Bash(git commit:*)",
      `Bash(${gitPushWrapper}:*)`,
      "Bash(git rm:*)",
    );
  } else {
    // When using API commit signing, use MCP file ops tools
    tagModeTools.push(
      "mcp__github_file_ops__commit_files",
      "mcp__github_file_ops__delete_files",
    );
  }

  // Get our GitHub MCP servers configuration
  const ourMcpConfig = await prepareMcpConfig({
    githubToken,
    owner: context.repository.owner,
    repo: context.repository.repo,
    branch: branchInfo.claudeBranch || branchInfo.currentBranch,
    baseBranch: branchInfo.baseBranch,
    claudeCommentId,
    allowedTools: Array.from(new Set(tagModeTools)),
    mode: "tag",
    context,
  });

  // Build complete claude_args with multiple --mcp-config flags
  let claudeArgs = "";

  // Add our GitHub servers config
  const escapedOurConfig = ourMcpConfig.replace(/'/g, "'\\''");
  claudeArgs = `--mcp-config '${escapedOurConfig}'`;

  // Add required tools for tag mode.
  // acceptEdits: file edits auto-allowed inside cwd ($GITHUB_WORKSPACE), denied outside.
  // Headless SDK has no prompt handler, so anything that falls through to "ask" is denied.
  claudeArgs += ` --permission-mode acceptEdits --allowedTools "${tagModeTools.join(",")}"`;

  // Append user's claude_args (which may have more --mcp-config flags)
  if (userClaudeArgs) {
    claudeArgs += ` ${userClaudeArgs}`;
  }

  return {
    claudeArgs: claudeArgs.trim(),
    mcpConfig: ourMcpConfig,
  };
}
