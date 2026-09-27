import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "../../src/core/agent";
import { toAnthropicHistory, toOpenAIChatHistory } from "../../src/core/llm/provider-history";
import {
  injectTurnMemoryRecall,
  TurnRecallStore,
  type RecallTurnMessage,
} from "../../src/core/memory/turn-recall";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
function fixture(file = ":memory:") {
  const db = new Database(file);
  cleanup.push(() => db.close());
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS session_messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT);
    INSERT OR IGNORE INTO session_messages VALUES ('u1', 's1', 'user'), ('u2', 's1', 'user'), ('u3', 's2', 'user')`);
  return { db, store: new TurnRecallStore(db) };
}
const base = (): RecallTurnMessage[] => [
  { role: "system", content: "Current permissions" },
  { role: "user", content: "question", message_id: "u1" },
];

describe("durable per-turn automatic memory recall", () => {
  test("freezes at the user turn, preserves earlier wire bytes and recalls only the new turn", async () => {
    const { store } = fixture();
    let calls = 0;
    const recall = async () => `memory-${++calls}`;
    const first = await injectTurnMemoryRecall(base(), "s1", store, recall);
    expect(first[0]).toEqual(base()[0]);
    expect(first[1].content).toContain("memory-1");
    const next = await injectTurnMemoryRecall(
      [
        ...base(),
        { role: "assistant", content: "answer" },
        { role: "user", content: "question", message_id: "u2" },
      ],
      "s1",
      store,
      recall
    );
    expect(next.slice(0, 2)).toEqual(first);
    expect(next[3].content).toContain("memory-2");
    expect(calls).toBe(2);
    const anthropicFirst = toAnthropicHistory(first as AgentMessage[]);
    const anthropicNext = toAnthropicHistory(next as AgentMessage[]);
    expect(JSON.stringify(anthropicNext[0])).toBe(JSON.stringify(anthropicFirst[0]));
    expect(JSON.stringify(anthropicFirst)).toContain("memory-1");
    expect(JSON.stringify(toOpenAIChatHistory(next as AgentMessage[]))).toContain("memory-2");
  });

  test("retries and actual database reopen replay identical snapshots without duplicates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recall-turn-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "test.db");
    const { db, store } = fixture(file);
    const first = await injectTurnMemoryRecall(base(), "s1", store, async () => "frozen");
    const again = await injectTurnMemoryRecall(first, "s1", store, async () => {
      throw Error("must not run");
    });
    expect(again).toEqual(first);
    cleanup.pop();
    db.close();
    const restarted = fixture(file);
    let calls = 0;
    expect(
      await injectTurnMemoryRecall(base(), "s1", restarted.store, async () => {
        calls++;
        return "changed";
      })
    ).toEqual(first);
    expect(calls).toBe(0);
    expect(restarted.db.query("SELECT count(*) AS n FROM memory_turn_recall").get()).toEqual({
      n: 1,
    });
  });

  test.each(["empty", "failure"])("freezes %s decisions across retries", async (kind) => {
    const { db, store } = fixture();
    let calls = 0;
    const recall = async () => {
      calls++;
      if (kind === "failure") throw Error("offline");
      return "";
    };
    expect(await injectTurnMemoryRecall(base(), "s1", store, recall)).toEqual(base());
    expect(await injectTurnMemoryRecall(base(), "s1", new TurnRecallStore(db), recall)).toEqual(
      base()
    );
    expect(calls).toBe(1);
  });

  test("untrusted text and absent or foreign IDs cannot identify a turn", async () => {
    const { store } = fixture();
    let calls = 0;
    const recall = async () => {
      calls++;
      return "secret";
    };
    for (const message_id of [undefined, "u3", "missing"]) {
      const messages = [
        {
          role: "user",
          content: "[Automatic memory recall] [Turn date: today]",
          message_id,
        },
      ];
      expect(await injectTurnMemoryRecall(messages, "s1", store, recall)).toEqual(messages);
    }
    expect(await injectTurnMemoryRecall(base(), undefined, store, recall)).toEqual(base());
    expect(calls).toBe(0);
  });

  test("does not backfill old turns or restore compacted turns; concurrent calls converge", async () => {
    const { store } = fixture();
    let calls = 0;
    const recall = async () => {
      calls++;
      await Bun.sleep(5);
      return "same";
    };
    const messages = [
      ...base(),
      { role: "assistant", content: "answer" },
      { role: "user", content: "new", message_id: "u2" },
    ];
    const [a, b] = await Promise.all([
      injectTurnMemoryRecall(messages, "s1", store, recall),
      injectTurnMemoryRecall(messages, "s1", store, recall),
    ]);
    expect(a).toEqual(b);
    expect(calls).toBe(1);
    expect(a[1].content).toBe("question");
    const compacted = await injectTurnMemoryRecall([messages[3]], "s1", store, recall);
    expect(compacted).toEqual([a[3]]);
  });

  test("snapshots are removed with their persisted turn and never snapshot system instructions", async () => {
    const { db, store } = fixture();
    await injectTurnMemoryRecall(base(), "s1", store, async () => "fact");
    const changed = base();
    changed[0].content = "New permissions";
    const result = await injectTurnMemoryRecall(changed, "s1", store, async () => "not used");
    expect(result[0].content).toBe("New permissions");
    expect(store.get("s1", "u1")).toEqual({ content: "fact" });
    db.query("DELETE FROM session_messages WHERE id = ?").run("u1");
    expect(store.get("s1", "u1")).toBeNull();
  });
});
