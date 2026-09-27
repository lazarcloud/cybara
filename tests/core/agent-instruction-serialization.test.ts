import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "../../src/core/agent";
import {
  AGENT_TRANSITION_AUTHORITY,
  restoreInstructionLedger,
} from "../../src/core/agent-instruction-update";
import { AgentProviderCodexRuntime } from "../../src/core/agent-provider-codex-runtime";
import { toAnthropicInstructionHistory } from "../../src/core/llm/provider-history";

const baseline: AgentMessage[] = [
  { role: "system", content: AGENT_TRANSITION_AUTHORITY + "\nAgent A" },
  { role: "user", content: "Question A" },
  { role: "assistant", content: "Answer A" },
];
const transition = (agentId: string, historyOffset: number): AgentMessage => ({
  role: "system",
  content: `Agent ${agentId}`,
  instructionUpdate: { kind: "agent-transition", agentId, historyOffset },
});

describe("chronological instruction requests", () => {
  test("Codex actual input serialization keeps instructions and input prefix unchanged", () => {
    const build = (
      AgentProviderCodexRuntime.prototype as unknown as {
        buildOpenAICodexInputFromMessages(messages: AgentMessage[]): {
          instructions: string;
          input: Record<string, unknown>[];
        };
      }
    ).buildOpenAICodexInputFromMessages;
    const before = build.call({}, baseline);
    const switched = [
      ...baseline,
      transition("B", 2),
      { role: "user" as const, content: "Question B" },
      { role: "assistant" as const, content: "Answer B" },
    ];
    const after = build.call({}, switched);
    expect(after.instructions).toBe(before.instructions);
    expect(JSON.stringify(after.input.slice(0, before.input.length))).toBe(
      JSON.stringify(before.input)
    );
    expect(after.input[before.input.length]?.role).toBe("developer");
    const back = build.call({}, [...switched, transition("A", 4)]);
    expect(back.instructions).toBe(before.instructions);
    expect(JSON.stringify(back.input.slice(0, after.input.length))).toBe(
      JSON.stringify(after.input)
    );
  });
  test("Anthropic actual request system and serialized history prefix survive switches", () => {
    const before = toAnthropicInstructionHistory(baseline);
    const after = toAnthropicInstructionHistory([...baseline, transition("B", 2)]);
    expect(after.system).toEqual(before.system);
    expect(JSON.stringify(after.messages.slice(0, before.messages.length))).toBe(
      JSON.stringify(before.messages)
    );
    expect(after.messages.at(-1)?.role).toBe("user");
    expect(JSON.stringify(after.messages.at(-1))).toContain("server_agent_transition");
    expect(before.system[0]?.text).toContain("Platform and security instructions remain in force");
  });
  test("ledger restores A B A between users rather than hoisting stale authority", () => {
    const history = [
      ...baseline,
      transition("B", 2),
      { role: "user" as const, content: "Question B" },
      { role: "assistant" as const, content: "Answer B" },
      transition("A", 4),
      { role: "user" as const, content: "Question A again" },
    ];
    const ledger = JSON.parse(
      JSON.stringify(history.filter((message) => message.role === "system"))
    );
    expect(
      restoreInstructionLedger(
        history.filter((message) => message.role !== "system"),
        ledger
      )
    ).toEqual(history);
    expect(restoreInstructionLedger(history.slice(4), ledger, 2)).toEqual([
      baseline[0],
      history[3],
      ...history.slice(4),
    ]);
  });
});
