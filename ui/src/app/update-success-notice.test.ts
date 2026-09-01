// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";

const { getSafeSessionStorageMock, reloadControlUiIfStaleMock, showToastMock } = vi.hoisted(() => ({
  getSafeSessionStorageMock: vi.fn(),
  reloadControlUiIfStaleMock: vi.fn(),
  showToastMock: vi.fn(),
}));

vi.mock("../build-info.ts", () => ({
  reloadControlUiIfStale: reloadControlUiIfStaleMock,
}));
vi.mock("../i18n/index.ts", () => ({
  t: (_key: string, params?: Record<string, string>) => `Gateway updated · now on ${params?.sha}.`,
}));
vi.mock("../lib/toast.ts", () => ({ showToast: showToastMock }));
vi.mock("../local-storage.ts", () => ({
  getSafeSessionStorage: getSafeSessionStorageMock,
}));

describe("update success notice", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getSafeSessionStorageMock.mockReturnValue(null);
    reloadControlUiIfStaleMock.mockReturnValue(false);
  });

  it("announces a non-reloading success when session storage is unavailable", async () => {
    const { createUpdateNoticeSession } = await import("./update-success-notice.ts");

    createUpdateNoticeSession("ws://gateway.test").announceVerifiedInstall(
      { version: "2026.8.11", sha: "abcdef1234567890" },
      { gateway: "ws://gateway.test", profileId: null },
    );

    expect(showToastMock).toHaveBeenCalledWith({
      message: "Gateway updated · now on abcdef1.",
    });
  });

  it.each(["handoff", "verified"] as const)(
    "hydrates the previous bundle's flat %s notice on upgrade",
    async (kind) => {
      const { createUpdateNoticeSession } = await import("./update-success-notice.ts");
      const storage = createStorageMock();
      getSafeSessionStorageMock.mockReturnValue(storage);
      const scope = { gateway: "ws://gateway.test", profileId: "operator" };
      // The outgoing bundle writes these flat v1 fields before its page reload.
      // Pending notices predate requestId; the replacement must retain them.
      const saved = {
        ...scope,
        kind,
        deadlineAtMs: Date.now() + 60_000,
        ...(kind === "handoff"
          ? { expectedVersion: "2.0.0", expectedSha: null, handoffId: "current-handoff" }
          : { version: "2.0.0", sha: "abcdef1234567890" }),
      };
      storage.setItem("openclaw:control-ui:update:v1", JSON.stringify(saved));

      const session = createUpdateNoticeSession(scope.gateway);
      expect(session.notice).toMatchObject(saved);
      if (kind === "handoff") {
        expect(session.notice).toMatchObject({ requestId: expect.any(String) });
        expect(createUpdateNoticeSession(scope.gateway).notice).toEqual(session.notice);
        expect(showToastMock).not.toHaveBeenCalled();
      } else {
        session.announceRecordedSuccess(scope);
        expect(showToastMock).toHaveBeenCalledOnce();
        expect(showToastMock).toHaveBeenCalledWith({
          message: "Gateway updated · now on abcdef1.",
        });
        expect(createUpdateNoticeSession(scope.gateway).notice).toBeNull();
      }
    },
  );

  it("retains the latest 32 consumed identities independently of pending and success notices", async () => {
    const { createUpdateNoticeSession } = await import("./update-success-notice.ts");
    getSafeSessionStorageMock.mockReturnValue(createStorageMock());
    const scope = { gateway: "ws://gateway.test", profileId: null };
    const session = createUpdateNoticeSession(scope.gateway);
    for (let index = 0; index <= 32; index += 1) {
      session.recordTriage(scope, String(index));
    }
    session.write({
      ...scope,
      kind: "handoff",
      requestId: "pending-request",
      handoffId: "pending-handoff",
      expectedVersion: "2.0.0",
      expectedSha: null,
      deadlineAtMs: Date.now() + 1_000,
    });

    const otherScope = { ...scope, gateway: "ws://other.test" };
    const other = createUpdateNoticeSession(otherScope.gateway);
    expect(other.notice).toBeNull();
    expect(other.hasTriaged(scope, "0")).toBe(false);
    expect(other.hasTriaged(scope, "1")).toBe(true);
    expect(other.hasTriaged(scope, "32")).toBe(true);
    expect(other.hasTriaged(otherScope, "32")).toBe(false);
    other.announceVerifiedInstall({ version: "2.0.0", sha: null }, otherScope);

    const reloaded = createUpdateNoticeSession(scope.gateway);
    expect(reloaded.notice).toBeNull();
    expect(reloaded.hasTriaged(scope, "1")).toBe(true);
    expect(reloaded.hasTriaged(scope, "32")).toBe(true);
  });
});
