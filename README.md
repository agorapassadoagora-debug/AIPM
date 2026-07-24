# AI Process Manager — MCP Server

**Structured Windows state for AI agents — no screenshots.**

This MCP server exposes the [AI Process Manager](https://github.com/agorapassadoagora-debug/AIPM) local HTTP API as tools for Claude Desktop, Cursor, and any MCP client. Instead of capturing pixels (~2,765 tokens per 1080p screenshot), agents read **JSON and text** (~15–150 tokens per query) from processes, windows, consoles, and UI Automation trees.

> **Requires:** AIProcessManager.exe running on Windows (system tray). Node.js ≥ 14. Zero npm dependencies.

<!-- mcp-name: io.github.agorapassadoagora-debug/AIPM -->

## Why this exists

Computer-use agents often "look" at the desktop via screenshots. That is slow (3–5 s), expensive in tokens, and sends pixel data through the model. AIPM answers structured questions on loopback:

| Question | Screenshot | AIPM tool |
|----------|------------|-----------|
| Is the render still running? | ~2,765 tokens | `check_process` → ~15 tokens |
| What's the console output? | screenshot + OCR | `read_window` → ~30 tokens |
| Did the export finish? | poll + screenshots | `wait_for(file_stable=...)` → one call |

Measured on a real machine: **~94–98% fewer perception tokens per action** vs screenshots.

## Quick start

### 1. Start the backend
Ensure `AIProcessManager.exe` is running in your system tray.

### 2. Configure your MCP client

**Claude Desktop** — `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ai-process-manager": {
      "command": "node",
      "args": ["C:\\path\\to\\ai-process-manager\\mcp\\server.js"]
    }
  }
}