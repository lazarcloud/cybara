import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deleteSession } from "../../src/api/chat";
import { logSessionMessage } from "../../src/core/logging";
import { loadPersistedSessionMessage } from "../../src/core/session-context";

const createdSessionIds: string[] = [];

afterEach(async () => {
  while (createdSessionIds.length > 0) {
    const id = createdSessionIds.pop();
    if (id) await deleteSession(id);
  }
});

describe("logSessionMessage", () => {
  test("returns the id the message is stored under", async () => {
    const sessionId = `test-session-log-id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    createdSessionIds.push(sessionId);
    const messageId = await logSessionMessage(sessionId, "assistant", "logged reply", {
      agentId: "test-agent",
      metadata: {
        tool_calls: [{ id: "call-1", name: "exec", args: { command: "ls" }, status: "completed" }],
      },
    });
    expect(messageId).toBeTruthy();
    const stored = await loadPersistedSessionMessage(sessionId, messageId ?? "");
    expect(stored?.content).toBe("logged reply");
    expect(stored?.tool_calls?.[0]?.id).toBe("call-1");
  });

  test("the chat runtime stamps the response message with that id", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../src/api/chat-runtime.ts", import.meta.url)),
      "utf8"
    );
    expect(source).toContain(
      "if (loggedAssistantMessageId) assistantMessage.message_id = loggedAssistantMessageId;"
    );
  });
});
