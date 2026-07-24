# Contributing

Thanks for your interest in AIPM.

## Scope of this repository

This repo is the **open-source MCP server** (`server.js`) — a zero-dependency Node stdio bridge to the
local AIProcessManager HTTP API. That's the part that's MIT-licensed and open to contributions.

The **backend** (`AIProcessManager.exe`, the Windows introspection engine) and **ForgePilot** (the paid
agent) are separate products and are not in this repository.

## Good contributions

- New MCP tools that map cleanly to existing backend endpoints, with `readOnlyHint` set correctly.
- Better error messages / `next_action` hints.
- Token-efficiency improvements (trimming, pagination, filtering).
- Docs, examples, and MCP-client integration guides.

Please keep the **zero-dependency** rule — no npm packages in `server.js`.

## Dev setup

1. Run `AIProcessManager.exe` (get it from [Releases](../../releases)).
2. `node server.js` — it speaks MCP over stdio. Set `AIPM_API` to override the API URL.
3. Test against a real MCP client (Claude Desktop, Cursor) or by sending JSON-RPC lines on stdin.

## Reporting bugs

Open an issue with your OS build, the tool you called, and the JSON you got back. For **security**
issues, follow [SECURITY.md](SECURITY.md) instead of filing a public issue.
