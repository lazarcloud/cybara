import { loadPersistedSessionMessage } from "../../core/session-context";
import { readArchivedToolOutput } from "../../core/tool-output-recovery";
import type { ToolCallInfo } from "../chat-process-activities";
import { sanitizeSessionMessages, type RouteHandler } from "./_shared";
import { truncateToolResultForTransport } from "./tool-result-transport";

const TOOL_CALL_DETAIL_MAX_STRING_CHARS = 250_000;
const TOOL_CALL_DETAIL_MAX_TOTAL_CHARS = 400_000;
const TOOL_CALL_DETAIL_MAX_ARRAY_ITEMS = 200;

export interface ToolCallDetailView {
  id: string;
  name: string;
  status: ToolCallInfo["status"];
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
}

function normalizedId(value: string): string {
  return value.trim().toLowerCase();
}

async function resultWithArchivedOutput(result: unknown): Promise<unknown> {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  if (typeof record.output !== "string") return result;
  const archived = await readArchivedToolOutput(record.output, TOOL_CALL_DETAIL_MAX_STRING_CHARS);
  return archived === undefined ? result : { ...record, output: archived };
}

export async function toolCallDetailView(
  toolCalls: ToolCallInfo[] | undefined,
  toolCallId: string
): Promise<ToolCallDetailView | null> {
  const wanted = normalizedId(toolCallId);
  if (!wanted || !toolCalls) return null;
  const call = toolCalls.find(
    (candidate) => typeof candidate.id === "string" && normalizedId(candidate.id) === wanted
  );
  if (!call) return null;
  const transportOptions = {
    maxStringChars: TOOL_CALL_DETAIL_MAX_STRING_CHARS,
    maxTotalChars: TOOL_CALL_DETAIL_MAX_TOTAL_CHARS,
    maxArrayItems: TOOL_CALL_DETAIL_MAX_ARRAY_ITEMS,
  };
  const result = await resultWithArchivedOutput(call.result);
  return {
    id: call.id,
    name: call.name,
    status: call.status,
    args: (truncateToolResultForTransport(call.args ?? {}, {
      maxStringChars: 4_000,
      maxTotalChars: 16_000,
    }) ?? {}) as Record<string, unknown>,
    ...(result !== undefined
      ? { result: truncateToolResultForTransport(result, transportOptions) }
      : {}),
    ...(typeof call.error === "string" ? { error: call.error } : {}),
  };
}

export const sessionMessageDetailRoutes: Record<string, RouteHandler> = {
  "GET /api/sessions/:sessionId/messages/:messageId": async (_body, params) => {
    const message = await loadPersistedSessionMessage(params!.sessionId, params!.messageId);
    if (!message) return { error: "Message not found" };
    return sanitizeSessionMessages([message])[0];
  },
  "GET /api/sessions/:sessionId/messages/:messageId/tool-calls/:toolCallId": async (
    _body,
    params
  ) => {
    const message = await loadPersistedSessionMessage(params!.sessionId, params!.messageId);
    if (!message) return { error: "Message not found" };
    const detail = await toolCallDetailView(message.tool_calls, params!.toolCallId);
    if (!detail) return { error: "Tool call not found" };
    return detail;
  },
};
