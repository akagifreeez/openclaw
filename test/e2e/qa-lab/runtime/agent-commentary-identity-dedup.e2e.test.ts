// Proves generic commentary segments around tool handoffs persist with unique
// identities and survive a reconnect (fresh history load) as one row each.
// Regression coverage for openclaw#134971.
import { createServer, type ServerResponse } from "node:http";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { createQaGatewayChild, type QaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

const TEST_TIMEOUT_MS = 240_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MODEL_REF = "anthropic/claude-sonnet-4-6";
const SESSION_KEY = "agent:qa:qa:commentary-identity-dedup";
const IDEMPOTENCY_KEY = "qa-commentary-identity-dedup";
const FIRST_COMMENTARY = "Checking the first fixture file.";
const SECOND_COMMENTARY = "Now checking the follow-up file.";
const TERMINAL_TEXT = "COMMENTARY-IDENTITY-DEDUP-OK";
// An unknown tool still round-trips an error tool result, so the turn keeps
// going while exercising the same response-boundary handoff a real tool uses.
const HANDOFF_TOOL_NAME = "openclaw_no_such_tool";

type GatewayHandle = QaGatewayChild;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).toReversed()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "commentary identity dedup cleanup failed");
  }
});

function sseEvents(response: ServerResponse, events: unknown[]): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  response.end(
    events
      .map(
        (event) =>
          `event: ${String((event as { type?: string }).type)}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
  );
}

function commentaryRoundEvents(commentary: string, toolUseId: string): unknown[] {
  return [
    {
      type: "message_start",
      message: {
        id: `msg_${toolUseId}`,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: commentary },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: toolUseId, name: HANDOFF_TOOL_NAME, input: {} },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: "{}" },
    },
    { type: "content_block_stop", index: 1 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 10 },
    },
    { type: "message_stop" },
  ];
}

function terminalRoundEvents(): unknown[] {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_terminal",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: TERMINAL_TEXT },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 10 },
    },
    { type: "message_stop" },
  ];
}

async function startControlledAnthropicProvider() {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    void (async () => {
      const url = request.url ?? "";
      if (request.method !== "POST" || !url.includes("/messages")) {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const round = requests.length;
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      const events =
        round === 0
          ? commentaryRoundEvents(FIRST_COMMENTARY, "toolu_round0")
          : round === 1
            ? commentaryRoundEvents(SECOND_COMMENTARY, "toolu_round1")
            : terminalRoundEvents();
      sseEvents(response, events);
    })().catch((error: unknown) => {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("controlled provider did not bind a loopback port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function connectOperator(
  gateway: GatewayHandle,
  displayName: string,
): Promise<GatewayClient> {
  return await new Promise<GatewayClient>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        client.stop();
        reject(error);
        return;
      }
      resolve(client);
    };
    const client = new GatewayClient({
      url: gateway.wsUrl,
      token: gateway.token,
      env: gateway.runtimeEnv,
      role: "operator",
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: displayName,
      clientVersion: "1.0.0",
      platform: process.platform,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      scopes: ["operator.admin", "operator.read", "operator.write"],
      deviceIdentity: null,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      onHelloOk: () => finish(),
      onConnectError: (error) => finish(error),
      onClose: (code, reason) => finish(new Error(`Gateway closed (${code}): ${reason}`)),
    });
    const timeout = setTimeout(
      () => finish(new Error(`Gateway client connection timed out:\n${gateway.logs()}`)),
      REQUEST_TIMEOUT_MS,
    );
    timeout.unref();
    client.start();
  });
}

function messageRole(message: unknown): string | undefined {
  const role = message && typeof message === "object" ? (message as { role?: unknown }).role : null;
  return typeof role === "string" ? role : undefined;
}

function messageText(message: unknown): string {
  if (!message || typeof message === "object") {
    return "";
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : [],
    )
    .join("\n");
}

function commentaryFallbackRows(messages: unknown[]) {
  return (messages ?? [])
    .map((message) => {
      if (messageRole(message) !== "assistant") {
        return undefined;
      }
      const fallback = (
        message as {
          openclawStreamFallback?: {
            source?: unknown;
            itemId?: unknown;
            replacementText?: unknown;
          };
        }
      ).openclawStreamFallback;
      if (!fallback || fallback.source !== "segment") {
        return undefined;
      }
      const replacementText =
        typeof fallback.replacementText === "string" ? fallback.replacementText : "";
      return {
        itemId: typeof fallback.itemId === "string" ? fallback.itemId : undefined,
        text: messageText(message) || replacementText,
        raw: message,
      };
    })
    .filter(
      (row): row is { itemId: string | undefined; text: string; raw: unknown } => row !== undefined,
    );
}

describe("generic commentary identity survives tool handoffs and reconnect", () => {
  it(
    "persists two commentary segments with distinct identities and replays one row each",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const provider = await startControlledAnthropicProvider();
      cleanups.push(() => provider.stop());
      const gatewayOwner = createQaGatewayChild();
      cleanups.push(() => stopQaGatewayFixture(gatewayOwner));
      const gateway = await gatewayOwner.start({
        repoRoot: process.cwd(),
        command: {
          executablePath: process.execPath,
          argsPrefix: ["--import", "tsx", "src/entry.ts"],
          cwd: process.cwd(),
          usePackagedPlugins: true,
        },
        providerBaseUrl: `${provider.baseUrl}/v1`,
        providerMode: "mock-openai",
        primaryModel: MODEL_REF,
        alternateModel: MODEL_REF,
        transportBaseUrl: "http://127.0.0.1",
        controlUiEnabled: false,
        fastMode: true,
        runtimeEnvPatch: {
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        },
        mutateConfig: (config) => ({ ...config, plugins: { enabled: false } }),
      });

      const clientA = await connectOperator(gateway, "Commentary identity client A");
      const accepted = await clientA.request<{ status?: string; runId?: string }>("agent", {
        sessionKey: SESSION_KEY,
        message: "Work through the fixture files, then report.",
        deliver: false,
        idempotencyKey: IDEMPOTENCY_KEY,
      });
      expect(accepted).toMatchObject({ status: "accepted" });

      const terminal = await clientA.request<{ status?: string }>(
        "agent.wait",
        { runId: accepted.runId, timeoutMs: 120_000 },
        { timeoutMs: 150_000 },
      );
      expect(terminal).toMatchObject({ status: "ok" });
      // Three provider rounds: commentary+tool_use, commentary+tool_use, final.
      expect(provider.requests).toHaveLength(3);
      await clientA.stopAndWait({ timeoutMs: 1_000 });

      const readHistory = async (client: GatewayClient) => {
        const history = await client.request<{ messages?: unknown[] }>("chat.history", {
          sessionKey: SESSION_KEY,
          limit: 50,
        });
        return (history.messages ?? []).filter((message) =>
          ["user", "assistant"].includes(messageRole(message) ?? ""),
        );
      };

      // First load: both commentary segments persist as distinct keyed rows.
      const clientB = await connectOperator(gateway, "Commentary identity client B");
      cleanups.push(() => clientB.stopAndWait({ timeoutMs: 1_000 }));
      const firstLoadRows = commentaryFallbackRows(await readHistory(clientB));
      expect(firstLoadRows.map((row) => row.text)).toEqual([FIRST_COMMENTARY, SECOND_COMMENTARY]);
      expect(firstLoadRows.map((row) => row.itemId)).toHaveLength(2);
      expect(firstLoadRows[0]?.itemId).toBeTruthy();
      expect(firstLoadRows[1]?.itemId).toBeTruthy();
      expect(firstLoadRows[1]?.itemId).not.toBe(firstLoadRows[0]?.itemId);

      // Reconnect: a fresh client replays persisted history; each commentary
      // segment still renders exactly once — no duplicated bubbles.
      const clientC = await connectOperator(gateway, "Commentary identity client C");
      cleanups.push(() => clientC.stopAndWait({ timeoutMs: 1_000 }));
      const reconnectRows = commentaryFallbackRows(await readHistory(clientC));
      expect(reconnectRows).toEqual(firstLoadRows);
      const reconnectTurns = await readHistory(clientC);
      // Count occurrences in the rendered fields only (content text plus the
      // keyed segment's replacement text); metadata mirrors don't render.
      const renderedOccurrences = (needle: string) =>
        reconnectTurns.reduce<number>((count, message) => {
          if (messageRole(message) !== "assistant") {
            return count;
          }
          const fallback = (message as { openclawStreamFallback?: { replacementText?: unknown } })
            .openclawStreamFallback;
          const replacementText =
            typeof fallback?.replacementText === "string" ? fallback.replacementText : "";
          return (
            count +
            (messageText(message).split(needle).length - 1) +
            (replacementText.split(needle).length - 1)
          );
        }, 0);
      expect(renderedOccurrences(FIRST_COMMENTARY)).toBe(1);
      expect(renderedOccurrences(SECOND_COMMENTARY)).toBe(1);

      // Trace for PR evidence (redacted: local fixture only). Written only
      // when OPENCLAW_COMMENTARY_PROOF_OUT points at a writable path.
      const proofOut = process.env.OPENCLAW_COMMENTARY_PROOF_OUT;
      if (proofOut) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(
          proofOut,
          JSON.stringify(
            {
              model: MODEL_REF,
              providerRounds: provider.requests.length,
              firstLoad: firstLoadRows.map(({ _raw, ...row }) => row),
              reconnect: reconnectRows.map(({ _raw, ...row }) => row),
              occurrencesAfterReconnect: {
                [FIRST_COMMENTARY]: renderedOccurrences(FIRST_COMMENTARY),
                [SECOND_COMMENTARY]: renderedOccurrences(SECOND_COMMENTARY),
              },
            },
            null,
            2,
          ),
        );
      }
    },
  );
});
