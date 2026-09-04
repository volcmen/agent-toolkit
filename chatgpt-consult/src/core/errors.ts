export type ConsultErrorCode =
  | "INVALID_INPUT" | "NOT_FOUND" | "CONFLICT" | "EXPIRED"
  | "FORBIDDEN_PATH" | "SENSITIVE_CONTENT" | "BUDGET_EXCEEDED"
  | "UNAVAILABLE" | "CORRUPT_STATE" | "INTERNAL";

export class ConsultError extends Error {
  constructor(
    public readonly code: ConsultErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ConsultError";
  }
}
