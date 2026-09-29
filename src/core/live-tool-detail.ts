import {
  formatExpandedToolActivityDetail,
  LIVE_TOOL_DETAIL_LIMITS,
} from "../../shared/tool-activity-detail";

export const LIVE_TOOL_DETAIL_MAX_CHARS = 24_000;

export function liveToolFullDetail(
  toolName: string,
  args: Record<string, unknown>,
  phase: "start" | "result" | "error" | "blocked",
  result?: unknown
): string | undefined {
  let detail: string | undefined;
  try {
    detail = formatExpandedToolActivityDetail(
      toolName,
      args,
      phase,
      result,
      LIVE_TOOL_DETAIL_LIMITS
    )?.trim();
  } catch {
    return undefined;
  }
  if (!detail) return undefined;
  return detail.length > LIVE_TOOL_DETAIL_MAX_CHARS
    ? `${detail.slice(0, LIVE_TOOL_DETAIL_MAX_CHARS)}…`
    : detail;
}
