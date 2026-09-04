import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import type { ContextService } from "../context/selection";
import type { RequestStore } from "../core/store";
import { createChatgptMcp } from "./chatgpt";

const LOOPBACK_HOSTNAME = "127.0.0.1";
const DEFAULT_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const MAX_BODY_LIMIT_BYTES = 8 * 1024 * 1024;

const payloadTooLarge = (): Response => new Response("Payload Too Large", { status: 413 });

const validateOptions = (options: StartChatgptHttpOptions): {
  hostname: string;
  port: number;
  bodyLimitBytes: number;
} => {
  const hostname = options.hostname ?? LOOPBACK_HOSTNAME;
  if (hostname !== LOOPBACK_HOSTNAME) {
    throw new RangeError("ChatGPT HTTP MCP must bind to 127.0.0.1");
  }
  const port = options.port ?? 43_891;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError("HTTP port must be an integer from 0 through 65535");
  }
  const bodyLimitBytes = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES;
  if (
    !Number.isSafeInteger(bodyLimitBytes)
    || bodyLimitBytes <= 0
    || bodyLimitBytes > MAX_BODY_LIMIT_BYTES
  ) {
    throw new RangeError("HTTP body limit is invalid");
  }
  return { hostname, port, bodyLimitBytes };
};

const boundedRequest = async (
  request: Request,
  maximumBytes: number,
): Promise<Request | Response> => {
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(lengthHeader)) return payloadTooLarge();
    const declaredLength = Number(lengthHeader);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > maximumBytes) {
      return payloadTooLarge();
    }
  }
  if (request.body === null) return request;

  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = request.body.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > maximumBytes) {
      try {
        await reader.cancel();
      } catch {
        // The request is already rejected; cancellation is best-effort cleanup.
      }
      return payloadTooLarge();
    }
    chunks.push(next.value);
  }

  const headers = new Headers(request.headers);
  headers.set("content-length", String(bytes));
  const body = Buffer.concat(chunks, bytes);
  return new Request(request.url, {
    method: request.method,
    headers,
    body,
    signal: request.signal,
  });
};

export const closeHttpResources = async (
  closeHandler: () => Promise<void>,
  stopListener: () => void | Promise<void>,
): Promise<void> => {
  const outcomes = await Promise.allSettled([
    Promise.resolve().then(closeHandler),
    Promise.resolve().then(stopListener),
  ]);
  const failed = outcomes.find((outcome) => outcome.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
};

export const requireLoopbackBinding = async (
  hostname: string | undefined,
  closeHandler: () => Promise<void>,
  stopListener: () => void | Promise<void>,
): Promise<string> => {
  if (hostname === LOOPBACK_HOSTNAME) return hostname;
  try {
    await closeHttpResources(closeHandler, stopListener);
  } catch {
    throw new Error("HTTP listener cleanup failed");
  }
  throw new Error("HTTP listener did not bind to the required loopback address");
};

export interface RunningHttpServer {
  hostname: string;
  url: string;
  mcpUrl: string;
  stop(): Promise<void>;
}

export interface StartChatgptHttpOptions {
  store: RequestStore;
  context: ContextService;
  hostname?: string;
  port?: number;
  bodyLimitBytes?: number;
}

export const startChatgptHttp = async (
  options: StartChatgptHttpOptions,
): Promise<RunningHttpServer> => {
  const { hostname, port, bodyLimitBytes } = validateOptions(options);
  const handler = createMcpHandler(
    () => createChatgptMcp({ store: options.store, context: options.context }),
    { responseMode: "json" },
  );
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname,
      port,
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (request.method === "GET" && pathname === "/health") {
          return Response.json({ status: "ok", surface: "chatgpt", schemaVersion: 1 });
        }
        if (pathname !== "/mcp") return new Response("Not Found", { status: 404 });

        const rejected =
          hostHeaderValidationResponse(request, localhostAllowedHostnames())
          ?? originValidationResponse(request, localhostAllowedOrigins());
        if (rejected) return rejected;

        const bounded = await boundedRequest(request, bodyLimitBytes);
        if (bounded instanceof Response) return bounded;
        return handler.fetch(bounded);
      },
    });
  } catch (error) {
    await handler.close();
    throw error;
  }

  const boundHostname = await requireLoopbackBinding(
    server.hostname,
    handler.close,
    () => server.stop(true),
  );
  const url = server.url.origin;
  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopPromise ??= closeHttpResources(
      handler.close,
      () => server.stop(true),
    );
    return stopPromise;
  };
  return { hostname: boundHostname, url, mcpUrl: `${url}/mcp`, stop };
};
