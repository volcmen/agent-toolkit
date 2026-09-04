import type { JsonEnvelope } from "../core/schema";
import type { ChatgptSetupGuidance, SetupClientsResult } from "./setup";
import type { DoctorResult } from "./doctor";
import type { BrowserSetupResult } from "../browser/runtime";

export const successEnvelope = (data: unknown): JsonEnvelope => ({
  schemaVersion: 1,
  ok: true,
  data,
});

export const errorEnvelope = (
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): JsonEnvelope => ({
  schemaVersion: 1,
  ok: false,
  error: { code, message, details },
});

const quoteArgv = (argv: readonly string[]): string => argv.map((token) => JSON.stringify(token)).join(" ");

const renderClientSetup = (data: SetupClientsResult): string => {
  const lines = [`Client setup (${data.mode})`];
  for (const client of data.clients) {
    lines.push(`${client.client}\t${client.status}\t${client.action}\t${client.message}`);
    if (client.removeArgv) lines.push(`  remove: ${quoteArgv(client.removeArgv)}`);
    if (client.addArgv) lines.push(`  add: ${quoteArgv(client.addArgv)}`);
  }
  return lines.join("\n");
};

const renderChatgptSetup = (data: ChatgptSetupGuidance): string => [
  "ChatGPT browser setup (recommended)",
  `Initialize: ${data.recommended.initCommand}`,
  `Clients: ${data.recommended.clientsCommand}`,
  `Browser: ${data.recommended.browserCommand}`,
  `Doctor: ${data.recommended.doctorCommand}`,
  `Start: ${data.recommended.startCommand}`,
  "",
  ...data.recommended.steps.map((step, index) => `${index + 1}. ${step}`),
  "",
  "Manual fallback:",
  `- ${data.manualFallback.handoff}`,
  `- ${data.manualFallback.importResult}`,
  "",
  "Legacy/optional compatibility (never started automatically):",
  `- Start: ${data.legacyCompatibility.startCommand}`,
  `- Health URL: ${data.legacyCompatibility.healthUrl}`,
  `- MCP URL: ${data.legacyCompatibility.mcpUrl}`,
  `- Verify: ${data.legacyCompatibility.healthCommand}`,
  `- Secure MCP Tunnel guide: ${data.legacyCompatibility.tunnelDocumentationUrl}`,
  "- Remote compatibility tools:",
  ...data.legacyCompatibility.requiredTools.map((tool) => `  - ${tool}`),
].join("\n");

const renderDoctor = (data: DoctorResult): string => {
  const lines = ["STATUS\tCHECK\tMESSAGE"];
  for (const check of data.checks) {
    lines.push(`${check.status.toUpperCase()}\t${check.name}\t${check.message}`);
    if (check.fix) lines.push(`  Fix: ${check.fix}`);
  }
  return lines.join("\n");
};

const renderBrowserSetup = (data: BrowserSetupResult): string => {
  const browser = data.mode === "managed"
    ? "headed managed browser"
    : "external browser session";
  return [
    `Browser setup (${data.mode})`,
    data.opened
      ? `The configured ChatGPT Project was opened in the ${browser}.`
      : `The ${browser} is available, but configured Project navigation was not confirmed.`,
    "Sign in directly on ChatGPT and complete any account challenge there.",
    "Then rerun the consultation, run open <request-id>, or allow its active worker to continue.",
  ].join("\n");
};

const nextAction = (state: string, browser?: Record<string, unknown>): string => {
  if (browser?.phase === "needs_login") return "Run setup browser, sign in directly, then run open for this request.";
  if (browser?.phase === "needs_manual") return "Use handoff and import-result for manual recovery.";
  if (["queued", "preparing", "awaiting_browser", "awaiting_response"].includes(String(browser?.phase))) {
    return "Poll status while automatic browser work continues.";
  }
  if (state === "pending") return "Give the handoff to ChatGPT or run open.";
  if (state === "claimed") return "Wait for ChatGPT to complete the request.";
  if (state === "completed") return "Review the result or publish it explicitly.";
  if (state === "cancelled") return "Start a new request if consultation is still needed.";
  return "Start a new request.";
};

export const renderHuman = (command: string, data: unknown): string => {
  const value = data as Record<string, unknown>;
  if (command === "setup") {
    if (value.kind === "clients") return renderClientSetup(data as SetupClientsResult);
    if (value.kind === "browser") return renderBrowserSetup(data as BrowserSetupResult);
    return renderChatgptSetup(data as ChatgptSetupGuidance);
  }
  if (command === "doctor") return renderDoctor(data as DoctorResult);
  if (command === "init") {
    return [
      "Initialized ChatGPT Consult.",
      `State: ${String(value.stateDir)}`,
      ...(value.configPath ? [`Config: ${String(value.configPath)}`] : []),
    ].join("\n");
  }
  if (command === "list") {
    const rows = data as Array<Record<string, unknown>>;
    return rows.length === 0
      ? "No consultations."
      : rows.map((row) => `${String(row.requestId)}\t${String(row.state)}\t${String(row.goal)}`).join("\n");
  }
  if (command === "publish") return `Published: ${String(value.path)}`;
  if (command === "handoff") {
    return [
      `Manual bundle: ${String(value.path)}`,
      "Next: Give the bundle to ChatGPT, save the completion as JSON, then run import-result.",
    ].join("\n");
  }
  const lines = [
    `Request: ${String(value.requestId)}`,
    `State: ${String(value.state)}`,
    `Next: ${nextAction(
      String(value.state),
      value.browser && typeof value.browser === "object"
        ? value.browser as Record<string, unknown>
        : undefined,
    )}`,
  ];
  if (value.browser && typeof value.browser === "object") {
    const browser = value.browser as Record<string, unknown>;
    lines.push(
      `Browser: ${String(browser.phase)}`,
      `Submission: ${String(browser.submissionCertainty)}`,
      ...(browser.reason ? [`Reason: ${String(browser.reason)}`] : []),
    );
  }
  if (value.completion && typeof value.completion === "object") {
    const completion = value.completion as Record<string, unknown>;
    lines.push("", String(completion.answer ?? ""));
  }
  const browser = value.browser && typeof value.browser === "object"
    ? value.browser as Record<string, unknown>
    : undefined;
  if ((command === "start" || command === "followup") && value.handoff
    && (browser === undefined || browser.phase === "needs_manual")) {
    lines.push("", "Manual handoff:", String(value.handoff));
  }
  if (value.path) lines.push(`Path: ${String(value.path)}`);
  return lines.join("\n");
};
