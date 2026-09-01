import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  probeGateway: vi.fn(),
  readGatewayServiceState: vi.fn(),
  resolveGatewayService: vi.fn(),
}));

vi.mock("../gateway/call.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/call.js")>();
  return { ...actual, callGateway: mocks.callGateway };
});
vi.mock("../gateway/probe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/probe.js")>();
  return { ...actual, probeGateway: mocks.probeGateway };
});
vi.mock("../daemon/service.js", () => ({
  readGatewayServiceState: mocks.readGatewayServiceState,
  resolveGatewayService: mocks.resolveGatewayService,
}));

const { GatewayCredentialsRequiredError } =
  await vi.importActual<typeof import("../gateway/call.js")>("../gateway/call.js");
import { checkCliGatewayStateDir } from "./state-dir-gateway-check.js";

describe("state-dir-gateway-check", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let root: string;

  beforeEach(async () => {
    root = tempDirs.make("openclaw-state-dir-check-");
    mocks.callGateway.mockReset();
    mocks.probeGateway.mockReset();
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
    const gatewayConfig = path.join(gateway, "openclaw.json");
    await fs.writeFile(gatewayConfig, "{}\n");
    const link = path.join(realRoot, "cli-link");
    await fs.symlink(gateway, link);
    const configLink = path.join(realRoot, "cli-config-link.json");
    await fs.symlink(gatewayConfig, configLink);
    vi.stubEnv("OPENCLAW_STATE_DIR", link);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configLink);
    mocks.callGateway.mockImplementation(async (opts: { onHelloOk?: (hello: unknown) => void }) => {
      opts.onHelloOk?.({
        snapshot: {
          stateDir: await fs.realpath(gateway),
          configPath: await fs.realpath(gatewayConfig),
        },
      });
      return {};
    });

    await expect(checkCliGatewayStateDir({ config: {} })).resolves.toMatchObject({ kind: "match" });
  });

  it("matches a missing config path through a symlinked state directory", async () => {
    const realStateDir = fsSync.realpathSync(root);
    const link = path.join(realStateDir, "cli-link");
    await fs.symlink(realStateDir, link);
    vi.stubEnv("OPENCLAW_STATE_DIR", link);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(link, "openclaw.json"));
    mocks.callGateway.mockImplementation(async (opts: { onHelloOk?: (hello: unknown) => void }) => {
      opts.onHelloOk?.({
        snapshot: {
          stateDir: realStateDir,
          configPath: path.join(realStateDir, "openclaw.json"),
        },
      });
      return {};
    });

    await expect(
      checkCliGatewayStateDir({
        config: {} as OpenClawConfig,
        command: "openclaw models auth paste-token",
      }),
    ).resolves.toMatchObject({ kind: "match" });
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
    const serviceDir = path.join(root, "service dir's");
    const serviceConfigPath = path.join(root, "gateway config's.json");
    await fs.mkdir(serviceDir);
    mocks.callGateway.mockRejectedValue(new Error("ECONNREFUSED"));
    mocks.probeGateway.mockResolvedValue({ ok: false, gatewayReached: true });
    mocks.readGatewayServiceState.mockResolvedValue({
      installed: true,
      env: {
        OPENCLAW_STATE_DIR: serviceDir,
        OPENCLAW_CONFIG_PATH: serviceConfigPath,
      },
    });
    const warn = vi.fn();

    await expect(
      checkCliGatewayStateDir({
        config: {},
        command: "openclaw models auth paste-token",
        allowMismatch: true,
        warn,
      }),
    ).resolves.toMatchObject({ kind: "unavailable" });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        `OPENCLAW_STATE_DIR='${path.join(root, "service dir")}'\\''s' OPENCLAW_CONFIG_PATH='${path.join(root, "gateway config")}'\\''s.json' openclaw doctor`,
      ),
    );
  });

  it("refuses a write when a credential preflight fails but the probe reaches a divergent gateway", async () => {
    const serviceDir = path.join(root, "service dir's");
    const serviceConfigPath = path.join(root, "gateway config's.json");
    await fs.mkdir(serviceDir);
    mocks.callGateway.mockRejectedValue(
      new GatewayCredentialsRequiredError({
        method: "status",
        configPath: path.join(root, "cli", "openclaw.json"),
      }),
    );
    mocks.probeGateway.mockResolvedValue({ ok: false, gatewayReached: true });
    mocks.readGatewayServiceState.mockResolvedValue({
      installed: true,
      env: {
        OPENCLAW_STATE_DIR: serviceDir,
        OPENCLAW_CONFIG_PATH: serviceConfigPath,
      },
    });

    const check = checkCliGatewayStateDir({
      config: {},
      timeoutMs: 321,
      command: "openclaw models auth paste-token",
    });
    await expect(check).rejects.toThrow("No credentials were written.");
    await expect(check).rejects.toThrow(
      `OPENCLAW_STATE_DIR='${path.join(root, "service dir")}'\\''s' OPENCLAW_CONFIG_PATH='${path.join(root, "gateway config")}'\\''s.json' openclaw models auth paste-token, or pass --allow-state-dir-mismatch`,
    );
    expect(mocks.probeGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        config: {},
        timeoutMs: 321,
        includeDetails: false,
        suppressStoredDeviceAuth: true,
      }),
    );
  });

  it.each([
    ["state directory", "OPENCLAW_STATE_DIR", "cli-state"],
    ["config path", "OPENCLAW_CONFIG_PATH", "cli-config.json"],
  ] as const)(
    "refuses a write when the service has no %s environment variable",
    async (_label, overrideName, overridePath) => {
      const home = path.join(root, "home");
      const xdgConfigHome = path.join(root, "xdg-config");
      const serviceStateDir = path.join(home, ".openclaw");
      const serviceConfigPath = path.join(serviceStateDir, "openclaw.json");
      await fs.mkdir(serviceStateDir, { recursive: true });
      vi.stubEnv("HOME", home);
      vi.stubEnv("XDG_CONFIG_HOME", xdgConfigHome);
      vi.stubEnv("OPENCLAW_LAUNCHD_LABEL", "com.example.gateway");
      vi.stubEnv("OPENCLAW_SYSTEMD_UNIT", "openclaw-gateway.service");
      vi.stubEnv("OPENCLAW_WINDOWS_TASK_NAME", "OpenClaw Gateway");
      vi.stubEnv("OPENCLAW_STATE_DIR", "");
      vi.stubEnv("OPENCLAW_CONFIG_PATH", "");
      vi.stubEnv(overrideName, path.join(root, overridePath));
      mocks.callGateway.mockRejectedValue(
        new GatewayCredentialsRequiredError({
          method: "status",
          configPath: path.join(root, "cli", "openclaw.json"),
        }),
      );
      mocks.probeGateway.mockResolvedValue({ ok: false, gatewayReached: true });
      const service = {};
      mocks.resolveGatewayService.mockReturnValue(service);
      mocks.readGatewayServiceState.mockImplementation(
        async (_service: unknown, options: { env?: NodeJS.ProcessEnv }) => ({
          installed: true,
          env: options.env ?? {},
          command: { environment: {} },
        }),
      );

      const check = checkCliGatewayStateDir({
        config: {},
        command: "openclaw models auth paste-token",
      });
      await expect(check).rejects.toThrow("No credentials were written.");
      await expect(check).rejects.toThrow(`Gateway: ${serviceStateDir}`);
      await expect(check).rejects.toThrow(`Gateway: ${serviceConfigPath}`);
      expect(mocks.readGatewayServiceState).toHaveBeenCalledWith(service, {
        env: expect.objectContaining({
          HOME: home,
          XDG_CONFIG_HOME: xdgConfigHome,
          OPENCLAW_LAUNCHD_LABEL: "com.example.gateway",
          OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service",
          OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway",
        }),
      });
      const serviceEnv = mocks.readGatewayServiceState.mock.calls[0]?.[1]?.env;
      expect(serviceEnv).not.toHaveProperty("OPENCLAW_STATE_DIR");
      expect(serviceEnv).not.toHaveProperty("OPENCLAW_CONFIG_PATH");
    },
  );

  it("warns and allows offline setup when the probe reaches nothing", async () => {
    const serviceDir = path.join(root, "service");
    await fs.mkdir(serviceDir);
    mocks.callGateway.mockRejectedValue(new Error("ECONNREFUSED"));
    mocks.probeGateway.mockResolvedValue({ ok: false });
    mocks.readGatewayServiceState.mockResolvedValue({
      installed: true,
      env: { OPENCLAW_STATE_DIR: serviceDir },
    });
    const warn = vi.fn();

    await expect(
      checkCliGatewayStateDir({
        config: {},
        command: "openclaw models auth paste-token",
        warn,
      }),
    ).resolves.toMatchObject({ kind: "unavailable" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Gateway is unavailable"));
  });

  it("warns when a reachable gateway has no installed service state to compare", async () => {
    mocks.callGateway.mockRejectedValue(
      new GatewayCredentialsRequiredError({
        method: "status",
        configPath: path.join(root, "cli", "openclaw.json"),
      }),
    );
    mocks.probeGateway.mockResolvedValue({ ok: false, gatewayReached: true });
    const warn = vi.fn();

    await expect(
      checkCliGatewayStateDir({
        config: {},
        command: "openclaw models auth paste-token",
        warn,
      }),
    ).resolves.toMatchObject({ kind: "unavailable" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("comparison was not possible"));
  });

  it("warns when the configured service target keeps the state dir but changes the config path", async () => {
    const stateDir = path.join(root, "shared");
    await fs.mkdir(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "cli-config.json"));
    mocks.callGateway.mockRejectedValue(new Error("ECONNREFUSED"));
    mocks.readGatewayServiceState.mockResolvedValue({
      installed: true,
      env: {
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(root, "gateway-config.json"),
      },
    });
    const warn = vi.fn();

    await expect(
      checkCliGatewayStateDir({ config: {}, command: "openclaw models auth paste-token", warn }),
    ).resolves.toMatchObject({ kind: "unavailable" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("config paths"));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("state directories"));
  });

  it("stays silent when the configured service target matches", async () => {
    const stateDir = path.join(root, "shared");
    await fs.mkdir(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    mocks.callGateway.mockRejectedValue(new Error("ECONNREFUSED"));
    mocks.readGatewayServiceState.mockResolvedValue({
      installed: true,
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const warn = vi.fn();

    await expect(
      checkCliGatewayStateDir({ config: {}, command: "openclaw models auth login", warn }),
    ).resolves.toMatchObject({ kind: "unavailable" });
    expect(warn).not.toHaveBeenCalled();
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
    // Shell-safe paths stay bare so the copied command reads like the one an operator would type.
    await expect(
      checkCliGatewayStateDir({
        config: {} as OpenClawConfig,
        command: "openclaw models auth login",
        warn: vi.fn(),
      }),
    ).rejects.toThrow(
      `OPENCLAW_STATE_DIR=${gateway} OPENCLAW_CONFIG_PATH=${path.join(gateway, "openclaw.json")} openclaw models auth login`,
    );
    expect(write).not.toHaveBeenCalled();
    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "status",
        scopes: ["operator.admin"],
        sharedStateMode: "read-only",
      }),
    );
  });

  it("refuses a live config-path mismatch when state directories match", async () => {
    const stateDir = path.join(root, "shared");
    const cliConfigPath = path.join(root, "cli-config.json");
    const gatewayConfigPath = path.join(root, "gateway-config.json");
    await fs.mkdir(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", cliConfigPath);
    mocks.callGateway.mockImplementation(async (opts: { onHelloOk?: (hello: unknown) => void }) => {
      opts.onHelloOk?.({ snapshot: { stateDir, configPath: gatewayConfigPath } });
      return {};
    });

    await expect(
      checkCliGatewayStateDir({
        config: {} as OpenClawConfig,
        command: "openclaw models auth paste-token",
      }),
    ).rejects.toThrow("config paths");
  });
});
