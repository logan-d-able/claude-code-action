import { describe, expect, it } from "bun:test";
import {
  AGENT_FINDINGS_SCHEMA,
  AGENT_REBUTTAL_SCHEMA,
  validateStructuredOutput,
  type AgentFindings,
  type AgentRebuttal,
} from "../../../src/modes/review/schemas";

describe("validateStructuredOutput", () => {
  const requiredFindings = [
    "agent_id",
    "agent_name",
    "summary",
    "findings",
  ] as const;

  it("parses and returns a valid findings object", () => {
    const raw = JSON.stringify({
      agent_id: "correctness-reviewer",
      agent_name: "Correctness",
      summary: "Looks good",
      findings: [
        {
          severity: "major",
          title: "Null deref",
          description: "arr[0] before length check",
          file: "src/x.ts",
          line: 42,
        },
      ],
    });

    const out = validateStructuredOutput<AgentFindings>(
      raw,
      requiredFindings,
      "test",
    );
    expect(out.agent_id).toBe("correctness-reviewer");
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.severity).toBe("major");
  });

  it("throws when JSON is malformed", () => {
    expect(() =>
      validateStructuredOutput("{not json", requiredFindings, "test"),
    ).toThrow(/not valid JSON/);
  });

  it("throws when JSON is not an object", () => {
    expect(() =>
      validateStructuredOutput("[]", requiredFindings, "test"),
    ).toThrow(/not a JSON object/);
    expect(() =>
      validateStructuredOutput('"str"', requiredFindings, "test"),
    ).toThrow(/not a JSON object/);
    expect(() =>
      validateStructuredOutput("null", requiredFindings, "test"),
    ).toThrow(/not a JSON object/);
  });

  it("throws when a required field is missing", () => {
    const raw = JSON.stringify({
      agent_id: "x",
      agent_name: "X",
      summary: "S",
      // findings missing
    });
    expect(() =>
      validateStructuredOutput(raw, requiredFindings, "agent-x"),
    ).toThrow(/agent-x: missing required field "findings"/);
  });

  it("passes through extra fields unchanged", () => {
    const raw = JSON.stringify({
      agent_id: "a",
      agent_name: "A",
      summary: "s",
      findings: [],
      overall_assessment: "optional",
      unknown: "kept",
    });
    const out = validateStructuredOutput<AgentFindings & { unknown: string }>(
      raw,
      requiredFindings,
      "t",
    );
    expect(out.overall_assessment).toBe("optional");
    expect(out.unknown).toBe("kept");
  });

  it("validates rebuttal shape via requiredFields", () => {
    const raw = JSON.stringify({
      agent_id: "a",
      agent_name: "A",
      responses: [
        {
          regarding_finding_title: "X",
          stance: "agree",
          reasoning: "because",
        },
      ],
    });
    const out = validateStructuredOutput<AgentRebuttal>(
      raw,
      ["agent_id", "agent_name", "responses"],
      "r",
    );
    expect(out.responses[0]?.stance).toBe("agree");
  });
});

describe("AGENT_FINDINGS_SCHEMA", () => {
  it("declares a strict severity enum", () => {
    const severityProp =
      AGENT_FINDINGS_SCHEMA.properties.findings.items.properties.severity;
    expect(severityProp.enum).toEqual(["critical", "major", "minor", "nit"]);
  });

  it("marks the top-level required fields", () => {
    expect(AGENT_FINDINGS_SCHEMA.required).toEqual([
      "agent_id",
      "agent_name",
      "summary",
      "findings",
    ]);
  });
});

describe("AGENT_REBUTTAL_SCHEMA", () => {
  it("declares a strict stance enum", () => {
    const stanceProp =
      AGENT_REBUTTAL_SCHEMA.properties.responses.items.properties.stance;
    expect(stanceProp.enum).toEqual(["agree", "disagree", "partial"]);
  });
});
