import { sanitizeContent } from "../../github/utils/sanitizer";
import type { AgentFindings, AgentRebuttal } from "./schemas";

export function sanitizeFindings(f: AgentFindings): AgentFindings {
  return {
    agent_id: sanitizeContent(f.agent_id),
    agent_name: sanitizeContent(f.agent_name),
    summary: sanitizeContent(f.summary),
    overall_assessment:
      f.overall_assessment !== undefined
        ? sanitizeContent(f.overall_assessment)
        : undefined,
    findings: f.findings.map((item) => ({
      severity: item.severity,
      title: sanitizeContent(item.title),
      description: sanitizeContent(item.description),
      file: item.file !== undefined ? sanitizeContent(item.file) : undefined,
      line: item.line,
    })),
  };
}

export function sanitizeRebuttal(r: AgentRebuttal): AgentRebuttal {
  return {
    agent_id: sanitizeContent(r.agent_id),
    agent_name: sanitizeContent(r.agent_name),
    responses: r.responses.map((x) => ({
      regarding_finding_title: sanitizeContent(x.regarding_finding_title),
      stance: x.stance,
      reasoning: sanitizeContent(x.reasoning),
    })),
  };
}
