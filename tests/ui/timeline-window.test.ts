import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  expandTimelineWindow,
  preservedScrollTop,
  resolveTimelineWindow,
  TIMELINE_APPEND_FOLLOW_LIMIT,
  TIMELINE_EXPAND_STEP,
  TIMELINE_INITIAL_VISIBLE_COUNT,
  timelineWindowStart,
} from "../../ui/src/pages/chat/timelineWindow";

describe("chat timeline window", () => {
  test("a long chat opens with only its tail mounted", () => {
    const state = resolveTimelineWindow(null, "session-a", 4_583);
    expect(state.visibleCount).toBe(TIMELINE_INITIAL_VISIBLE_COUNT);
    expect(timelineWindowStart(state)).toBe(4_583 - TIMELINE_INITIAL_VISIBLE_COUNT);
  });

  test("short chats render every message", () => {
    const state = resolveTimelineWindow(null, "session-a", 12);
    expect(timelineWindowStart(state)).toBe(0);
  });

  test("streamed replies grow the window so rows above the viewport never unmount", () => {
    const opened = resolveTimelineWindow(null, "s", 500);
    const start = timelineWindowStart(opened);
    const appended = resolveTimelineWindow(opened, "s", 503);
    expect(timelineWindowStart(appended)).toBe(start);
    expect(appended.visibleCount).toBe(opened.visibleCount + 3);
  });

  test("a bulk history load after an empty first render still opens at the tail", () => {
    const empty = resolveTimelineWindow(null, "s", 0);
    const loaded = resolveTimelineWindow(empty, "s", 2_306);
    expect(loaded.visibleCount).toBe(TIMELINE_INITIAL_VISIBLE_COUNT);
    expect(timelineWindowStart(loaded)).toBe(2_306 - TIMELINE_INITIAL_VISIBLE_COUNT);
  });

  test("appends up to the follow limit grow the window, larger jumps do not", () => {
    const opened = resolveTimelineWindow(null, "s", 1_000);
    expect(
      resolveTimelineWindow(opened, "s", 1_000 + TIMELINE_APPEND_FOLLOW_LIMIT).visibleCount
    ).toBe(TIMELINE_INITIAL_VISIBLE_COUNT + TIMELINE_APPEND_FOLLOW_LIMIT);
    expect(
      resolveTimelineWindow(opened, "s", 1_001 + TIMELINE_APPEND_FOLLOW_LIMIT).visibleCount
    ).toBe(TIMELINE_INITIAL_VISIBLE_COUNT);
  });

  test("switching sessions resets the window", () => {
    const expanded = expandTimelineWindow(resolveTimelineWindow(null, "a", 1_000));
    const switched = resolveTimelineWindow(expanded, "b", 1_000);
    expect(switched.visibleCount).toBe(TIMELINE_INITIAL_VISIBLE_COUNT);
  });

  test("unchanged inputs keep the same state object so render-time sync is a no-op", () => {
    const state = resolveTimelineWindow(null, "s", 300);
    expect(resolveTimelineWindow(state, "s", 300)).toBe(state);
  });

  test("revealing earlier messages steps back and stops at the first message", () => {
    let state = resolveTimelineWindow(null, "s", 150);
    state = expandTimelineWindow(state);
    expect(state.visibleCount).toBe(TIMELINE_INITIAL_VISIBLE_COUNT + TIMELINE_EXPAND_STEP);
    state = expandTimelineWindow(state);
    expect(state.visibleCount).toBe(150);
    expect(timelineWindowStart(state)).toBe(0);
    expect(expandTimelineWindow(state)).toBe(state);
  });

  test("deleting or reverting messages clamps the window start at zero", () => {
    const state = resolveTimelineWindow(resolveTimelineWindow(null, "s", 400), "s", 20);
    expect(timelineWindowStart(state)).toBe(0);
  });

  test("prepending earlier rows keeps the reader's content in place", () => {
    expect(preservedScrollTop(120, 10_000, 14_500)).toBe(4_620);
    expect(preservedScrollTop(0, 10_000, 10_000)).toBe(0);
    expect(preservedScrollTop(10, 10_000, 9_000)).toBe(0);
  });

  test("timeline rows are memoized with stable callbacks", () => {
    const source = readFileSync("ui/src/pages/chat/ChatMessageTimeline.tsx", "utf8");
    expect(source).toContain("const ChatMessageRow = memo(");
    expect(source).toContain("const DeferredChatMessageRow = memo(");
    expect(source).toContain("latestHandlersRef.current.onCopyMessage");
    expect(source).toContain("data-timeline-window-sentinel");
    expect(source).toContain("completedMessageActivities(message, persistedProcessActivities");
  });
});
