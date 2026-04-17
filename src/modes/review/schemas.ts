/**
 * JSON Schemas + validators for structured output produced by review agents.
 *
 * Claude's Agent SDK enforces the schema at the provider boundary, so by the
 * time `structured_output` reaches us it has already been coerced into the
 * declared shape. The runtime checks here are defense-in-depth against drift,
 * partial failures, or future schema changes.
 */

export type FindingSeverity = "critical" | "major" | "minor" | "nit";

export type AgentFinding = {
  severity: FindingSeverity;
  title: string;
  description: string;
  file?: string;
  line?: number;
};

export type AgentFindings = {
  agent_id: string;
  agent_name: string;
  summary: string;
  findings: AgentFinding[];
  overall_assessment?: string;
};

export type RebuttalStance = "agree" | "disagree" | "partial";

export type AgentRebuttalEntry = {
  regarding_finding_title: string;
  stance: RebuttalStance;
  reasoning: string;
};

export type AgentRebuttal = {
  agent_id: string;
  agent_name: string;
  responses: AgentRebuttalEntry[];
};

export const AGENT_FINDINGS_SCHEMA = {
  type: "object",
  required: ["agent_id", "agent_name", "summary", "findings"],
  properties: {
    agent_id: { type: "string" },
    agent_name: { type: "string" },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "title", "description"],
        properties: {
          severity: {
            type: "string",
            enum: ["critical", "major", "minor", "nit"],
          },
          title: { type: "string" },
          description: { type: "string" },
          file: { type: "string" },
          line: { type: "number" },
        },
      },
    },
    overall_assessment: { type: "string" },
  },
} as const;

export const AGENT_REBUTTAL_SCHEMA = {
  type: "object",
  required: ["agent_id", "agent_name", "responses"],
  properties: {
    agent_id: { type: "string" },
    agent_name: { type: "string" },
    responses: {
      type: "array",
      items: {
        type: "object",
        required: ["regarding_finding_title", "stance", "reasoning"],
        properties: {
          regarding_finding_title: { type: "string" },
          stance: {
            type: "string",
            enum: ["agree", "disagree", "partial"],
          },
          reasoning: { type: "string" },
        },
      },
    },
  },
} as const;

/**
 * Parse structured output JSON and verify required top-level fields exist.
 * Returns the parsed object typed as T on success.
 *
 * @throws Error if JSON parsing fails or any required field is missing
 */
export function validateStructuredOutput<T extends Record<string, unknown>>(
  raw: string,
  requiredFields: ReadonlyArray<keyof T & string>,
  label: string,
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${label}: structured output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label}: structured output is not a JSON object`);
  }

  const obj = parsed as Record<string, unknown>;
  for (const field of requiredFields) {
    if (!(field in obj)) {
      throw new Error(`${label}: missing required field "${field}"`);
    }
  }

  return obj as T;
}
