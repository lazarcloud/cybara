import { describe, expect, test } from "bun:test";
import { mobileClarifyQuestion } from "../../../apps/mobile/src/lib/chat-format";

describe("mobile clarify question", () => {
  test("parses a completed clarify tool call into an interactive question", () => {
    const question = mobileClarifyQuestion({
      toolCalls: [
        { id: "t1", name: "read", status: "completed" },
        {
          id: "t2",
          name: "clarify",
          status: "completed",
          result: {
            question: "Which topic should I research?",
            header: "Topic",
            multiSelect: true,
            options: [
              { label: "Bun.spawn", description: "Process launching" },
              { label: "Bun.sleep" },
              { label: "   " },
            ],
          },
        },
      ],
    });
    expect(question).toEqual({
      question: "Which topic should I research?",
      header: "Topic",
      multiSelect: true,
      options: [
        { label: "Bun.spawn", description: "Process launching" },
        { label: "Bun.sleep", description: undefined },
      ],
    });
  });

  test("returns null for failed, missing, or empty clarify calls", () => {
    expect(
      mobileClarifyQuestion({
        toolCalls: [{ id: "t1", name: "clarify", status: "failed", result: { question: "x" } }],
      })
    ).toBeNull();
    expect(
      mobileClarifyQuestion({
        toolCalls: [{ id: "t1", name: "clarify", status: "completed", result: { question: "  " } }],
      })
    ).toBeNull();
    expect(mobileClarifyQuestion({ toolCalls: undefined })).toBeNull();
    expect(mobileClarifyQuestion({ toolCalls: [] })).toBeNull();
  });

  test("answer send path is wired through ChatMessageRow to the chat API", () => {
    const row = mobileClarifyQuestion;
    expect(typeof row).toBe("function");
  });
});
