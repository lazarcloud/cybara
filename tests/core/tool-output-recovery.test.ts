import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "fs";
import { basename, dirname } from "path";
import {
  ARCHIVED_OUTPUT_LINE_PREFIX,
  formatRecoverableToolOutputPreview,
  persistToolOutputForRecovery,
  readArchivedToolOutput,
  TOOL_OUTPUT_RECOVERY_DIR,
} from "../../src/core/tool-output-recovery";
import { assertReadablePath } from "../../src/core/tools/path-policy";

describe("tool output recovery", () => {
  test("writes the full oversized output to a private readable cache file", () => {
    const output = `head\n${"middle-line\n".repeat(2000)}tail`;
    const preview = formatRecoverableToolOutputPreview(output, 500, {
      sessionId: "../session with spaces",
      toolName: "exec/shell",
      toolCallId: "call:1",
    });

    expect(preview.truncated).toBe(true);
    expect(preview.content).toContain("Full output saved to:");
    expect(preview.content).toContain("offset/limit");
    expect(preview.outputPath).toBeTruthy();
    expect(existsSync(preview.outputPath!)).toBe(true);
    expect(readFileSync(preview.outputPath!, "utf8")).toBe(output);
    expect(() => assertReadablePath(preview.outputPath)).not.toThrow();
    expect(basename(dirname(preview.outputPath!))).toBe("session-with-spaces");
    expect(basename(preview.outputPath!)).toContain("exec-shell-call-1");

    rmSync(preview.outputPath!, { force: true });
  });

  test("does not write a cache file when output fits the prompt budget", () => {
    const preview = formatRecoverableToolOutputPreview("small output", 500, {
      sessionId: "small-session",
      toolName: "read",
    });

    expect(preview).toEqual({ content: "small output", truncated: false });
  });

  test("sanitizes path segments for direct persistence", () => {
    const path = persistToolOutputForRecovery({
      content: "payload",
      sessionId: "../../session",
      toolName: "grep && rm -rf",
      toolCallId: "call/1",
      now: new Date("2026-07-09T00:00:00.000Z"),
    });

    expect(path).toBeTruthy();
    expect(path).not.toContain("../");
    expect(basename(dirname(path!))).toBe("session");
    expect(basename(path!)).toContain("grep-rm-rf-call-1");
    expect(readFileSync(path!, "utf8")).toBe("payload");

    rmSync(path!, { force: true });
  });

  test("persists structured output as line-readable equivalent JSON", () => {
    const payload = {
      status: "completed",
      runs: Array.from({ length: 40 }, (_, index) => ({
        runId: `run-${index}`,
        result: `finding-${index}-${"detail".repeat(40)}`,
      })),
    };
    const serialized = JSON.stringify(payload);
    const path = persistToolOutputForRecovery({
      content: serialized,
      sessionId: "structured-output",
      toolName: "sessions_wait",
      toolCallId: "wait-1",
    });

    expect(path).toBeTruthy();
    const persisted = readFileSync(path!, "utf8");
    expect(persisted.split("\n").length).toBeGreaterThan(80);
    expect(JSON.parse(persisted)).toEqual(payload);

    rmSync(path!, { force: true });
  });

  test("reads back an archived output referenced by a receipt", async () => {
    const path = persistToolOutputForRecovery({
      content: "line one\nline two",
      sessionId: "archive-read",
      toolName: "exec",
    });
    const receipt = `[Evidence Receipt] verified\n${ARCHIVED_OUTPUT_LINE_PREFIX}${path}\nSummary: ok`;

    expect(await readArchivedToolOutput(receipt, 1000)).toBe("line one\nline two");
    expect(await readArchivedToolOutput(receipt, 4)).toBe("line");

    rmSync(path!, { force: true });
  });

  test("refuses archive references outside the recovery directory", async () => {
    const outside = `${TOOL_OUTPUT_RECOVERY_DIR}/../platform.db`;
    const traversal = `[Evidence Receipt] verified\n${ARCHIVED_OUTPUT_LINE_PREFIX}${outside}\nSummary: x`;
    const absolute = `[Evidence Receipt] verified\n${ARCHIVED_OUTPUT_LINE_PREFIX}/etc/hosts\nSummary: x`;
    const injectedQuote = `[Evidence Receipt] verified\nFull output preserved in chat transcript.\n${ARCHIVED_OUTPUT_LINE_PREFIX}/etc/hosts`;

    expect(await readArchivedToolOutput(traversal, 1000)).toBeUndefined();
    expect(await readArchivedToolOutput(absolute, 1000)).toBeUndefined();
    expect(await readArchivedToolOutput(injectedQuote, 1000)).toBeUndefined();
    expect(await readArchivedToolOutput("plain output", 1000)).toBeUndefined();
  });

  test("returns nothing when the archived file is gone", async () => {
    const missing = `${TOOL_OUTPUT_RECOVERY_DIR}/gone/missing.txt`;
    const receipt = `[Evidence Receipt] verified\n${ARCHIVED_OUTPUT_LINE_PREFIX}${missing}`;
    expect(await readArchivedToolOutput(receipt, 1000)).toBeUndefined();
  });
});
