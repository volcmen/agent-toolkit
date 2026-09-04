import type { CallToolResult, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { ConsultError, type ConsultErrorCode } from "../core/errors";

const safeMessages: Record<ConsultErrorCode, string> = {
  INVALID_INPUT: "The request is invalid.",
  NOT_FOUND: "The consultation was not found.",
  CONFLICT: "The consultation cannot be changed in its current state.",
  EXPIRED: "The consultation has expired.",
  FORBIDDEN_PATH: "The requested project path is not allowed.",
  SENSITIVE_CONTENT: "Sensitive content requires explicit approval.",
  BUDGET_EXCEEDED: "The consultation budget was exceeded.",
  UNAVAILABLE: "The operation is unavailable.",
  CORRUPT_STATE: "The consultation state could not be read safely.",
  INTERNAL: "The operation failed.",
};

const MAX_REPORTED_ISSUES = 5;
const MAX_ISSUE_KEYS = 5;
const MAX_ISSUE_LABEL_LENGTH = 100;

const issuePath = (issue: z.core.$ZodIssue): string =>
  issue.path.length ? issue.path.map(String).join(".") : "(root)";

const issueLabel = (issue: z.core.$ZodIssue): string => {
  const path = issuePath(issue);
  if (issue.code === "unrecognized_keys") {
    const shownKeys = issue.keys.slice(0, MAX_ISSUE_KEYS);
    const remainingKeys = issue.keys.length - shownKeys.length;
    const keyList = shownKeys.map((key) => compactText(key, 40)).join(", ");
    const keySuffix = remainingKeys > 0 ? `, +${remainingKeys} more` : "";
    return `${path}: unrecognized_keys [${keyList}${keySuffix}]`;
  }
  return `${path}: ${issue.code}`;
};

const describeValidationIssues = (issues: readonly z.core.$ZodIssue[]): string => {
  const shown = issues.slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => compactText(issueLabel(issue), MAX_ISSUE_LABEL_LENGTH));
  const remaining = issues.length - shown.length;
  const suffix = remaining > 0 ? ` (+${remaining} more)` : "";
  return `${safeMessages.INVALID_INPUT} ${shown.join("; ")}${suffix}`;
};

export const compactText = (value: string, limit = 240): string => {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
};

export const browserRecoveryInstruction = (
  phase: string | undefined,
  submissionCertainty?: "not_submitted" | "submitted" | "uncertain",
): string | null => {
  if (phase === "needs_login") {
    return "No browser worker is running for this request; it will not resume on its own. "
      + "Run setup browser, sign in directly, then run open or poll consult_status.";
  }
  if (phase === "needs_manual") {
    if (submissionCertainty === "uncertain") {
      return "No browser worker is running for this request; it will not resume on its own. "
        + "Use manual handoff/import-result for recovery.";
    }
    return "No browser worker is running for this request; it will not resume on its own. "
      + "Run open to resume automatically, then poll consult_status; "
      + "if that does not help, use manual handoff/import-result.";
  }
  return null;
};

export const handlerValidatedInput = <Schema extends z.ZodType>(
  schema: Schema,
): StandardSchemaWithJSON<unknown, unknown> => {
  const inner = schema["~standard"] as typeof schema["~standard"] &
    StandardSchemaWithJSON<unknown, z.output<Schema>>["~standard"];
  return {
    "~standard": {
      version: 1,
      vendor: "chatgpt-consult",
      validate: (value) => ({ value }),
      jsonSchema: inner.jsonSchema,
    },
  };
};

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const treatExplicitNullAsAbsent = (value: unknown): unknown => {
  if (!isPlainRecord(value)) return value;
  const normalized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    normalized[key] = entry === null ? undefined : entry;
  }
  return normalized;
};

export const parseToolInput = <Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): z.output<Schema> => {
  const parsed = schema.safeParse(treatExplicitNullAsAbsent(value));
  if (!parsed.success) {
    throw new ConsultError("INVALID_INPUT", describeValidationIssues(parsed.error.issues));
  }
  return parsed.data;
};

export const successResult = <Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  summarize: (normalized: z.output<Schema>) => string,
): CallToolResult => {
  const normalized = schema.parse(value);
  return {
    content: [{ type: "text", text: summarize(normalized) }],
    structuredContent: normalized,
  };
};

export const errorResult = (error: unknown): CallToolResult => {
  const code: ConsultErrorCode = error instanceof ConsultError ? error.code : "INTERNAL";
  const message = code === "INVALID_INPUT" && error instanceof ConsultError
    ? error.message
    : safeMessages[code];
  return {
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent: { error: { code, message } },
    isError: true,
  };
};

export const runTool = async (action: () => Promise<CallToolResult>): Promise<CallToolResult> => {
  try {
    return await action();
  } catch (error) {
    return errorResult(error);
  }
};
