import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const uiSrc = fileURLToPath(new URL("../../ui/src", import.meta.url));
const read = (rel: string) => readFileSync(`${uiSrc}/${rel}`, "utf8");

describe("desktop remote gateway wiring", () => {
  test("the desktop shell gates the app on remote gateway state", () => {
    const app = read("App.tsx");
    const gate = app.slice(
      app.indexOf("function DesktopGatewayGate"),
      app.indexOf("function SetupGuard")
    );

    expect(gate).toContain("readGatewayStartupStatus");
    expect(gate).toContain('status?.ownership === "remoteHosted"');
    expect(gate).toContain("window.location.replace(remoteUrl)");
    expect(gate).toContain("<RemoteGatewayPrompt");
    expect(gate).toContain("status?.needsRemoteConfig");
  });

  test("settings exposes the desktop gateway section only for remote-capable builds", () => {
    const settings = read("pages/Settings.tsx");
    const section = read("components/settings/DesktopGatewaySettingsSection.tsx");

    expect(settings).toContain("<DesktopGatewaySettingsSection />");
    expect(section).toContain("status?.supportsRemote");
    expect(section).toContain("<RemoteGatewayForm");
    expect(section).toContain("supportsSidecar={status.supportsSidecar}");
  });

  test("the shared form connects through the desktop bridge and offers a local fallback", () => {
    const form = read("components/settings/RemoteGatewayForm.tsx");

    expect(form).toContain("setRemoteGatewayUrl(url.trim())");
    expect(form).toContain("switchToLocalServer()");
    expect(form).toContain("supportsSidecar ?");
    expect(form).toContain('role="alert"');
  });
});
