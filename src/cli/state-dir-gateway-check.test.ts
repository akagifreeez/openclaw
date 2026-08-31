import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  readGatewayServiceState: vi.fn(),
  resolveGatewayService: vi.fn(),
}));

vi.mock("../gateway/call.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/call.js")>();
  return { ...actual, callGateway: mocks.callGateway };
});
vi.mock("../daemon/service.js", () => ({
  readGatewayServiceState: mocks.readGatewayServiceState,
  resolveGatewayService: mocks.resolveGatewayService,
}));

import { checkCliGatewayStateDir } from "./state-dir-gateway-check.js";

describe("state-dir-gateway-check", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-state-dir-check-"));
    mocks.callGateway.mockReset();
    mocks.readGatewayServiceState.mockReset();
    mocks.resolveGatewayService.mockReset();
    mocks.readGatewayServiceState.mockResolvedValue({ installed: false });
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "cli"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["same", "cli", "cli", "match"],
    ["different", "cli", "gateway", "mismatch"],
  ] as const)("reports %s local directories", async (_label, cli, gateway, kind) => {
    await fs.mkdir(path.join(root, cli), { recursive: true });
    await fs.mkdir(path.join(root, gateway), { recursive: true });
    mocks.callGateway.mockImplementation(async (opts: { onHelloOk?: (hello: unknown) => void }) => {
      opts.onHelloOk?.({ snapshot: { stateDir: path.join(root, gateway) } });
      return {};
    });
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, cli));

    await expect(checkCliGatewayStateDir({ config: {} })).resolves.toMatchObject({ kind });
  });

  it("treats symlink-equivalent paths as a match", async () => {
    const realRoot = await fs.realpath(root);
    const gateway = path.join(realRoot, "gateway");
    await fs.mkdir(gateway);
    const link = path.join(realRoot, "cli-link");
    await fs.symlink(gateway, link);
    vi.stubEnv("OPENCLAW_STATE_DIR", link);
    mocks.callGateway.mockImplementation(async (opts: { onHelloOk?: (hello: unknown) => void }) => {
      opts.onHelloOk?.({ snapshot: { stateDir: await fs.realpath(gateway) } });
      return {};
    });

    await expect(checkCliGatewayStateDir({ config: {} })).resolves.toMatchObject({ kind: "match" });
  });

  it("returns unavailable when the gateway is missing", async () => {
    mocks.callGateway.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(checkCliGatewayStateDir({ config: {} })).resolves.toMatchObject({
      kind: "unavailable",
    });
  });

  it("returns unavailable when gateway authentication blocks status", async () => {
    mocks.callGateway.mockRejectedValue(new Error("credentials required"));

    await expect(checkCliGatewayStateDir({ config: {} })).resolves.toMatchObject({
      kind: "unavailable",
    });
  });

  it("does not compare a remote gateway target", async () => {
    await expect(
      checkCliGatewayStateDir({
        config: { gateway: { mode: "remote", remote: { url: "wss://gateway.example" } } },
      }),
    ).resolves.toMatchObject({ kind: "remote", gatewayUrl: "wss://gateway.example" });
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("uses the installed service environment after a failed local status check", async () => {
    const serviceDir = path.join(root, "service");
    await fs.mkdir(serviceDir);
    mocks.callGateway.mockRejectedValue(new Error("ECONNREFUSED"));
    mocks.readGatewayServiceState.mockResolvedValue({
      installed: true,
      env: { OPENCLAW_STATE_DIR: serviceDir },
    });

    await expect(checkCliGatewayStateDir({ config: {} })).resolves.toMatchObject({
      kind: "unavailable",
      gatewayStateDir: await fs.realpath(serviceDir),
      gatewayStateDirSource: "configured service target",
    });
  });

  it("warns but allows a write when only the configured service target differs", async () => {
    const serviceDir = path.join(root, "service");
    await fs.mkdir(serviceDir);
    mocks.callGateway.mockRejectedValue(new Error("ECONNREFUSED"));
    mocks.readGatewayServiceState.mockResolvedValue({
      installed: true,
      env: { OPENCLAW_STATE_DIR: serviceDir },
    });
    const warn = vi.fn();

    await expect(
      checkCliGatewayStateDir({ config: {}, command: "openclaw models auth paste-token", warn }),
    ).resolves.toMatchObject({ kind: "unavailable" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("configured service target"));
  });

  it("requests admin status and refuses before a write on a proven mismatch", async () => {
    const gateway = path.join(root, "gateway");
    await fs.mkdir(gateway);
    mocks.callGateway.mockImplementation(async (opts: { onHelloOk?: (hello: unknown) => void }) => {
      opts.onHelloOk?.({ snapshot: { stateDir: gateway } });
      return {};
    });
    const write = vi.fn();

    await expect(
      checkCliGatewayStateDir({
        config: {} as OpenClawConfig,
        command: "openclaw models auth login",
        warn: vi.fn(),
      }),
    ).rejects.toThrow("No credentials were written.");
    expect(write).not.toHaveBeenCalled();
    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "status", scopes: ["operator.admin"] }),
    );
  });
});
