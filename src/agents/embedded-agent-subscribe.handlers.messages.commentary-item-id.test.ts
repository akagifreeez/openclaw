import { describe, expect, it, vi } from "vitest";
import { emitAssistantCommentaryStreamData } from "./embedded-agent-subscribe.handlers.messages.stream.js";
import { createMessageUpdateContext } from "./embedded-agent-subscribe.handlers.messages.test-helpers.js";

function genericCommentaryMessage(text: string, textSignature?: string) {
  return {
    role: "assistant",
    api: "anthropic-messages",
    stopReason: "toolUse",
    content: [
      { type: "text", text, ...(textSignature ? { textSignature } : {}) },
      { type: "toolCall", id: "tool-1", name: "bash", arguments: {} },
    ],
  } as never;
}

describe("emitAssistantCommentaryStreamData generic identity", () => {
  it("propagates the generated segment identity to the live preamble stream data", () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });

    emitAssistantCommentaryStreamData(
      context,
      genericCommentaryMessage(
        "Checking the fixture file.",
        JSON.stringify({ v: 1, id: "commentary-0-abc123def456", phase: "commentary" }),
      ),
    );

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "assistant",
      data: expect.objectContaining({
        phase: "commentary",
        itemId: "commentary-0-abc123def456",
        text: "Checking the fixture file.",
      }),
    });
  });

  it("keeps untagged generic commentary unkeyed", () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });

    emitAssistantCommentaryStreamData(context, genericCommentaryMessage("Checking."));

    const event = onAgentEvent.mock.calls[0]?.[0] as { data?: { itemId?: string } } | undefined;
    expect(event?.data?.itemId).toBeUndefined();
  });
});
