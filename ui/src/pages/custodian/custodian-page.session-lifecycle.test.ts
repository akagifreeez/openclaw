/* @vitest-environment jsdom */

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { buildSystemAgentSessionInvalidatedErrorDetails } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";

type MountedCustodianPage = Awaited<ReturnType<typeof mountPage>>["page"];

async function sendMessage(page: MountedCustodianPage, message: string): Promise<void> {
  const composer = page.querySelector<HTMLTextAreaElement>("textarea")!;
  composer.value = message;
  composer.dispatchEvent(new Event("input"));
  await page.updateComplete;
  page.querySelector<HTMLButtonElement>(".chat-send-btn")!.click();
}

describe("custodian page session lifecycle", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it.each([
    { action: "composer", invalidated: true },
    { action: "cancel", invalidated: true },
    { action: "option", invalidated: true },
    { action: "cancel", invalidated: false },
    { action: "option", invalidated: false },
    { action: "next sensitive prompt", invalidated: false },
  ])(
    "retires input safely after $action (session invalidated: $invalidated)",
    async ({ action, invalidated }) => {
      const sensitive = action !== "composer";
      const request = vi
        .fn()
        .mockResolvedValueOnce({
          sessionId: "engine-session-before-error",
          reply: "Welcome.",
          action: "none",
          sensitive,
          ...(sensitive
            ? {
                question: {
                  id: "credentials",
                  header: "Credentials",
                  question: "Enter a credential or choose another method.",
                  options: [{ label: "Use environment" }, { label: "Configure later" }],
                },
              }
            : {}),
        })
        .mockImplementationOnce(() => {
          if (invalidated) {
            throw new GatewayProtocolRequestError({
              code: "UNAVAILABLE",
              message: "OpenClaw inference became unavailable.",
              details: buildSystemAgentSessionInvalidatedErrorDetails(),
            });
          }
          return {
            sessionId: "engine-session-before-error",
            reply: "Ready again.",
            action: "none",
            sensitive: action === "next sensitive prompt",
          };
        })
        .mockResolvedValue({
          sessionId: "engine-session-after-error",
          reply: "Ready again.",
          action: "none",
        });
      const { context } = createContext(request);
      const { page } = await mountPage(context);
      await waitForFast(() => expect(page.textContent).toContain("Welcome."));
      const sensitiveDraft = "test-token-placeholder";

      if (sensitive) {
        const password = page.querySelector<HTMLInputElement>('input[type="password"]')!;
        password.value = sensitiveDraft;
        password.dispatchEvent(new Event("input"));
        await page.updateComplete;
        const selector = action === "cancel" ? ".option-card__skip" : ".option-card__choice";
        page.querySelector<HTMLButtonElement>(selector)!.click();
      } else {
        await sendMessage(page, "status please");
      }

      await waitForFast(() => expect(page.textContent).toContain("Ready again."));
      const settledRequestCount = invalidated ? 3 : 2;
      expect(request).toHaveBeenCalledTimes(settledRequestCount);
      if (invalidated) {
        expect(request.mock.calls[2]?.[1]).toMatchObject({
          sessionId: expect.stringMatching(/^control-ui-onboarding-/),
        });
        expect(request.mock.calls[2]?.[1]?.sessionId).not.toBe("engine-session-before-error");
        expect(request.mock.calls[2]?.[1]).not.toHaveProperty("message");
        expect(page.textContent).toContain("Earlier");
        expect(page.textContent).toContain("started a fresh session");
      }
      if (sensitive) {
        const composer = page.querySelector<HTMLTextAreaElement | HTMLInputElement>(
          action === "next sensitive prompt" ? 'input[type="password"]' : "textarea",
        )!;
        expect.soft(composer.value).toBe("");
        composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        await waitForFast(() => expect(page.store.sending).toBe(false));
        await page.updateComplete;
        expect.soft(request).toHaveBeenCalledTimes(settledRequestCount);
        expect(page.textContent).not.toContain(sensitiveDraft);
        expect(request.mock.calls.some(([, params]) => params.message === sensitiveDraft)).toBe(
          false,
        );
      }
    },
  );

  it.each([
    { prompt: "composer", invalidated: false },
    { prompt: "composer", invalidated: true },
    { prompt: "wizard", invalidated: false },
    { prompt: "wizard", invalidated: true },
  ])(
    "restores an ordinary draft after a sensitive $prompt (session invalidated: $invalidated)",
    async ({ prompt, invalidated }) => {
      const question = {
        id: "credentials",
        header: "Credentials",
        question: "How should OpenClaw authenticate?",
        options: [{ label: "Enter credential" }, { label: "Use environment" }],
      };
      const request = vi
        .fn()
        .mockResolvedValueOnce({ sessionId: "draft-session", reply: "Ready.", question })
        .mockResolvedValueOnce({
          sessionId: "draft-session",
          reply: "Enter the credential.",
          sensitive: true,
          ...(prompt === "wizard"
            ? {
                wizardInputPending: true,
                step: { id: "credential", type: "text", message: "Credential", sensitive: true },
              }
            : { question }),
        })
        .mockImplementationOnce(() => {
          if (invalidated) {
            throw new GatewayProtocolRequestError({
              code: "UNAVAILABLE",
              message: "The sensitive session expired.",
              details: buildSystemAgentSessionInvalidatedErrorDetails(),
            });
          }
          return { sessionId: "draft-session", reply: "Ready again." };
        })
        .mockResolvedValue({ sessionId: "replacement-session", reply: "Ready again." });
      const { context } = createContext(request);
      const { page } = await mountPage(context);
      await waitForFast(() => expect(page.textContent).toContain("Ready."));
      const draft = "Keep my ordinary question";
      const composer = page.querySelector<HTMLTextAreaElement>("textarea")!;
      composer.value = draft;
      composer.dispatchEvent(new Event("input"));
      await page.updateComplete;
      page.querySelector<HTMLButtonElement>(".option-card__choice")!.click();
      const password = await waitForFast(() => {
        const field = page.querySelector<HTMLInputElement>('input[type="password"]');
        expect(field).not.toBeNull();
        return field!;
      });
      expect.soft(password.value).toBe("");
      const secret = "test-token-placeholder";
      password.value = secret;
      password.dispatchEvent(new Event("input"));
      await page.updateComplete;
      const cancel =
        prompt === "wizard" ? ".custodian__wizard-cancel" : ".option-card__skip:not([disabled])";
      page.querySelector<HTMLButtonElement>(cancel)!.click();
      await waitForFast(() => expect(page.textContent).toContain("Ready again."));
      const restored = page.querySelector<HTMLTextAreaElement>("textarea")!;
      expect(restored.value).toBe(draft);
      expect(page.textContent).not.toContain(secret);
      expect(request.mock.calls.some(([, params]) => params.message === secret)).toBe(false);
      restored.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await waitForFast(() => expect(request.mock.calls.at(-1)?.[1]?.message).toBe(draft));
      await page.updateComplete;
      expect(restored.value).toBe("");
    },
  );

  it("starts fresh after the gateway evicts a typed wizard session", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "evicted-wizard-session",
        reply: "Choose a channel.",
        action: "none",
        wizardInputPending: true,
        step: {
          id: "channel",
          type: "select",
          message: "Which channel?",
          options: [
            { label: "Slack", value: "slack" },
            { label: "Twitch", value: "twitch" },
          ],
        },
      })
      .mockRejectedValueOnce(
        new GatewayProtocolRequestError({
          code: "INVALID_REQUEST",
          message: "No active OpenClaw chat session is awaiting that wizard answer.",
          details: buildSystemAgentSessionInvalidatedErrorDetails(),
        }),
      )
      .mockResolvedValueOnce({
        sessionId: "replacement-session",
        reply: "Fresh session ready.",
        action: "none",
      });
    const { context } = createContext(request);
    const { page } = await mountPage(context);
    await waitForFast(() =>
      expect(page.querySelectorAll('.custodian__wizard-step input[type="radio"]')).toHaveLength(2),
    );

    page
      .querySelectorAll<HTMLInputElement>('.custodian__wizard-step input[type="radio"]')[1]!
      .click();
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".custodian__wizard-step .btn.primary")!.click();

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      sessionId: "evicted-wizard-session",
      wizardAnswer: { stepId: "channel", value: "twitch" },
    });
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("message");
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("wizardAnswer");
    expect(request.mock.calls[2]?.[1]?.sessionId).not.toBe("evicted-wizard-session");
    await waitForFast(() => expect(page.textContent).toContain("Fresh session ready."));
    expect(page.querySelector(".custodian__wizard-step")).toBeNull();
  });

  it("starts fresh without replaying an invalidated typed wizard cancel", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "evicted-cancel-session",
        reply: "Enter the token.",
        action: "none",
        wizardInputPending: true,
        step: {
          id: "token",
          type: "text",
          message: "Bot token",
          sensitive: true,
        },
      })
      .mockRejectedValueOnce(
        new GatewayProtocolRequestError({
          code: "INVALID_REQUEST",
          message: "No active OpenClaw chat session is awaiting that wizard cancel.",
          details: buildSystemAgentSessionInvalidatedErrorDetails(),
        }),
      )
      .mockResolvedValueOnce({
        sessionId: "replacement-session",
        reply: "Fresh session ready.",
        action: "none",
      });
    const { context } = createContext(request);
    const { page } = await mountPage(context);
    const cancel = await waitForFast(() => {
      const button = page.querySelector<HTMLButtonElement>(".custodian__wizard-cancel");
      expect(button).not.toBeNull();
      return button!;
    });

    cancel.click();

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      sessionId: "evicted-cancel-session",
      wizardCancel: { stepId: "token" },
    });
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("message");
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("wizardCancel");
    expect(request.mock.calls[2]?.[1]?.sessionId).not.toBe("evicted-cancel-session");
    await waitForFast(() => expect(page.textContent).toContain("Fresh session ready."));
    expect(page.querySelector(".custodian__wizard-step")).toBeNull();
  });

  it("keeps the live session after an error that does not invalidate it", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "engine-session-that-survives",
        reply: "Welcome.",
        action: "none",
      })
      .mockRejectedValueOnce(
        new GatewayProtocolRequestError({
          code: "UNAVAILABLE",
          message: "Temporary request failure.",
        }),
      )
      .mockResolvedValueOnce({
        sessionId: "engine-session-that-survives",
        reply: "Still together.",
        action: "none",
      });
    const { context } = createContext(request);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(page.textContent).toContain("Welcome."));

    await sendMessage(page, "first try");
    await waitForFast(() => expect(page.textContent).toContain("Temporary request failure."));
    await sendMessage(page, "second try");

    await waitForFast(() => expect(page.textContent).toContain("Still together."));
    expect(request.mock.calls[2]?.[1]).toMatchObject({
      sessionId: "engine-session-that-survives",
      message: "second try",
    });
  });

  it("stops after one rotation when the fresh session failure is also marked", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "engine-session-before-outage",
        reply: "Welcome.",
        action: "none",
      })
      .mockRejectedValueOnce(
        new GatewayProtocolRequestError({
          code: "UNAVAILABLE",
          message: "The live session was lost.",
          details: buildSystemAgentSessionInvalidatedErrorDetails(),
        }),
      )
      .mockRejectedValueOnce(
        new GatewayProtocolRequestError({
          code: "UNAVAILABLE",
          message: "Inference is still unavailable.",
          details: buildSystemAgentSessionInvalidatedErrorDetails(),
        }),
      );
    const { context } = createContext(request);
    const { page } = await mountPage(context);
    await waitForFast(() => expect(page.textContent).toContain("Welcome."));

    await sendMessage(page, "status please");

    await waitForFast(() => expect(page.textContent).toContain("Inference is still unavailable."));
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("message");
  });
});
