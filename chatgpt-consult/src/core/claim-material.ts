import { createHash } from "node:crypto";
import type { ConsultationCompletion } from "./schema";

const CLAIM_TOKEN_LENGTH = 43;
const MAX_CANDIDATE_WINDOWS = 4_096;
const BASE64URL_RUN = /[A-Za-z0-9_-]{43,}/g;
const REDACTED_CLAIM = "[REDACTED CLAIM]";
const REDACTED_RUN = "[REDACTED BASE64URL RUN]";

export type ClaimMaterialDecision = "clean" | "claim" | "pathological";

interface CandidateBudget {
  remaining: number;
  decision: ClaimMaterialDecision;
}

const verifierFor = (candidate: string): string =>
  createHash("sha256").update(candidate).digest("hex");

const inspectText = (
  value: string,
  claimHash: string | null,
  budget: CandidateBudget,
): void => {
  if (!claimHash || budget.decision !== "clean") return;
  for (const match of value.matchAll(BASE64URL_RUN)) {
    const run = match[0];
    const windows = run.length - CLAIM_TOKEN_LENGTH + 1;
    if (windows > budget.remaining) {
      budget.decision = "pathological";
      budget.remaining = 0;
      return;
    }
    budget.remaining -= windows;
    for (let offset = 0; offset < windows; offset += 1) {
      if (verifierFor(run.slice(offset, offset + CLAIM_TOKEN_LENGTH)) === claimHash) {
        budget.decision = "claim";
        return;
      }
    }
  }
};

const completionValues = (value: ConsultationCompletion): string[] => [
  value.summary,
  value.answer,
  ...value.evidence,
  ...value.assumptions,
  ...value.risks,
  ...value.recommendations,
  ...value.followUpQuestions,
];

export const inspectCompletionClaimMaterial = (
  value: ConsultationCompletion,
  claimHash: string | null,
): ClaimMaterialDecision => {
  const budget: CandidateBudget = {
    remaining: MAX_CANDIDATE_WINDOWS,
    decision: "clean",
  };
  for (const text of completionValues(value)) inspectText(text, claimHash, budget);
  return budget.decision;
};

export const inspectTextClaimMaterial = (
  value: string,
  claimHash: string | null,
): ClaimMaterialDecision => {
  const budget: CandidateBudget = {
    remaining: MAX_CANDIDATE_WINDOWS,
    decision: "clean",
  };
  inspectText(value, claimHash, budget);
  return budget.decision;
};

const redactText = (
  value: string,
  claimHash: string | null,
  budget: CandidateBudget,
): string => {
  if (!claimHash) return value;
  return value.replace(BASE64URL_RUN, (run) => {
    const windows = run.length - CLAIM_TOKEN_LENGTH + 1;
    if (windows > budget.remaining) {
      budget.remaining = 0;
      budget.decision = "pathological";
      return REDACTED_RUN;
    }
    budget.remaining -= windows;
    const matches: number[] = [];
    for (let offset = 0; offset < windows; offset += 1) {
      if (verifierFor(run.slice(offset, offset + CLAIM_TOKEN_LENGTH)) === claimHash) {
        matches.push(offset);
      }
    }
    if (matches.length === 0) return run;
    budget.decision = "claim";
    let output = "";
    let cursor = 0;
    for (const offset of matches) {
      if (offset < cursor) continue;
      output += run.slice(cursor, offset);
      output += REDACTED_CLAIM;
      cursor = offset + CLAIM_TOKEN_LENGTH;
    }
    return output + run.slice(cursor);
  });
};

export const redactTextClaimMaterial = (
  value: string,
  claimHash: string | null,
): string => {
  const budget: CandidateBudget = {
    remaining: MAX_CANDIDATE_WINDOWS,
    decision: "clean",
  };
  return redactText(value, claimHash, budget);
};

export const redactCompletionClaimMaterial = (
  value: ConsultationCompletion,
  claimHash: string | null,
): ConsultationCompletion => {
  const budget: CandidateBudget = {
    remaining: MAX_CANDIDATE_WINDOWS,
    decision: "clean",
  };
  return {
    summary: redactText(value.summary, claimHash, budget),
    answer: redactText(value.answer, claimHash, budget),
    evidence: value.evidence.map((entry) => redactText(entry, claimHash, budget)),
    assumptions: value.assumptions.map((entry) => redactText(entry, claimHash, budget)),
    risks: value.risks.map((entry) => redactText(entry, claimHash, budget)),
    recommendations: value.recommendations.map((entry) => redactText(entry, claimHash, budget)),
    followUpQuestions: value.followUpQuestions.map((entry) => redactText(entry, claimHash, budget)),
  };
};
