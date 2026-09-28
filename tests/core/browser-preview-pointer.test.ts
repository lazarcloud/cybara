import { describe, expect, test } from "bun:test";
import {
  browserPointerStreamMessage,
  shouldBroadcastPointerChange,
} from "../../src/core/browser/preview-cursor";
import { newestBrowserPointer } from "../../ui/src/pages/chat/browserPreviewInteraction";

const pointer = (overrides: Partial<Parameters<typeof browserPointerStreamMessage>[0]> = {}) => ({
  x: 10,
  y: 20,
  visible: true,
  updatedAt: 1_000,
  action: "move" as const,
  source: "agent" as const,
  ...overrides,
});

describe("browser preview pointer streaming", () => {
  test("streams agent pointer moves and the hand-off back to the user", () => {
    expect(shouldBroadcastPointerChange(undefined, { source: "agent" })).toBe(true);
    expect(shouldBroadcastPointerChange({ source: "user" }, { source: "agent" })).toBe(true);
    expect(shouldBroadcastPointerChange({ source: "agent" }, { source: "user" })).toBe(true);
  });

  test("does not echo the user's own hover moves back over the socket", () => {
    expect(shouldBroadcastPointerChange(undefined, { source: "user" })).toBe(false);
    expect(shouldBroadcastPointerChange({ source: "user" }, { source: "user" })).toBe(false);
  });

  test("serializes only the pointer contract fields", () => {
    const withExtras = { ...pointer({ action: "click" }), secret: "nope", page: { url: "x" } };
    const message = JSON.parse(browserPointerStreamMessage(withExtras));
    expect(message).toEqual({
      type: "pointer",
      pointer: { x: 10, y: 20, visible: true, updatedAt: 1_000, action: "click", source: "agent" },
    });
  });

  test("the overlay follows whichever pointer update is newest", () => {
    const streamed = pointer({ updatedAt: 2_000, x: 50 });
    const polled = pointer({ updatedAt: 1_500, x: 5 });
    expect(newestBrowserPointer(streamed, polled)).toBe(streamed);
    expect(newestBrowserPointer(pointer({ updatedAt: 1_000 }), polled)).toBe(polled);
    expect(newestBrowserPointer(null, polled)).toBe(polled);
    expect(newestBrowserPointer(streamed, null)).toBe(streamed);
    expect(newestBrowserPointer(null, null)).toBeNull();
  });
});
