import { createContext } from "react";
import { chatApi } from "@/lib/api";
import {
  formatExpandedToolActivityDetail,
  type ToolActivityPhase,
} from "../../../../shared/tool-activity-detail";

export interface ToolDetailSource {
  sessionId: string;
  messageId: string;
}

export const ToolDetailSourceContext = createContext<ToolDetailSource | null>(null);

const MAX_CACHED_DETAILS = 256;
const loadedDetails = new Map<string, string | null>();
const pendingDetails = new Map<string, Promise<string | null>>();

function detailKey(source: ToolDetailSource, callId: string, phase: ToolActivityPhase): string {
  return `${source.sessionId}\u0000${source.messageId}\u0000${callId.toLowerCase()}\u0000${phase}`;
}

export function peekToolCallDetail(
  source: ToolDetailSource,
  callId: string,
  phase: ToolActivityPhase
): string | null | undefined {
  return loadedDetails.get(detailKey(source, callId, phase));
}

export function loadToolCallDetail(
  source: ToolDetailSource,
  callId: string,
  phase: ToolActivityPhase
): Promise<string | null> {
  const key = detailKey(source, callId, phase);
  const cached = loadedDetails.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = pendingDetails.get(key);
  if (pending) return pending;
  const request = chatApi
    .getSessionToolCall(source.sessionId, source.messageId, callId)
    .then((response) => {
      const call = response.success ? response.data : undefined;
      const text =
        call && typeof call.name === "string"
          ? (formatExpandedToolActivityDetail(
              call.name,
              call.args ?? {},
              phase,
              call.result ?? call.error
            ) ?? null)
          : null;
      if (loadedDetails.size >= MAX_CACHED_DETAILS) loadedDetails.clear();
      loadedDetails.set(key, text);
      return text;
    })
    .catch(() => null)
    .finally(() => pendingDetails.delete(key));
  pendingDetails.set(key, request);
  return request;
}
