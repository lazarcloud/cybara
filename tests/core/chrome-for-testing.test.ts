import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chromeForTestingAutoInstallEnabled,
  findInstalledChromeForTesting,
  formatChromeDownloadProgress,
  installChromeForTesting,
  newestChromeBuild,
} from "../../src/core/browser/chrome-for-testing";

function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "cybara-cft-"));
  return run(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("Chrome for Testing provisioning", () => {
  test("auto-install only runs on Windows and can be disabled", () => {
    expect(chromeForTestingAutoInstallEnabled("win32", {})).toBe(true);
    expect(
      chromeForTestingAutoInstallEnabled("win32", { CYBARA_BROWSER_AUTO_INSTALL: "false" })
    ).toBe(false);
    expect(
      chromeForTestingAutoInstallEnabled("win32", { CYBARA_BROWSER_AUTO_INSTALL: " FALSE " })
    ).toBe(false);
    expect(chromeForTestingAutoInstallEnabled("darwin", {})).toBe(false);
    expect(chromeForTestingAutoInstallEnabled("linux", {})).toBe(false);
  });

  test("picks the newest cached build by Chrome version, not string order", () => {
    expect(
      newestChromeBuild([
        { buildId: "99.0.4844.51", executablePath: "old" },
        { buildId: "140.0.7339.80", executablePath: "new" },
        { buildId: "140.0.7339.16", executablePath: "mid" },
      ])?.executablePath
    ).toBe("new");
    expect(newestChromeBuild([])).toBeNull();
  });

  test("reports download progress as a whole percentage", () => {
    expect(formatChromeDownloadProgress(0, 0)).toBe("Downloading Google Chrome");
    expect(formatChromeDownloadProgress(50, 200)).toBe("Downloading Google Chrome 25%");
    expect(formatChromeDownloadProgress(999, 1000)).toBe("Downloading Google Chrome 99%");
    expect(formatChromeDownloadProgress(5000, 1000)).toBe("Downloading Google Chrome 100%");
    expect(formatChromeDownloadProgress(10, Number.NaN)).toBe("Downloading Google Chrome");
  });

  test("returns null for a missing or empty cache", async () => {
    expect(
      await findInstalledChromeForTesting(join(tmpdir(), "cybara-cft-missing-dir"))
    ).toBeNull();
    await withTempDir(async (dir) => {
      expect(await findInstalledChromeForTesting(dir)).toBeNull();
    });
  });

  test("installs through the injected installer, dedupes progress, and shares one download", async () => {
    await withTempDir(async (dir) => {
      const executable = join(dir, "chrome.exe");
      const labels: string[] = [];
      let installs = 0;
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const installer = {
        resolveBuildId: async () => "140.0.7339.80",
        install: async (buildId: string, onProgress: (d: number, t: number) => void) => {
          installs += 1;
          expect(buildId).toBe("140.0.7339.80");
          onProgress(10, 100);
          onProgress(10, 100);
          onProgress(100, 100);
          await gate;
          mkdirSync(dir, { recursive: true });
          writeFileSync(executable, "binary");
          return executable;
        },
      };
      const first = installChromeForTesting((label) => labels.push(label), dir, installer);
      const second = installChromeForTesting(() => undefined, dir, installer);
      release();
      expect(await first).toBe(executable);
      expect(await second).toBe(executable);
      expect(installs).toBe(1);
      expect(labels).toEqual([
        "Downloading Google Chrome",
        "Downloading Google Chrome 10%",
        "Downloading Google Chrome 100%",
      ]);
    });
  });

  test("fails closed when the download produces no executable, then allows a retry", async () => {
    await withTempDir(async (dir) => {
      const missing = join(dir, "never-written.exe");
      const broken = {
        resolveBuildId: async () => "140.0.0.0",
        install: async () => missing,
      };
      await expect(installChromeForTesting(() => undefined, dir, broken)).rejects.toThrow(
        "without a browser executable"
      );
      const offline = {
        resolveBuildId: async () => {
          throw new Error("offline");
        },
        install: async () => missing,
      };
      await expect(installChromeForTesting(() => undefined, dir, offline)).rejects.toThrow(
        "offline"
      );
    });
  });
});
