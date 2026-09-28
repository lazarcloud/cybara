import { describe, expect, test } from "bun:test";
import { loadChatImageSourceWithRetry } from "../../ui/src/lib/chatImages";

const noWait = async (): Promise<void> => undefined;

describe("viewed image thumbnail loading", () => {
  test("recovers when the first media request fails transiently", async () => {
    let calls = 0;
    const loaded = await loadChatImageSourceWithRetry(
      "/api/media?path=%2Ftmp%2Fa.png",
      2,
      10,
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("Image request failed (503)");
        return { src: "blob:thumbnail" };
      },
      noWait
    );
    expect(loaded.src).toBe("blob:thumbnail");
    expect(calls).toBe(2);
  });

  test("gives up after the configured retries and surfaces the last error", async () => {
    let calls = 0;
    const delays: number[] = [];
    await expect(
      loadChatImageSourceWithRetry(
        "/api/media?path=%2Ftmp%2Fgone.png",
        2,
        100,
        async () => {
          calls += 1;
          throw new Error(`Image request failed (404) #${calls}`);
        },
        async (ms) => {
          delays.push(ms);
        }
      )
    ).rejects.toThrow("#3");
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  test("does not retry when no retries are allowed", async () => {
    let calls = 0;
    await expect(
      loadChatImageSourceWithRetry(
        "/api/media?path=%2Ftmp%2Fgone.png",
        0,
        100,
        async () => {
          calls += 1;
          throw new Error("nope");
        },
        noWait
      )
    ).rejects.toThrow("nope");
    expect(calls).toBe(1);
  });
});
