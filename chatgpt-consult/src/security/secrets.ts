export type SecretDecision = "allow" | "confirm" | "block";
export type SecretFindingKind = "private_key" | "provider_token" | "credential_assignment";

export interface SecretFinding {
  kind: SecretFindingKind;
  line: number;
  preview: string;
}

export interface SecretScan {
  decision: SecretDecision;
  findings: SecretFinding[];
}

type Pattern = {
  kind: SecretFindingKind;
  decision: Exclude<SecretDecision, "allow">;
  expression: RegExp;
  preview: string;
};

const patterns: Pattern[] = [
  {
    kind: "private_key",
    decision: "block",
    expression: /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/i,
    preview: "private key [REDACTED]",
  },
  {
    kind: "provider_token",
    decision: "block",
    expression: /\b(?:sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b/,
    preview: "provider token [REDACTED]",
  },
  {
    kind: "credential_assignment",
    decision: "confirm",
    expression: /^\s*(?:password|secret|token|api_key)\s*(?:=|:)\s*\S+/i,
    preview: "credential assignment [REDACTED]",
  },
];

const maxFindings = 20;

export const scanSecrets = (text: string): SecretScan => {
  const findings: SecretFinding[] = [];
  let decision: SecretDecision = "allow";

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    for (const pattern of patterns) {
      if (!pattern.expression.test(line)) continue;

      if (findings.length < maxFindings) {
        findings.push({ kind: pattern.kind, line: index + 1, preview: pattern.preview });
      }
      if (pattern.decision === "block") decision = "block";
      else if (decision === "allow") decision = "confirm";
    }
  }

  return { decision, findings };
};
