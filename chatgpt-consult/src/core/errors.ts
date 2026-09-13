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

export class ConversationBusyError extends ConsultError {
  constructor(public readonly requestId: string) {
    if (!/^[a-f0-9]{32}$/.test(requestId)) throw new TypeError("Invalid busy conversation request ID");
    super("CONFLICT", `This conversation is busy; wait for consultation ${requestId} or use a new chat`, { requestId });
  }
}
