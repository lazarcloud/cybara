import { describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import type { ToolCallInfo } from "../../src/api/chat-process-activities";
import { toolCallDetailView } from "../../src/api/routes/session-message-details";
import { sanitizeSessionMessages, type SessionMessageView } from "../../src/api/routes/_shared";
import {
  ARCHIVED_OUTPUT_LINE_PREFIX,
  persistToolOutputForRecovery,
} from "../../src/core/tool-output-recovery";

const longOutput = "x".repeat(20_000);

const toolCalls: ToolCallInfo[] = [
  {
    id: "Call-A",
    name: "exec",
    args: { command: "cat big" },
    status: "completed",
    result: { output: longOutput, exitCode: 0 },
  },
  {
    id: "call-b",
    name: "edit",
    args: { path: "a.ts" },
    status: "failed",
    error: "oldText not found",
  },
];

describe("toolCallDetailView", () => {
  test("returns the full result while the list view stays truncated", async () => {
    const detail = await toolCallDetailView(toolCalls, "call-a");
    const result = detail?.result as { output: string };
    expect(result.output.length).toBe(20_000);

    const message: SessionMessageView = {
      role: "assistant",
      content: "done",
      tool_calls: toolCalls,
    };
    const listed = sanitizeSessionMessages([message])[0];
    const listedResult = listed.tool_calls?.[0]?.result as { output: string };
    expect(listedResult.output.length).toBeLessThan(1_000);
  });

  test("returns failures with their error text", async () => {
    const detail = await toolCallDetailView(toolCalls, " CALL-B ");
    expect(detail).toMatchObject({ name: "edit", status: "failed", error: "oldText not found" });
  });

  test("unknown or empty ids resolve to nothing", async () => {
    expect(await toolCallDetailView(toolCalls, "missing")).toBeNull();
    expect(await toolCallDetailView(toolCalls, "  ")).toBeNull();
    expect(await toolCallDetailView(undefined, "call-a")).toBeNull();
  });

  test("swaps a reduced receipt for the archived raw output", async () => {
    const archived = persistToolOutputForRecovery({
      content: "1\n2\n3",
      sessionId: "detail-view",
      toolName: "exec",
    });
    const receipt = `[Evidence Receipt] verified: sha256:abc\n${ARCHIVED_OUTPUT_LINE_PREFIX}${archived}\nSummary: counted`;
    const detail = await toolCallDetailView(
      [
        {
          id: "seq",
          name: "exec",
          args: { command: "seq 1 3" },
          status: "completed",
          result: { output: receipt, exitCode: 0 },
        },
      ],
      "seq"
    );
    expect((detail?.result as { output: string }).output).toBe("1\n2\n3");
    rmSync(archived!, { force: true });
  });

  test("keeps the receipt when the archive reference points elsewhere", async () => {
    const receipt = `[Evidence Receipt] verified\n${ARCHIVED_OUTPUT_LINE_PREFIX}/etc/hosts\nSummary: x`;
    const detail = await toolCallDetailView(
      [
        {
          id: "bad",
          name: "exec",
          args: { command: "x" },
          status: "completed",
          result: { output: receipt, exitCode: 0 },
        },
      ],
      "bad"
    );
    expect((detail?.result as { output: string }).output).toBe(receipt);
  });
});
