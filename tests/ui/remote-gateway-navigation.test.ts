import { describe, expect, test } from "bun:test";
import { isRemoteGatewayNavigationPending } from "../../ui/src/lib/remoteGatewayNavigation";

describe("remote gateway navigation", () => {
  test("does nothing without a configured remote gateway", () => {
    expect(isRemoteGatewayNavigationPending("http://127.0.0.1:4269", null)).toBe(false);
    expect(isRemoteGatewayNavigationPending("http://127.0.0.1:4269", undefined)).toBe(false);
    expect(isRemoteGatewayNavigationPending("http://127.0.0.1:4269", "")).toBe(false);
  });

  test("stays put when the window already runs at the remote origin", () => {
    expect(isRemoteGatewayNavigationPending("http://127.0.0.1:4269", "http://127.0.0.1:4269")).toBe(
      false
    );
    expect(
      isRemoteGatewayNavigationPending(
        "https://cybara.example.com",
        "https://cybara.example.com/ui"
      )
    ).toBe(false);
  });

  test("navigates when host, port, or scheme differ", () => {
    expect(
      isRemoteGatewayNavigationPending("tauri://localhost", "https://cybara.example.com")
    ).toBe(true);
    expect(isRemoteGatewayNavigationPending("http://127.0.0.1:4269", "http://127.0.0.1:4270")).toBe(
      true
    );
    expect(
      isRemoteGatewayNavigationPending("http://cybara.example.com", "https://cybara.example.com")
    ).toBe(true);
    expect(isRemoteGatewayNavigationPending("http://localhost:4269", "http://127.0.0.1:4269")).toBe(
      true
    );
  });

  test("fails closed on malformed urls", () => {
    expect(isRemoteGatewayNavigationPending("http://127.0.0.1:4269", "not a url")).toBe(false);
  });
});
