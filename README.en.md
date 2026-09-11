# dsh-workbuddy-global

Bring the models of the **WorkBuddy global** app (`www.workbuddy.ai`) into DeepSeek Harness (DSH).

It registers a **separate provider** from the official
[`dsh-workbuddy-connect`](https://github.com/corrinehu/dsh-workbuddy-connect) plugin (the WorkBuddy China
route: `copilot.tencent.com` / `codebuddy.cn`), so both appear as their own groups in the DSH model picker
and can be switched between freely.

[中文](./README.md)

---

## Why a separate plugin

The official plugin already has global support wired in — `src/upstream.ts` defines
`WorkBuddyRegion = 'cn' | 'global'`, `GLOBAL_BASE` and `regionOf()` — but its global branch reuses the China
endpoints, and two of them do not work:

| Call | Result | Actual global path |
|---|---|---|
| `GET www.workbuddy.ai/console/enterprises/personal/models` | **HTTP 500** | `/v3/config` |
| `POST www.workbuddy.ai/v2/billing/meter/get-user-resource` | **HTTP 404** | `/billing/meter/get-user-resource-summary` |

On top of that, one plugin instance reads a single credential file and registers a single provider, so it can
never serve two accounts at once. Hence this separate implementation.

## Endpoints

| Capability | China | Global |
|---|---|---|
| provider | `workbuddy` | `workbuddy-global` |
| Chat | `copilot.tencent.com/v2/chat/completions` | `www.workbuddy.ai/v2/chat/completions` |
| Model catalog | `copilot.tencent.com/console/enterprises/personal/models` | `www.workbuddy.ai/v3/config` |
| Credits | `codebuddy.cn/v2/billing/meter/get-user-resource` | `www.workbuddy.ai/billing/meter/get-user-resource-summary` |
| Token refresh | `/v2/plugin/auth/token/refresh` | `/v2/auth/token/refresh` |
| Credential file | `workbuddy-desktop.info` | `workbuddy-desktop-ai.info` |

Both credential files live in `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\` on Windows
(`~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/` on macOS).

## Model catalog

The catalog comes from the `/v3/config` endpoint the desktop app uses, and the request carries the desktop
app's User-Agent — the server returns different catalogs per UA, and the same URL with the CLI's UA only
yields an older base catalog. If `/v3/config` is unavailable the plugin falls back to
`/v2/enterprises/personal/models` and records a log line.

Which models are listed is decided server-side by account entitlements. Models tagged as non-chat
(`text-to-image`) are dropped, matching the desktop app; beyond that the plugin does not trim anything.

## Install

Prerequisite: the WorkBuddy global desktop app is installed and signed in — this plugin reuses that sign-in
(read-only) and follows account switches automatically.

```bash
dsh plugin --profile web add github:arukas0623-ai/dsh-workbuddy-global
```

After restarting DSH, a **WorkBuddy 国际版** group appears in the model picker.

> `DeepSeekHarness.exe` boots the **web** profile, hence `--profile web`.

## How it works

Same architecture as the official plugin:

1. Reads the WorkBuddy desktop app's credential file read-only; refresh results go into the plugin's own copy
   (`$DSH_HOME/.workbuddy-global-auth.json`) and **never** touch the app's file. Whichever of the two expires
   later wins.
2. Starts a loopback-only OpenAI-compatible shim on `127.0.0.1` that supplies what the global upstream requires:
   - forces `stream: true` (the upstream rejects non-streaming);
   - rewrites `role: "developer"` to `"system"` (pi-ai emits `developer` per the OpenAI convention; the
     upstream rejects it with HTTP 400 / code 11128);
   - flattens `tool_choice` to a string (object forms return 400);
   - adds the CLI-shaped headers.
3. The pi-ai provider points at that shim.

**Security**: the shim mints a random 32-byte shared secret per process; pi-ai sends it as the OpenAI
`apiKey`, the shim verifies it with a constant-time compare before forwarding, and the real token is always
resolved by the shim itself from the credential store. The secret is never uploaded or written to disk. That
per-process secret is what keeps other local processes out, even if they find the port. The shim additionally
validates `Host` / `Origin` / `Content-Type` to block DNS rebinding and cross-site pages.

## Configuration

Settings → Plugins → **WorkBuddy 国际版**:

- `authFile` — path to the credential file. Leave it empty to auto-detect, in this order:
  1. `authFile` from settings, or the `WORKBUDDY_GLOBAL_AUTH_FILE` environment variable — used verbatim;
  2. `workbuddy-desktop-ai.info` under `%LOCALAPPDATA%`, then under `%APPDATA%` — first hit wins;
  3. only if neither exists, the China-named `workbuddy-desktop.info`, and only when its `domain` really is
     the global site. Some installation layouts write the global account into that file; this way a China
     account is never picked up by mistake, and an unexpected file name does not disable the plugin.

If nothing matches, the error message lists every location that was tried.

The card shows the signed-in account, token expiry, remaining credits, and which models are currently on
promotion.

## Telling the two groups apart

The official plugin's provider display name is plain `WorkBuddy`. To relabel it as "WorkBuddy 国内版":

```bash
node tools/label-upstream-as-cn.mjs
```

It rewrites the display name inside the official plugin's build output (idempotent, backs up first).
**Re-run it after upgrading the official plugin**, since an upgrade overwrites those files.

## Known limitations

- Depends on the WorkBuddy client's own endpoints (**not an official public API**); WorkBuddy updates may
  require adjustments.
- Requires DSH core `0.1.5-rc.1` or newer (the same line as official plugin 0.4.0).
- The settings card reads `/plugins/dsh-workbuddy-global/status` off DSH's own web server. That route checks
  `Host` / `Origin` are loopback but carries no separate authentication. The response is read-only and never
  contains a token; other processes on the same machine can read the account name and credit balance — the
  same trust level as the credential file itself.
- All runtime dependencies come from DSH itself (see `peerDependencies`). This plugin has **no build step** —
  what you see in `lib/` is the source.

## Development

No dependencies needed to run the tests:

```bash
node --test tests/
```

`lib/pure.js` holds the environment-independent pure functions (credential parsing, credential-file
selection, catalog filtering, request normalization, upstream response parsing, error classification). It
deliberately imports nothing from `@deepseek-ai/*`, so it is testable without a DSH installation. All
filesystem access is injected by the caller (the `isFile` / `readText` options of `pickDesktopAuthPath`, for
instance), so the path-probing logic is covered with a fake filesystem.

`lib/index.js` (host half) and `lib/client.js` (browser half) need DSH to load. To verify manually, drop this
directory into a profile's `node_modules` and boot that profile:

```bash
dsh plugin --profile web add file:<absolute path to this directory>
```

## Credits

- [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) (MIT) — the upstream
  this project derives from. The credential store, loopback shim, and upstream wire handling are ported from it.
- [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) (MIT) — reference implementation of
  the WorkBuddy upstream protocol.
- [franksong2702/dsh-codex-connect](https://github.com/franksong2702/dsh-codex-connect) (Apache-2.0) —
  reference for the DSH plugin structure and provider registration.

## Disclaimer

- **For personal study and research only.** It only drives the user's own WorkBuddy account on their own
  machine. Commercial use is prohibited.
- You are responsible for complying with WorkBuddy's terms of service, and for any consequences (account
  restrictions, cleared quotas, service interruption, etc.).
- The authors accept no liability for any direct or indirect loss.
- **Not affiliated with, authorized by, or endorsed by** Tencent, WorkBuddy, or DeepSeek.
