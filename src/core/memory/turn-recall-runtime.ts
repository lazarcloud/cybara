import db from "../database";
import { injectTurnMemoryRecall, TurnRecallStore, type RecallTurnMessage } from "./turn-recall";

const store = new TurnRecallStore(db);

export function injectPersistedMemoryRecall<T extends RecallTurnMessage>(
  messages: T[],
  sessionId: string | undefined,
  recall: (query: string) => Promise<string>
): Promise<T[]> {
  return injectTurnMemoryRecall(messages, sessionId, store, recall);
}
