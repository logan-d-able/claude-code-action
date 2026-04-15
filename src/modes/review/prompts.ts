import { writeFile, mkdir } from "fs/promises";
import type { ReviewAgent } from "./agents";
import type { AgentFindings, AgentRebuttal } from "./schemas";
import { AGENT_FINDINGS_SCHEMA, AGENT_REBUTTAL_SCHEMA } from "./schemas";

const PROMPT_DIR = `${process.env.RUNNER_TEMP || "/tmp"}/claude-prompts`;

function formatFindingsForContext(allFindings: AgentFindings[]): string {
  if (allFindings.length === 0) return "";

  const sections = allFindings.map((f) => {
    const findingLines = f.findings
      .map(
        (finding) =>
          `  - [${finding.severity.toUpperCase()}] ${finding.title}: ${finding.description}${
            finding.file
              ? ` (${finding.file}${finding.line ? `:${finding.line}` : ""})`
              : ""
          }`,
      )
      .join("\n");

    return `### ${f.agent_name} (${f.agent_id})
Summary: ${f.summary}
${f.overall_assessment ? `Overall: ${f.overall_assessment}` : ""}
Findings:
${findingLines}`;
  });

  return sections.join("\n\n");
}

function formatRebuttalsForContext(allRebuttals: AgentRebuttal[]): string {
  if (allRebuttals.length === 0) return "";

  const sections = allRebuttals.map((r) => {
    const responseLines = r.responses
      .map(
        (resp) =>
          `  - Re: ${resp.regarding_agent_id}/${resp.regarding_finding_title} → ${resp.stance}: ${resp.reasoning}`,
      )
      .join("\n");

    return `### ${r.agent_name} (${r.agent_id}) Debate Responses
${responseLines}`;
  });

  return sections.join("\n\n");
}

export async function generateAgentPrompt(
  agent: ReviewAgent,
  githubContextMarkdown: string,
): Promise<string> {
  await mkdir(PROMPT_DIR, { recursive: true });

  const prompt = `${agent.perspective}

You are reviewing a Pull Request. Analyze the changes carefully from your specific perspective.

${githubContextMarkdown}

## Instructions

1. Read the PR diff and understand the changes
2. Analyze from your specific review perspective described above
3. Report your findings as structured JSON output

Focus on actionable, specific findings. Reference exact files and line numbers where possible.
Do NOT report issues that are clearly intentional design decisions unless they are genuinely problematic.
Prioritize findings by severity: critical issues first, then warnings, suggestions, and nitpicks last.`;

  const promptPath = `${PROMPT_DIR}/review-agent-${agent.id}.txt`;
  await writeFile(promptPath, prompt);
  return promptPath;
}

export async function generateDebatePrompt(
  agent: ReviewAgent,
  ownFindings: AgentFindings,
  otherFindings: AgentFindings[],
): Promise<string> {
  await mkdir(PROMPT_DIR, { recursive: true });

  const othersContext = formatFindingsForContext(otherFindings);

  const prompt = `${agent.perspective}

You previously reviewed this PR and produced the following findings:

### Your Previous Findings (${ownFindings.agent_id})
Summary: ${ownFindings.summary}
${ownFindings.findings.map((f) => `  - [${f.severity.toUpperCase()}] ${f.title}: ${f.description}`).join("\n")}

## Other Reviewers' Findings

${othersContext}

## Instructions

Review the other agents' findings and provide your responses:
1. For each finding from other reviewers, state whether you agree, disagree, partially agree, or want to supplement
2. Provide reasoning for your stance
3. If you have revised or new findings based on what others found, include them

Be constructive and specific. If you disagree, explain why with concrete reasoning.`;

  const promptPath = `${PROMPT_DIR}/review-debate-${agent.id}.txt`;
  await writeFile(promptPath, prompt);
  return promptPath;
}

export async function generateSynthesisPrompt(
  synthesisPerspective: string,
  allFindings: AgentFindings[],
  allRebuttals: AgentRebuttal[],
): Promise<string> {
  await mkdir(PROMPT_DIR, { recursive: true });

  const findingsContext = formatFindingsForContext(allFindings);
  const rebuttalsContext = formatRebuttalsForContext(allRebuttals);

  const prompt = `${synthesisPerspective}

## All Agent Findings

${findingsContext}

${
  rebuttalsContext
    ? `## Debate Round Results

${rebuttalsContext}`
    : ""
}

## Instructions

Synthesize all findings into a final, comprehensive review comment for the PR.

Format the output as a well-structured markdown comment suitable for posting on GitHub.
Include:
1. An executive summary (1-2 sentences)
2. Critical issues that must be addressed (if any)
3. Warnings and suggestions grouped by theme
4. A final verdict: whether the PR is ready to merge, needs changes, or needs discussion

Do NOT use structured JSON output for this step — write a natural markdown review comment.
Reference specific files and line numbers from the findings.
Where reviewers disagreed, note the disagreement and provide your assessment.`;

  const promptPath = `${PROMPT_DIR}/review-synthesis.txt`;
  await writeFile(promptPath, prompt);
  return promptPath;
}

export function buildAgentClaudeArgs(
  baseClaudeArgs: string,
  schema: typeof AGENT_FINDINGS_SCHEMA | typeof AGENT_REBUTTAL_SCHEMA,
): string {
  const schemaJson = JSON.stringify(schema).replace(/'/g, "'\\''");
  return `${baseClaudeArgs} --json-schema '${schemaJson}'`.trim();
}
