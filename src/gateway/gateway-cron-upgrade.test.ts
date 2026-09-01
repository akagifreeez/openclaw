import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, onTestFailed } from "vitest";
import {
  BUILD_STAMP_FILE,
  resolveGitHead,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../scripts/lib/local-build-metadata.mts";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { loadCronJobsStoreWithConfigJobsReadOnly, loadCronQuarantinedJobs } from "../cron/store.js";

describe("Gateway cron upgrade", () => {
  it("quarantines every invalid legacy automation before Gateway readiness", async () => {
    const repoRoot = process.cwd();
    const head = resolveGitHead({ cwd: repoRoot });
    expect(head).toMatch(/^[0-9a-f]{40}$/u);
    // The runner prepares packaged artifacts before workers; never rebuild shared
    // dist or charge cold source compilation against Gateway's readiness deadline.
    await fs.promises.access(path.join(repoRoot, "dist/index.js"));
    for (const [file, field] of [
      [BUILD_STAMP_FILE, "head"],
      [RUNTIME_POSTBUILD_STAMP_FILE, "head"],
      ["build-info.json", "commit"],
    ] as const) {
      const metadata = JSON.parse(
        await fs.promises.readFile(path.join(repoRoot, "dist", file), "utf8"),
      ) as Record<string, unknown>;
      expect(metadata[field], file).toBe(head);
    }
    const instance = await createOpenClawTestInstance({
      name: "cron-upgrade-ready",
      cwd: repoRoot,
      startTimeoutMs: 30_000,
      config: {
        gateway: { mode: "local", auth: { mode: "none" } },
        hooks: { enabled: false },
      },
      env: {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_TEST_FAST: "1",
        NO_COLOR: "1",
        // Keep the full startup sidecars, including cron, behind /readyz.
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_SKIP_GMAIL_WATCHER: undefined,
        OPENCLAW_SKIP_CRON: undefined,
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: undefined,
        OPENCLAW_SKIP_CANVAS_HOST: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        NODE_ENV: undefined,
        OPENCLAW_HOME: undefined,
        VITEST: undefined,
      },
    });
    onTestFailed(() => console.info(instance.logs()));
    const storePath = path.join(instance.stateDir, "cron", "jobs.json");
    try {
      const job = {
        name: "Legacy automation",
        enabled: true,
        createdAtMs: 1,
        updatedAtMs: 1,
        schedule: { kind: "cron", expr: "0 9 * * *" },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "tick" },
        state: {},
      };
      await instance.state.writeJson("cron/jobs.json", {
        version: 1,
        jobs: [
          { ...job, id: "valid-job" },
          { ...job, id: "invalid-state-job", state: { nextRunAtMs: -1 } },
          { ...job, id: "invalid-trigger-job", trigger: { script: [] } },
        ],
      });
      expect(await instance.entrypoint()).toEqual(["dist/index.js"]);
      await instance.startGateway();
      const response = await fetch(`http://127.0.0.1:${instance.port}/readyz`);
      await expect(response.json()).resolves.toMatchObject({ ready: true, failing: [] });
      await instance.stopGateway();

      const loaded = await loadCronJobsStoreWithConfigJobsReadOnly(storePath, instance.env);
      expect(loaded.store.jobs.map((entry) => entry.id)).toContain("valid-job");
      expect(
        loadCronQuarantinedJobs(storePath, instance.env).map((entry) => ({
          sourceIndex: entry.sourceIndex,
          reason: entry.reason,
          id: entry.job?.id,
        })),
      ).toEqual([
        { sourceIndex: 1, reason: "invalid-state", id: "invalid-state-job" },
        { sourceIndex: 2, reason: "invalid-trigger", id: "invalid-trigger-job" },
      ]);
      expect(fs.existsSync(storePath)).toBe(false);
      expect(fs.existsSync(`${storePath}.migrated`)).toBe(true);
    } finally {
      await instance.cleanup();
    }
  }, 45_000);
});
