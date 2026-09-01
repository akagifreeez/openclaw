// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { CUSTODIAN_PANEL_TOGGLE_EVENT } from "../components/panel-toggle-contract.ts";
import { custodianAlertStore } from "../pages/custodian/custodian-alert-store.ts";
import { createContext } from "../pages/custodian/custodian-page.test-harness.ts";
import { CustodianSessionStore } from "../pages/custodian/custodian-session-store.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { QUICK_ACTIONS_QUESTION } from "../test-helpers/custodian-quick-actions.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import { createApplicationOverlays } from "./overlays.ts";
import type { UpdateFailureTriage } from "./update-overlay-helpers.ts";
import { presentUpdateFailureTriage } from "./update-triage.runtime.ts";

const FAILURE: UpdateFailureTriage = {
  id: "recorded-attempt",
  outcome: "failed",
  banner: { tone: "danger", text: "Build failed" },
  attempt: {
    timestampMs: 1_000,
    status: "error",
    reason: "build-failed",
    installKind: "git",
    beforeVersion: "1.0.0",
    beforeSha: null,
    afterVersion: "2.0.0",
    afterSha: null,
    failure: { step: "build", detail: "Disk is full" },
  },
};

afterEach(() => {
  custodianAlertStore.dismiss();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("update triage presentation", () => {
  it("replaces greeting quick actions with one diagnostic turn carrying the recorded cause", async () => {
    const request = vi.fn(
      async (_method: string, params: { sessionId: string; message?: string }) => ({
        sessionId: params.sessionId,
        reply: "Inspecting the failed build before proposing a repair.",
        ...(!params.message ? { question: QUICK_ACTIONS_QUESTION } : {}),
      }),
    );
    const { context } = createContext(request);
    const provider = createApplicationContextProvider(context);
    const surface = document.createElement("openclaw-custodian-surface");
    surface.store = new CustodianSessionStore();
    provider.append(surface);
    document.body.append(provider);
    await surface.updateComplete;
    const admission = { isCurrent: () => true, admit: vi.fn(() => true) };
    const openPanel = vi.fn();
    window.addEventListener(CUSTODIAN_PANEL_TOGGLE_EVENT, openPanel, { once: true });

    presentUpdateFailureTriage(context, FAILURE, admission);
    await vi.waitFor(() => expect(admission.admit).toHaveBeenCalledOnce());
    await surface.updateComplete;

    expect(openPanel).toHaveBeenCalledOnce();
    const questions = request.mock.calls.filter(([, params]) => "message" in params);
    expect(questions).toHaveLength(1);
    expect(questions[0]?.[1]).toMatchObject({
      message: expect.stringContaining("Disk is full"),
    });
    expect(custodianAlertStore.alert?.question).toContain("Do not retry the update");
    expect(surface.textContent).toContain("build-failed");
    expect(surface.textContent).toContain("openclaw triage");
    surface.requestUpdate();
    await surface.updateComplete;
    expect(admission.admit).toHaveBeenCalledOnce();
  });

  it("waits for an active workflow question before admitting diagnostic triage", async () => {
    const request = vi.fn(
      async (_method: string, params: { sessionId: string; message?: string }) => ({
        sessionId: params.sessionId,
        reply: "Review the current access policy.",
        ...(!params.message
          ? {
              question: {
                id: "access",
                header: "Access",
                question: "How should OpenClaw work?",
                options: [{ label: "Full access" }, { label: "Ask first" }],
              },
            }
          : {}),
      }),
    );
    const { context } = createContext(request);
    const provider = createApplicationContextProvider(context);
    const surface = document.createElement("openclaw-custodian-surface");
    surface.store = new CustodianSessionStore();
    provider.append(surface);
    document.body.append(provider);
    await vi.waitFor(() =>
      expect(surface.querySelector('[data-option-value="Ask first"]')).not.toBeNull(),
    );
    const admission = { isCurrent: () => true, admit: vi.fn(() => true) };

    presentUpdateFailureTriage(context, FAILURE, admission);
    await surface.updateComplete;

    expect(admission.admit).not.toHaveBeenCalled();
    expect(request.mock.calls.filter(([, params]) => params.message)).toHaveLength(0);
    surface.querySelector<HTMLButtonElement>('[data-option-value="Ask first"]')?.click();
    await vi.waitFor(() => expect(admission.admit).toHaveBeenCalledOnce());
    const messages = request.mock.calls.flatMap(([, params]) => params.message ?? []);
    expect(messages).toEqual(["Ask first", expect.stringContaining("Disk is full")]);
  });

  it.each(["offline", "missing capability", "non-admin", "stale owner"])(
    "does not claim an agent launch for %s",
    (boundary) => {
      const request = vi.fn();
      const { context, setGatewaySnapshot } = createContext(
        request,
        boundary === "missing capability" ? [] : ["openclaw.chat"],
      );
      if (boundary === "offline") {
        setGatewaySnapshot({ phase: "reconnecting" });
      }
      if (boundary === "non-admin") {
        setGatewaySnapshot({
          hello: {
            auth: { role: "operator", scopes: ["operator.read"] },
          } as ApplicationGatewaySnapshot["hello"],
        });
      }
      const admission = { isCurrent: () => boundary !== "stale owner", admit: vi.fn(() => true) };
      presentUpdateFailureTriage(context, FAILURE, admission);

      expect(admission.admit).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(custodianAlertStore.alert).toBeNull();
      if (boundary === "stale owner") {
        expect(context.navigate).not.toHaveBeenCalled();
      } else {
        expect(context.navigate).toHaveBeenCalledExactlyOnceWith("updates");
      }
    },
  );

  it("keeps recorded facts visible without sending when no model is configured", async () => {
    const request = vi.fn();
    const { context } = createContext(request, ["openclaw.chat"], {
      agentsList: { defaultId: "main", mainKey: "main", scope: "global", agents: [{ id: "main" }] },
    });
    const provider = createApplicationContextProvider(context);
    const surface = document.createElement("openclaw-custodian-surface");
    surface.store = new CustodianSessionStore();
    provider.append(surface);
    document.body.append(provider);
    const admission = { isCurrent: () => true, admit: vi.fn(() => true) };
    presentUpdateFailureTriage(context, FAILURE, admission);
    await surface.updateComplete;

    expect(surface.textContent).toContain("Disk is full");
    expect(surface.textContent).toContain("openclaw triage");
    expect(admission.admit).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["administrator", "profile", "Gateway"])(
    "retires the facts before transport when %s changes during turn preparation",
    async (boundary) => {
      const request = vi.fn(async (method: string, params?: { sessionId?: string }) => {
        if (method === "update.run") {
          return {
            ok: false,
            result: { status: "error" },
            sentinel: {
              payload: {
                kind: "update",
                status: "error",
                ts: 1_000,
                stats: {
                  handoffId: "retired-attempt",
                  reason: "build-failed",
                  steps: [
                    { name: "build", log: { exitCode: 1, stderrTail: "Private diagnostic cause" } },
                  ],
                },
              },
            },
          };
        }
        return method === "openclaw.chat"
          ? { sessionId: params?.sessionId, reply: "Ready to inspect the installation." }
          : {};
      });
      const { context, setGatewaySnapshot } = createContext(request);
      const overlays = createApplicationOverlays(context.gateway, {
        onUpdateFailure: (failure, admission) =>
          presentUpdateFailureTriage(context, failure, admission),
      });
      const provider = createApplicationContextProvider(context);
      const surface = document.createElement("openclaw-custodian-surface");
      surface.store = new CustodianSessionStore();
      provider.append(surface);
      document.body.append(provider);
      await surface.updateComplete;
      await vi.waitFor(() => expect(surface.store.sending).toBe(false));
      let retire = true;
      const unsubscribe = surface.store.subscribe(() => {
        if (!retire || !surface.store.sending) {
          return;
        }
        retire = false;
        if (boundary === "administrator") {
          setGatewaySnapshot({
            hello: {
              ...context.gateway.snapshot.hello,
              auth: { role: "operator", scopes: ["operator.read"] },
            } as ApplicationGatewaySnapshot["hello"],
          });
        } else if (boundary === "profile") {
          setGatewaySnapshot({
            selfUser: { id: "replacement-profile" } as NonNullable<
              ApplicationGatewaySnapshot["selfUser"]
            >,
          });
        } else {
          context.gateway.connection.gatewayUrl = "ws://replacement.test";
          setGatewaySnapshot({});
        }
      });
      try {
        await overlays.runUpdate();
        await vi.waitFor(() => expect(retire).toBe(false));
        await surface.updateComplete;

        expect(
          request.mock.calls.filter(
            ([method, params]) => method === "openclaw.chat" && params && "message" in params,
          ),
        ).toHaveLength(0);
        expect(custodianAlertStore.alert).toBeNull();
        expect(surface.textContent).not.toContain("Private diagnostic cause");
        expect(
          surface.store.messages.every(
            (message) => !message.text.includes("Private diagnostic cause"),
          ),
        ).toBe(true);
      } finally {
        unsubscribe();
        overlays.dispose();
      }
    },
  );

  it("does not send an already consumed automatic question", async () => {
    const request = vi.fn(async (_method: string, params: { sessionId: string }) => ({
      sessionId: params.sessionId,
      reply: "Ready.",
    }));
    const { context } = createContext(request);
    const provider = createApplicationContextProvider(context);
    const surface = document.createElement("openclaw-custodian-surface");
    surface.store = new CustodianSessionStore();
    provider.append(surface);
    document.body.append(provider);
    await surface.updateComplete;
    const admission = { isCurrent: () => true, admit: vi.fn(() => false) };
    presentUpdateFailureTriage(context, FAILURE, admission);
    await vi.waitFor(() => expect(admission.admit).toHaveBeenCalledOnce());

    expect(request.mock.calls.filter(([, params]) => "message" in params)).toHaveLength(0);
    expect(
      surface.store.messages
        .filter((message) => message.role === "user")
        .map((message) => message.text),
    ).toEqual(["Diagnose failed update"]);
    expect(surface.store.canRetry()).toBe(false);
  });

  it("bounds and redacts diagnostic data before it reaches the agent question", () => {
    const { context } = createContext(vi.fn());
    presentUpdateFailureTriage(
      context,
      {
        ...FAILURE,
        outcome: "unknown",
        attempt: null,
        banner: { tone: "danger", text: `token=synthetic-secret ${"x".repeat(8_000)}` },
      },
      { isCurrent: () => true, admit: () => true },
    );

    const alert = custodianAlertStore.alert;
    expect(alert?.title).toContain("unknown update outcome");
    expect(alert?.question).not.toContain("synthetic-secret");
    expect(alert?.question.length).toBeLessThanOrEqual(2_400);
    expect(alert?.facts.every((fact) => fact.length <= 240)).toBe(true);
  });
});
