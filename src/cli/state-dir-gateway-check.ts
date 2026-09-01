import fs from "node:fs";
import path from "node:path";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readGatewayServiceState, resolveGatewayService } from "../daemon/service.js";
import {
  buildGatewayConnectionDetails,
  callGateway,
  GatewayCredentialsRequiredError,
} from "../gateway/call.js";
import type { GatewayClientOptions } from "../gateway/client.js";
import { ADMIN_SCOPE } from "../gateway/method-scopes.js";

type GatewayHello = Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0];
type GatewayStateDirCheck =
  | { kind: "match"; cliStateDir: string; gatewayStateDir: string }
  | { kind: "mismatch"; cliStateDir: string; gatewayStateDir: string }
  | {
      kind: "unavailable";
      cliStateDir: string;
      gatewayStateDir?: string;
      gatewayStateDirSource?: "configured service target";
    }
  | { kind: "remote"; cliStateDir: string; gatewayUrl: string };

type StateDirCheckParams = {
  config?: OpenClawConfig;
  timeoutMs?: number;
  gatewayStateDir?: string;
  gatewayStatus?: "success" | "failure";
  allowMismatch?: boolean;
  command?: string;
  warn?: (message: string) => void;
};

// realpath rejects paths that do not exist yet (openclaw.json before the first write).
// Canonicalize the nearest existing ancestor and re-append the missing tail; without it a
// symlinked state dir compares unequal to the Gateway's real dir and the guard refuses the
// first credential write.
function canonicalizeStatePath(value: string): string {
  const resolved = path.resolve(value);
  for (let dir = resolved, tail = ""; ; dir = path.dirname(dir)) {
    try {
      return path.join(fs.realpathSync.native(dir), tail);
    } catch {
      if (path.dirname(dir) === dir) {
        return resolved;
      }
      tail = path.join(path.basename(dir), tail);
    }
  }
}

// A Gateway that answered and demanded credentials proves a store is in use on this host, so a
// divergent target must block the write even though its state dir stayed unreadable. A Gateway that
// never answered is not live proof and only warns, keeping offline setup usable.
function refuseOrWarnMismatch(params: {
  differences: string;
  message: string;
  gatewayStateDir: string;
  gatewayConfig: string;
  gatewayReachable: boolean;
  command?: string;
  allowMismatch?: boolean;
  warn?: (message: string) => void;
}): void {
  if (params.gatewayReachable && params.command && !params.allowMismatch) {
    throw new Error(
      `No credentials were written. ${params.differences}. Fix: rerun with OPENCLAW_STATE_DIR=${params.gatewayStateDir} OPENCLAW_CONFIG_PATH=${params.gatewayConfig} ${params.command}, or pass --allow-state-dir-mismatch to write here anyway.`,
    );
  }
  params.warn?.(params.message);
}

async function serviceFallback(
  cliStateDir: string,
  params: {
    gatewayReachable: boolean;
    command?: string;
    allowMismatch?: boolean;
    warn?: (message: string) => void;
  },
): Promise<GatewayStateDirCheck> {
  const state = await readGatewayServiceState(resolveGatewayService(), { env: process.env }).catch(
    () => null,
  );
  const gatewayStateDir = state?.installed
    ? canonicalizeStatePath(resolveStateDir(state.env))
    : undefined;
  const gatewayConfigPath = state?.installed
    ? canonicalizeStatePath(resolveConfigPath(state.env))
    : undefined;
  if (gatewayStateDir && gatewayStateDir !== cliStateDir) {
    const reason = params.gatewayReachable
      ? "Gateway is reachable but status requires credentials"
      : "Gateway is unavailable";
    refuseOrWarnMismatch({
      differences: `state directories (CLI: ${cliStateDir}; Gateway: ${gatewayStateDir})`,
      message: `${reason}. CLI state dir ${cliStateDir} differs from the configured service target ${gatewayStateDir}; this is not live proof.`,
      gatewayStateDir,
      gatewayConfig: gatewayConfigPath ?? path.join(gatewayStateDir, "openclaw.json"),
      gatewayReachable: params.gatewayReachable,
      command: params.command,
      allowMismatch: params.allowMismatch,
      warn: params.warn,
    });
  }
  return {
    kind: "unavailable",
    cliStateDir,
    ...(gatewayStateDir
      ? {
          gatewayStateDir,
          gatewayStateDirSource: "configured service target" as const,
        }
      : {}),
  };
}

export async function checkCliGatewayStateDir(
  params: StateDirCheckParams,
): Promise<GatewayStateDirCheck> {
  const cliStateDir = canonicalizeStatePath(resolveStateDir(process.env));
  const cliConfigPath = canonicalizeStatePath(resolveConfigPath(process.env));
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
    return await serviceFallback(cliStateDir, {
      gatewayReachable: false,
      command: params.command,
      allowMismatch: params.allowMismatch,
      warn: params.warn,
    });
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
    } catch (error) {
      return await serviceFallback(cliStateDir, {
        gatewayReachable: error instanceof GatewayCredentialsRequiredError,
        command: params.command,
        allowMismatch: params.allowMismatch,
        warn: params.warn,
      });
    }
  }
  if (!gatewayStateDir) {
    return { kind: "unavailable", cliStateDir };
  }
  const liveStateDir = canonicalizeStatePath(gatewayStateDir);
  const liveConfigPath = gatewayConfigPath ? canonicalizeStatePath(gatewayConfigPath) : undefined;
  const stateDirMismatch = liveStateDir !== cliStateDir;
  const configPathMismatch = liveConfigPath !== undefined && liveConfigPath !== cliConfigPath;
  const result: GatewayStateDirCheck =
    stateDirMismatch || configPathMismatch
      ? { kind: "mismatch", cliStateDir, gatewayStateDir: liveStateDir }
      : { kind: "match", cliStateDir, gatewayStateDir: liveStateDir };
  if (result.kind === "mismatch") {
    const differences = [
      stateDirMismatch &&
        `state directories (CLI: ${cliStateDir}; Gateway: ${result.gatewayStateDir})`,
      configPathMismatch && `config paths (CLI: ${cliConfigPath}; Gateway: ${liveConfigPath})`,
    ]
      .filter(Boolean)
      .join(" and ");
    const gatewayConfig = liveConfigPath ?? path.join(result.gatewayStateDir, "openclaw.json");
    refuseOrWarnMismatch({
      differences,
      message: `CLI and live Gateway use different ${differences}. The CLI may read or write a store or config file the Gateway does not use. Fix: run OPENCLAW_STATE_DIR=${result.gatewayStateDir} OPENCLAW_CONFIG_PATH=${gatewayConfig} openclaw doctor, then rerun openclaw gateway status --deep.`,
      gatewayStateDir: result.gatewayStateDir,
      gatewayConfig,
      gatewayReachable: true,
      command: params.command,
      allowMismatch: params.allowMismatch,
      warn: params.warn,
    });
  }
  return result;
}
