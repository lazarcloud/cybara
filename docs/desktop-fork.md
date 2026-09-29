# Desktop fork: gateway variants

This repository is a fork of [metaspartan/cybara](https://github.com/metaspartan/cybara)
(MIT). Upstream's desktop app always starts a bundled local gateway. This fork adds
a build-time `CYBARA_DESKTOP_VARIANT` switch so one codebase produces three
installers, including a **remote-only** client that talks to an existing Cybara
server (for example one you self-host behind a reverse proxy).

Only the desktop shell changed. The gateway/backend, CLI and web UI are upstream.

## Variants

| `CYBARA_DESKTOP_VARIANT` | Bundled gateway | Remote server | Local fallback | CI artifact |
|---|---|---|---|---|
| `local` | yes | ignored | yes | `Cybara-local-x64-setup.exe` |
| `mixed` | yes | yes | yes | `Cybara-mixed-x64-setup.exe` |
| `remote` | no | yes | no | `Cybara-remote-x64-setup.exe` |

The Windows build matrix lives in
[`.github/workflows/build-windows.yml`](../.github/workflows/build-windows.yml) and
publishes a rolling `desktop-latest` release with `.exe` (NSIS) and `.msi` files.

## Configuring a remote server

For the `remote` and `mixed` variants the desktop navigates to the configured
server's own web UI. There is **no baked-in default endpoint**. The URL is resolved
in this order:

1. `--gateway-url https://cybara.example.com` command-line argument
2. `CYBARA_GATEWAY_URL` environment variable
3. the `remote-gateway.json` config file written by the in-app prompt

The config file lives in the app's local data directory:

- Windows: `%LOCALAPPDATA%\com.cybara.desktop\remote-gateway.json`
- macOS: `~/Library/Application Support/com.cybara.desktop/remote-gateway.json`
- Linux: `~/.local/share/com.cybara.desktop/remote-gateway.json`

```json
{ "url": "https://cybara.example.com" }
```

### `remote` (remote-only)

On first launch a **"Connect to your Cybara server"** screen asks for the URL. There
is no bundled gateway, so nothing else runs locally. To change the server later,
edit the config file or pass `--gateway-url` again.

### `mixed`

A mixed build keeps the bundled gateway **and** can attach to a remote one:

- **Settings → Gateway → Desktop gateway** shows a server URL field. Submitting it
  switches the app to the remote server; "Use local gateway" switches back.
- The same section is unavailable while rendering the *remote* server's UI (that
  page runs without Tauri IPC), so to return from a remote server use the
  system tray → **Use local gateway**.

Native desktop features that require Tauri IPC (microphone recording, "open file in
Cybara") are only active while the local shell or the `local` gateway UI is shown,
not on a remote server's page.

## Building locally

```bash
bun install --ignore-scripts
cd ui && bun install --ignore-scripts && cd ..

# remote-only
CYBARA_DESKTOP_VARIANT=remote bunx tauri build --bundles nsis,msi

# local-only
CYBARA_DESKTOP_VARIANT=local bun run scripts/build-sidecar.ts   # set CYBARA_SIDECAR_BUN_TARGET
CYBARA_DESKTOP_VARIANT=local bunx tauri build --bundles nsis,msi \
  --config src-tauri/tauri.sidecar.conf.json
```

Note: the base `src-tauri/tauri.conf.json` is the remote-only configuration
(no `externalBin`). The sidecar is added back by
`src-tauri/tauri.sidecar.conf.json` for the `local` and `mixed` variants.

Installers are unsigned, so Windows SmartScreen shows a one-time "Run anyway"
prompt. Authenticode signing would remove it.

## Keeping up with upstream

The fork is a handful of files on top of upstream:

- `src-tauri/src/main.rs`, `gateway.rs`, `gateway_ownership.rs`, `tray.rs`
- `src-tauri/tauri.conf.json`, `src-tauri/tauri.sidecar.conf.json`
- `ui/src/lib/desktopGatewayStartup.ts`, `ui/src/App.tsx`,
  `ui/src/pages/Settings.tsx`, `ui/src/components/settings/RemoteGatewayForm.tsx`,
  `ui/src/components/settings/DesktopGatewaySettingsSection.tsx`,
  `ui/src/components/RemoteGatewayPrompt.tsx`
- `.github/workflows/build-windows.yml`

To rebase on a new upstream release:

```bash
git fetch upstream
git rebase upstream/main
```

## License

MIT, unchanged from upstream. See [LICENSE](../LICENSE) and
[Carsen Klock](https://github.com/metaspartan).
