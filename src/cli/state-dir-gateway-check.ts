import fs from "node:fs";
import path from "node:path";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readGatewayServiceState, resolveGatewayService } from "../daemon/service.js";
import { buildGatewayConnectionDetails, callGateway } from "../gateway/call.js";
import type { GatewayClientOptions } from "../gateway/client.js";
import { ADMIN_SCOPE } from "../gateway/method-scopes.js";

type GatewayHello = Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0];

function normalizeStateDir(value: string): string {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

async function serviceFallback(cliStateDir: string, warn?: (message: string) => void) {
  const state = await readGatewayServiceState(resolveGatewayService(), { env: process.env }).catch(
    () => null,
  );
  const gatewayStateDir = state?.installed
    ? normalizeStateDir(resolveStateDir(state.env))
    : undefined;
  if (gatewayStateDir && gatewayStateDir !== cliStateDir) {
    warn?.(
      `Gateway is unavailable. CLI state dir ${cliStateDir} differs from the configured service target ${gatewayStateDir}; this is not live proof.`,
    );
  }
  return {
    kind: "unavailable" as const,
    cliStateDir,
    ...(gatewayStateDir
      ? {
          gatewayStateDir,
          gatewayStateDirSource: "configured service target" as const,
        }
      : {}),
  };
}

export async function checkCliGatewayStateDir(params: {
  config?: OpenClawConfig;
  timeoutMs?: number;
  gatewayStateDir?: string;
  gatewayStatus?: "success" | "failure";
  allowMismatch?: boolean;
  command?: string;
  warn?: (message: string) => void;
}) {
  const cliStateDir = normalizeStateDir(resolveStateDir(process.env));
  const cliConfigPath = normalizeStateDir(resolveConfigPath(process.env));
  let details: ReturnType<typeof buildGatewayConnectionDetails>;
  try {
    details = buildGatewayConnectionDetails({ config: params.config });
  } catch {
    return { kind: "unavailable", cliStateDir };
  }
  const hostname = new URL(details.url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    params.config?.gateway?.mode === "remote" ||
    (hostname !== "localhost" && !["127.0.0.1", "::1"].includes(hostname))
  ) {
    params.warn?.(
      `Gateway target ${details.url} is remote. Cross-host comparison is not possible; local writes do not reach the remote Gateway.`,
    );
    return { kind: "remote", cliStateDir, gatewayUrl: details.url };
  }

  let gatewayStateDir = params.gatewayStateDir;
  let gatewayConfigPath: string | undefined;
  if (params.gatewayStatus === "failure") {
    return await serviceFallback(cliStateDir, params.warn);
  }
  if (params.gatewayStatus === undefined) {
    try {
      await callGateway({
        config: params.config,
        method: "status",
        params: { includeChannelSummary: false },
        scopes: [ADMIN_SCOPE],
        sharedStateMode: "read-only",
        timeoutMs: params.timeoutMs,
        onHelloOk: (hello: GatewayHello) => {
          gatewayStateDir = hello.snapshot.stateDir;
          gatewayConfigPath = hello.snapshot.configPath;
        },
      });
    } catch {
      return await serviceFallback(cliStateDir, params.warn);
    }
  }
  if (!gatewayStateDir) {
    return { kind: "unavailable", cliStateDir };
  }
  const liveStateDir = normalizeStateDir(gatewayStateDir);
  const liveConfigPath = gatewayConfigPath ? normalizeStateDir(gatewayConfigPath) : undefined;
  const stateDirMismatch = liveStateDir !== cliStateDir;
  const configPathMismatch = liveConfigPath !== undefined && liveConfigPath !== cliConfigPath;
  const result = {
    kind: stateDirMismatch || configPathMismatch ? "mismatch" : "match",
    cliStateDir,
    gatewayStateDir: liveStateDir,
  };
  if (result.kind === "mismatch") {
    const differences = [
      stateDirMismatch &&
        `state directories (CLI: ${cliStateDir}; Gateway: ${result.gatewayStateDir})`,
      configPathMismatch && `config paths (CLI: ${cliConfigPath}; Gateway: ${liveConfigPath})`,
    ]
      .filter(Boolean)
      .join(" and ");
    const gatewayConfig = liveConfigPath ?? path.join(result.gatewayStateDir, "openclaw.json");
    const message = `CLI and live Gateway use different ${differences}. The CLI may read or write a store or config file the Gateway does not use. Fix: run OPENCLAW_STATE_DIR=${result.gatewayStateDir} OPENCLAW_CONFIG_PATH=${gatewayConfig} openclaw doctor, then rerun openclaw gateway status --deep.`;
    if (params.command && !params.allowMismatch) {
      throw new Error(
        `No credentials were written. ${differences}. Fix: rerun with OPENCLAW_STATE_DIR=${result.gatewayStateDir} OPENCLAW_CONFIG_PATH=${gatewayConfig} ${params.command}, or pass --allow-state-dir-mismatch to write here anyway.`,
      );
    }
    params.warn?.(message);
  }
  return result;
}
