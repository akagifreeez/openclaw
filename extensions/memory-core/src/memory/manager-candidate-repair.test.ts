import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("automatic candidates during provenance repair", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  it.each([false, true])(
    "returns promptly while a large rebuild is pending (startup catch-up: %s)",
    async (startupCatchup) => {
      const projectKey = "github.com/example/project";
      await fs.writeFile(
        path.join(fixture.paths.workspace, "MEMORY.md"),
        `- Keep the release local. <!-- trigger: release local --> <!-- project: ${projectKey} -->\n`,
      );
      await Promise.all(
        Array.from({ length: 256 }, (_, index) =>
          fs.writeFile(
            path.join(fixture.paths.memory, `entry-${index}.md`),
            `# Entry ${index}\nSynthetic memory content ${index}.\n`,
          ),
        ),
      );
      const cfg = fixture.createConfig({
        provider: "batch-wide-test",
        batchEnabled: true,
        vectorEnabled: false,
        sources: startupCatchup ? ["memory", "sessions"] : ["memory"],
        sessionMemory: startupCatchup,
      });
      if (startupCatchup) {
        await fixture.seedSessionTranscript({
          sessionId: "legacy-session",
          messages: [{ role: "user", timestamp: 1, content: "Remember the release preference." }],
        });
      }
      const initial = await fixture.getFreshManager(cfg, "cli");
      await initial.sync({ reason: "cli", force: true });
      const db = Reflect.get(initial, "db") as DatabaseSync;
      // Older indexes have neither classified provenance nor a chunking version.
      db.exec("DELETE FROM memory_index_chunk_provenance; DELETE FROM memory_embedding_cache");
      const row = db
        .prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_index_meta_v1'")
        .get() as { value: string };
      const meta = JSON.parse(row.value) as MemoryIndexMeta;
      delete meta.provenanceVersion;
      delete meta.chunkingVersion;
      db.prepare("UPDATE memory_index_meta SET value = ? WHERE key = 'memory_index_meta_v1'").run(
        JSON.stringify(meta),
      );
      await initial.close();

      const gate = createDeferred<void>();
      fixture.provider.providerRuntimeBatchGate = gate.promise;
      const upgraded = await fixture.getFreshManager(cfg);
      const candidates: Promise<unknown>[] = [];
      try {
        expect(upgraded.status().custom?.indexIdentity).toMatchObject({
          status: "mismatched",
          reason: "index provenance classifier changed",
        });
        if (startupCatchup) {
          await vi.waitFor(() => expect(fixture.provider.providerRuntimeActiveBatchCalls).toBe(1), {
            timeout: 10_000,
          });
        }
        let completed = 0;
        for (const lookup of [
          () => upgraded.listCuratedProjectCandidates({ activeProjectKeys: [projectKey] }),
          () => upgraded.listTriggerCandidates({ activeProjectKeys: [projectKey] }),
        ]) {
          candidates.push(
            lookup().then((results) => {
              completed += 1;
              return results;
            }),
          );
        }
        await vi.waitFor(() => expect(completed).toBe(2));
        expect(await Promise.all(candidates)).toEqual([[], []]);
        await vi.waitFor(() => expect(fixture.provider.providerRuntimeActiveBatchCalls).toBe(1), {
          timeout: 10_000,
        });
        expect(upgraded.status().dirty).toBe(true);
      } finally {
        gate.resolve();
        await Promise.allSettled(candidates);
      }
      await upgraded.sync({ reason: "test-repair-complete" });
      expect(upgraded.status().dirty).toBe(false);
      const expected = [
        expect.objectContaining({
          projectKey,
          triggers: "release local",
          provenance: expect.objectContaining({ originClass: "agent" }),
        }),
      ];
      expect(
        await upgraded.listCuratedProjectCandidates({ activeProjectKeys: [projectKey] }),
      ).toEqual(expected);
      expect(await upgraded.listTriggerCandidates({ activeProjectKeys: [projectKey] })).toEqual(
        expected,
      );
    },
  );
});
