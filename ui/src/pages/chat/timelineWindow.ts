export const TIMELINE_INITIAL_VISIBLE_COUNT = 60;
export const TIMELINE_EXPAND_STEP = 60;
export const TIMELINE_APPEND_FOLLOW_LIMIT = 24;
export const TIMELINE_PRELOAD_MARGIN_PX = 1600;

export interface TimelineWindowState {
  key: string | null;
  total: number;
  visibleCount: number;
}

export function resolveTimelineWindow(
  previous: TimelineWindowState | null,
  key: string | null,
  total: number,
  initialVisibleCount: number = TIMELINE_INITIAL_VISIBLE_COUNT
): TimelineWindowState {
  const normalizedTotal = Math.max(0, Math.floor(total));
  if (!previous || previous.key !== key) {
    return { key, total: normalizedTotal, visibleCount: initialVisibleCount };
  }
  if (previous.total === normalizedTotal) return previous;
  const appended = normalizedTotal - previous.total;
  const followsAppend = appended > 0 && appended <= TIMELINE_APPEND_FOLLOW_LIMIT;
  return {
    key,
    total: normalizedTotal,
    visibleCount: followsAppend ? previous.visibleCount + appended : previous.visibleCount,
  };
}

export function expandTimelineWindow(
  state: TimelineWindowState,
  step: number = TIMELINE_EXPAND_STEP
): TimelineWindowState {
  if (state.visibleCount >= state.total) return state;
  return { ...state, visibleCount: Math.min(state.total, state.visibleCount + step) };
}

export function timelineWindowStart(state: TimelineWindowState): number {
  return Math.max(0, state.total - state.visibleCount);
}

export function preservedScrollTop(
  previousScrollTop: number,
  previousScrollHeight: number,
  nextScrollHeight: number
): number {
  return Math.max(0, previousScrollTop + (nextScrollHeight - previousScrollHeight));
}
