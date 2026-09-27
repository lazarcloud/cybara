import { describe, expect, test } from "bun:test";
import { buildChatExecutionMessagesForAgent } from "../../src/api/chat-execution-messages";
import { datedTurnContent } from "../../src/core/prompt-time-context";
import { toAnthropicHistory, toOpenAIChatHistory } from "../../src/core/llm/provider-history";
import type { ChatMessage } from "../../src/api/chat-types";

function user(id: string, timestamp?: string): ChatMessage {
  return { id, role: "user", content: "What is today's date?", timestamp };
}

describe("immutable dated prompt context", () => {
  for (const [name, before, after] of [
    ["midnight", "2026-09-26T23:59:59Z", "2026-09-27T00:00:01Z"],
    ["year", "2026-12-31T23:59:59Z", "2027-01-01T00:00:01Z"],
    ["spring DST", "2026-03-08T01:59:59-07:00", "2026-03-08T03:00:01-06:00"],
    ["fall DST", "2026-11-01T01:59:59-06:00", "2026-11-01T01:00:01-07:00"],
    ["same day", "2026-09-26T10:00:00Z", "2026-09-26T11:00:00Z"],
    ["offset midnight", "2026-09-26T23:59:59+12:00", "2026-09-27T00:00:01+12:00"],
  ]) {
    test(`${name}: provider prefix stays identical and new turn is fresh`, () => {
      const history: ChatMessage[] = [
        user("one", before),
        { role: "assistant", content: "Acknowledged" },
      ];
      const original = JSON.stringify(history);
      const first = buildChatExecutionMessagesForAgent(history);
      const later = buildChatExecutionMessagesForAgent([...history, user("two", after)]);
      expect(later.slice(0, first.length)).toEqual(first);
      expect(toOpenAIChatHistory(later).slice(0, first.length)).toEqual(toOpenAIChatHistory(first));
      expect(toAnthropicHistory(later).slice(0, first.length)).toEqual(toAnthropicHistory(first));
      expect(later.at(-1)?.content).toContain(new Date(after).toISOString());
      expect(JSON.stringify(history)).toBe(original);
      expect(buildChatExecutionMessagesForAgent(history)).toEqual(first);
      expect(later.at(-1)?.content.split("<runtime-turn-context>")).toHaveLength(2);
    });
  }

  test("tool replay ordering and IDs remain intact", () => {
    const history: ChatMessage[] = [
      user("one", "2026-09-26T23:59:59Z"),
      {
        id: "assistant",
        role: "assistant",
        content: "Done",
        tool_calls: [{ id: "call", name: "read", args: { path: "x" }, result: "data" }],
      },
    ];
    const first = buildChatExecutionMessagesForAgent(history);
    const later = buildChatExecutionMessagesForAgent([
      ...history,
      user("two", "2026-09-27T00:00:01Z"),
    ]);
    expect(later.slice(0, first.length)).toEqual(first);
    expect(first.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(first[2]?.tool_call_id).toBe("call");
  });

  test("undated legacy and malformed timestamps never acquire a moving date", () => {
    for (const timestamp of [undefined, "", "invalid"]) {
      expect(datedTurnContent("hello", timestamp)).toBe("hello");
    }
    expect(datedTurnContent("", "2026-09-27T00:00:00Z")).toContain("2026-09-27T00:00:00.000Z");
  });
});
