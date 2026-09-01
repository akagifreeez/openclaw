import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadWorkspaceSkills } from "../../skills/loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../../skills/loading/workspace-skill-prompt.js";
import { transferSkillResources } from "./skill-resource-transfer.js";
import type { WorkerWorkspaceTunnelHandle } from "./tunnel-contract.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
const tunnel: Pick<WorkerWorkspaceTunnelHandle, "runWorkspaceCommand"> = {
  runWorkspaceCommand: async (command) => {
    command.assertCurrent?.();
    return new Promise((resolve, reject) => {
      const child = spawn(command.argv[0]!, command.argv.slice(1), {
        stdio: "pipe",
        signal: command.signal,
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (bytes) => {
        stdout += bytes;
      });
      child.stderr.on("data", (bytes) => {
        stderr += bytes;
      });
      child.on("error", reject);
      child.on("close", (code) =>
        resolve({ stdout, stderr, code, termination: "exit", signal: null, killed: false }),
      );
      child.stdin.end(command.input);
    });
  },
};

async function createSource() {
  const workspace = await fs.realpath(temps.make("remote-skill-source-"));
  const baseDir = path.join(workspace, "skills", "source");
  await fs.mkdir(path.join(baseDir, "scripts"), { recursive: true });
  const filePath = path.join(baseDir, "SKILL.md");
  await fs.writeFile(
    filePath,
    "---\ndescription: Resource transfer test\n---\n# Resource\nRead data.bin and run scripts/check.sh.\n",
  );
  const binary = Buffer.alloc(150000, 129);
  await fs.writeFile(path.join(baseDir, "data.bin"), binary);
  await fs.writeFile(path.join(baseDir, "scripts/check.sh"), "#!/bin/sh\nprintf ready\n", {
    mode: 0o700,
  });
  return {
    workspace,
    filePath,
    binary,
    snapshot: buildSkillSnapshot(workspace, {
      entries: loadWorkspaceSkills(workspace, { workspaceOnly: true }),
    }),
  };
}

describe("remote-exec skill resources", () => {
  it.each(["complete", "cancelled", "retired"] as const)(
    "preserves complete resources outside the project and cleans up only its current owner (%s)",
    async (outcome) => {
      const { workspace, filePath, binary, snapshot } = await createSource();
      const controller = new AbortController();
      let current = true;
      const resources = await transferSkillResources({
        tunnel,
        signal: controller.signal,
        assertCurrent: () => {
          if (!current) {
            throw new Error("placement retired");
          }
        },
        snapshot,
      });
      expect(resources).toBeDefined();
      const remote = resources!.mounts[0]!.containerPath;
      try {
        expect(remote.startsWith(workspace)).toBe(false);
        expect(await fs.readFile(path.join(remote, "SKILL.md"))).toEqual(
          await fs.readFile(filePath),
        );
        expect(resources!.snapshot.resolvedSkills![0]!.name).toBe("source");
        expect(await fs.readFile(path.join(remote, "data.bin"))).toEqual(binary);
        expect((await fs.stat(path.join(remote, "scripts/check.sh"))).mode & 0o777).toBe(0o500);
        expect((await fs.stat(path.join(remote, "data.bin"))).mode & 0o777).toBe(0o400);
        expect(resources!.snapshot.prompt).toContain(remote);
        expect(resources!.snapshot.resolvedSkills![0]!.filePath).toBe(filePath);
        if (outcome === "cancelled") {
          controller.abort();
        } else if (outcome === "retired") {
          current = false;
        }
        if (outcome === "retired") {
          await expect(resources!.cleanup()).rejects.toThrow("placement retired");
          expect(await fs.readFile(path.join(remote, "data.bin"))).toEqual(binary);
        } else {
          await expect(resources!.cleanup()).resolves.toBeUndefined();
          await expect(fs.stat(remote)).rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        await fs.rm(path.dirname(remote), { recursive: true, force: true });
      }
    },
  );

  it("cleans the accepted remote directory when cancellation arrives with initialization", async () => {
    const { snapshot } = await createSource();
    const controller = new AbortController();
    let initializedRoot: string | undefined;
    try {
      await expect(
        transferSkillResources({
          snapshot,
          signal: controller.signal,
          assertCurrent: () => {},
          tunnel: {
            runWorkspaceCommand: async (command) => {
              const result = await tunnel.runWorkspaceCommand(command);
              if (!initializedRoot) {
                const initialized: { root: string } = JSON.parse(result.stdout);
                initializedRoot = initialized.root;
                controller.abort();
              }
              return result;
            },
          },
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(initializedRoot).toBeDefined();
      await expect(fs.stat(initializedRoot!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (initializedRoot) {
        await fs.rm(initializedRoot, { recursive: true, force: true });
      }
    }
  });
});
