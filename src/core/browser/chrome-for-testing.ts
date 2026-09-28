import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  Browser,
  ChromeReleaseChannel,
  detectBrowserPlatform,
  getInstalledBrowsers,
  getVersionComparator,
  install,
  resolveBuildId,
} from "@puppeteer/browsers";
import { cybaraDir } from "../paths";

export const chromeForTestingCacheDir = join(cybaraDir, "browsers");

export interface InstalledChromeBuild {
  buildId: string;
  executablePath: string;
}

export interface ChromeForTestingInstaller {
  resolveBuildId(): Promise<string>;
  install(
    buildId: string,
    onProgress: (downloaded: number, total: number) => void
  ): Promise<string>;
}

export function chromeForTestingAutoInstallEnabled(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return platform === "win32" && env.CYBARA_BROWSER_AUTO_INSTALL?.trim().toLowerCase() !== "false";
}

export function newestChromeBuild(builds: InstalledChromeBuild[]): InstalledChromeBuild | null {
  const compare = getVersionComparator(Browser.CHROME);
  return [...builds].sort((left, right) => compare(right.buildId, left.buildId))[0] ?? null;
}

export async function findInstalledChromeForTesting(
  cacheDir: string = chromeForTestingCacheDir
): Promise<string | null> {
  if (!existsSync(cacheDir)) return null;
  try {
    const installed = await getInstalledBrowsers({ cacheDir });
    const builds = installed
      .filter((entry) => entry.browser === Browser.CHROME && existsSync(entry.executablePath))
      .map((entry) => ({ buildId: entry.buildId, executablePath: entry.executablePath }));
    return newestChromeBuild(builds)?.executablePath ?? null;
  } catch {
    return null;
  }
}

function defaultInstaller(cacheDir: string): ChromeForTestingInstaller {
  const platform = detectBrowserPlatform();
  return {
    resolveBuildId: async () => {
      if (!platform) throw new Error("Chrome for Testing is not available for this platform");
      return await resolveBuildId(Browser.CHROME, platform, ChromeReleaseChannel.STABLE);
    },
    install: async (buildId, onProgress) => {
      if (!platform) throw new Error("Chrome for Testing is not available for this platform");
      const installed = await install({
        browser: Browser.CHROME,
        buildId,
        cacheDir,
        platform,
        downloadProgressCallback: onProgress,
      });
      return installed.executablePath;
    },
  };
}

let pendingInstall: Promise<string> | null = null;

export function formatChromeDownloadProgress(downloaded: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return "Downloading Google Chrome";
  const percent = Math.min(100, Math.max(0, Math.floor((downloaded / total) * 100)));
  return `Downloading Google Chrome ${percent}%`;
}

export async function installChromeForTesting(
  onProgress: (label: string) => void = () => undefined,
  cacheDir: string = chromeForTestingCacheDir,
  installer: ChromeForTestingInstaller = defaultInstaller(cacheDir)
): Promise<string> {
  if (pendingInstall) return await pendingInstall;
  const run = (async () => {
    onProgress(formatChromeDownloadProgress(0, 0));
    const buildId = await installer.resolveBuildId();
    let lastLabel = "";
    const executablePath = await installer.install(buildId, (downloaded, total) => {
      const label = formatChromeDownloadProgress(downloaded, total);
      if (label === lastLabel) return;
      lastLabel = label;
      onProgress(label);
    });
    if (!existsSync(executablePath)) {
      throw new Error("Chrome for Testing download finished without a browser executable");
    }
    return executablePath;
  })();
  pendingInstall = run;
  try {
    return await run;
  } finally {
    pendingInstall = null;
  }
}
