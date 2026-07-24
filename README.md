# AI Process Manager (AIPM)

**Structured Windows state for AI agents — no screenshots.**

![license](https://img.shields.io/badge/license-MIT-green)
![mcp](https://img.shields.io/badge/mcp-v0.5.0-blue)
![platform](https://img.shields.io/badge/platform-Windows-0078D6)
![node](https://img.shields.io/badge/node-%E2%89%A514-brightgreen)
![deps](https://img.shields.io/badge/npm%20deps-0-brightgreen)

AIPM lets an AI agent read the Windows desktop as **structured text** — processes, windows, console
output, and UI Automation trees — instead of capturing pixels. A screenshot costs **~2,765 tokens** and
3–5 s; an AIPM query costs **~15–150 tokens** and ~10 ms.

> **Measured on real machines: ~94–98% fewer perception tokens per action.** Across a full multi-step
> task, total cost typically drops **3–10×** (the reasoning tokens remain — we don't claim the whole
> bill vanishes). Everything runs on **loopback** — no image of your screen ever leaves the machine.

This repository is the **open-source MCP server** (a ~730-line, zero-dependency Node stdio bridge). It
talks to the free **AIProcessManager.exe** backend (download below), which does the actual Windows
introspection.

---

## Why this exists

Computer-use agents usually "look" at the desktop via screenshots — slow, token-heavy, and it pushes
pixel data through the model. AIPM answers structured questions instead:

| Question | Screenshot | AIPM tool |
|----------|-----------|-----------|
| Is the render still running? | ~2,765 tokens | `check_process` → ~15 tokens |
| What's the console output? | screenshot + OCR | `read_window` → ~30 tokens |
| Did the export finish? | poll + screenshots | `wait_for(file_stable=…)` → one call |
| What can I click here? | vision guess | `ui_find` → stable element index |

## Coverage (honest, measured)

| Stack | Read state | Semantic actions |
|-------|-----------|------------------|
| Win32 / WinForms / WPF / UWP | ✅ full | ✅ |
| **Delphi VCL** (legacy business apps) | ✅ full | ✅ |
| Console (cmd, PowerShell, Windows Terminal) | ✅ text | — |
| Web (Chrome/Edge) / Electron | ⚠️ window chrome only via UIA | needs CDP bridge (on the roadmap) |
| Java Swing | ⚠️ needs Java Access Bridge | needs JAB bridge (on the roadmap) |

We publish what does **not** work yet on purpose — you should know the edges before you rely on it.

## Quick start

### 1. Get the backend (free)
Download the latest **`AIProcessManager.exe`** from the
[**Releases**](https://github.com/agorapassadoagora-debug/AIPM/releases) page and run it. A green icon
appears in the system tray; the local API listens on `http://localhost:9147`. It's **read-only by
default** — agent actions are opt-in per app.

### 2. Point your MCP client at the server

**Claude Desktop** — `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ai-process-manager": {
      "command": "node",
      "args": ["%LOCALAPPDATA%\\Programs\\AIProcessManager\\mcp\\server.js"]
    }
  }
}
```

(Use the absolute path printed by the installer. The `AIPM_API` env var overrides the API URL.)

### 3. Ask your agent
> "Is the ffmpeg render still running, and what frame is it on?" — the agent calls `check_process` and
> `read_window` instead of taking a screenshot.

## Tools

**Read (no action tier needed):** `health_check`, `check_process`, `list_processes`, `list_windows`,
`get_system_status`, `get_taskbar`, `read_window`, `get_ui_tree`, `ui_find`, `wait_for`,
`get_recent_events`, `check_file`, `get_app_knowledge`, `get_economy_stats`, `get_audit_log`.

**Actions (opt-in, per-app allowlist):** `ui_invoke`, `ui_set_value`, `focus_window`.

**Telemetry (local learning):** `report_task_outcome`, `report_action_outcome`.

## Security & privacy

- **Loopback only** (`127.0.0.1`), with a Host-header check. Nothing is exposed to the network.
- **Read-only by default.** Actions require you to enable the action tier *and* allow each app.
- **Metadata only** — the server never records screen content or typed values in its audit log.
- **Tamper-evident ledger:** effective actions are appended to a hash-chained (SHA-256) audit log that
  a third party can verify offline, in any language, without trusting the vendor — aimed at regulated
  desktops (EU AI Act Art. 12). See [SECURITY.md](SECURITY.md).

## Free vs paid

- **Free & open (MIT):** this MCP server.
- **Free (closed):** the `AIProcessManager.exe` backend — the "sensor". Yours to run at no cost.
- **Paid:** **ForgePilot**, the autonomous computer-use agent that drives apps end-to-end using AIPM's
  structured perception (works with local models too). See [promoflix.site](https://promoflix.site).

## Support the project

If AIPM saves you tokens, consider **[sponsoring](https://github.com/sponsors/agorapassadoagora-debug)**
— it funds maintenance and the CDP/JAB bridges. The **Sponsor** button is at the top of the repo.

## License

[MIT](LICENSE) for the MCP server. The backend and ForgePilot are separate products.
