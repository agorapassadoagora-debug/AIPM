#!/usr/bin/env node
/*
 * AI Process Manager — MCP server (stdio, zero npm dependencies).
 * Proxies the local HTTP API (default http://localhost:9147) as MCP tools.
 *
 * Claude Desktop / Cursor config:
 *   { "mcpServers": { "ai-process-manager": {
 *       "command": "node",
 *       "args": ["C:\\path\\to\\mcp\\server.js"] } } }
 *
 * Override API URL: set AIPM_API=http://127.0.0.1:9147
 */
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const readline = require('readline');
const VERSION = require('./version.js');

let clientName = 'mcp';

const SERVER_INSTRUCTIONS = [
  'AI Process Manager (AIPM) exposes structured Windows state — processes, windows,',
  'console text, UI trees — without screenshots. Prefer these tools over screen capture;',
  'typical perception queries cost ~15–150 tokens vs ~2,765 for a 1080p screenshot.',
  '',
  'Prerequisites: AIProcessManager.exe must be running (system tray). If a tool returns',
  'connection_refused, ask the user to start the app or run install.cmd.',
  '',
  'Recommended workflow:',
  '1. health_check — verify the backend is up.',
  '2. get_app_knowledge(app) — load learned UI recipes before acting.',
  '3. check_process / list_windows — locate the target.',
  '4. read_window or get_ui_tree / ui_find — read state (no screenshot).',
  '5. wait_for — block until render/build/download completes (re-call if timeout).',
  '6. ui_invoke / ui_set_value / focus_window — only if action tier is enabled by the user.',
  '7. report_action_outcome + report_task_outcome — feed local learning and economy metrics.',
  '',
  'Safety: read-only by default. POST actions require the user to enable "Agent actions"',
  'in the tray and allow each app individually. Never dump /processes unfiltered — use',
  'check_process with name_contains/title_contains filters.',
].join('\n');

function resolveApiBase() {
  if (process.env.AIPM_API) return String(process.env.AIPM_API).replace(/\/$/, '');
  const endpointFile = path.join(
    os.homedir(),
    'AppData',
    'Local',
    'AIProcessManager',
    'endpoint.txt'
  );
  try {
    const line = fs.readFileSync(endpointFile, 'utf8').trim();
    if (line) return line.replace(/\/$/, '');
  } catch (_) { /* default */ }
  return 'http://127.0.0.1:9147';
}

let API = resolveApiBase();

function logErr(msg) {
  process.stderr.write('[ai-process-manager-mcp] ' + msg + '\n');
}

function apiRequest(method, path, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = API + path;
    const opts = {
      method: method || 'GET',
      timeout: timeoutMs || 5000,
      headers: { 'User-Agent': 'mcp:' + clientName },
    };
    if (method === 'POST') opts.headers['Content-Length'] = 0;

    const req = http.request(url, opts, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(body);
        } catch (e) {
          json = { raw: body };
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      const err = new Error('timeout');
      err.code = 'ETIMEDOUT';
      reject(err);
    });
    req.on('error', reject);
    req.end();
  });
}

function apiGet(path, timeoutMs) {
  return apiRequest('GET', path, timeoutMs);
}

function apiPost(path, timeoutMs) {
  return apiRequest('POST', path, timeoutMs || 15000);
}

function enrichApiError(status, json) {
  const out = Object.assign({ ok: false }, json);
  if (status === 503 && json && json.error === 'paused') {
    out.code = 'api_paused';
    out.next_action =
      'Ask the user to resume the API from the AI Process Manager tray menu (Resume API).';
  } else if (status === 403 && json && json.error === 'action_denied') {
    out.code = 'action_denied';
    out.next_action =
      'Ask the user to enable Agent actions in the tray and allow this app in the allowlist.';
  } else if (status >= 400) {
    out.code = out.code || 'api_error';
    out.http_status = status;
  }
  return out;
}

function mapThrownError(e) {
  if (e.code === 'ECONNREFUSED') {
    return {
      ok: false,
      error: 'connection_refused',
      code: 'connection_refused',
      message: 'AI Process Manager is not running or not listening on ' + API + '.',
      next_action:
        'Ask the user to start AIProcessManager.exe (green tray icon) or reinstall with install.cmd.',
    };
  }
  if (e.code === 'ETIMEDOUT') {
    return {
      ok: false,
      error: 'timeout',
      code: 'ETIMEDOUT',
      message: 'Request timed out.',
      next_action: 'Retry with a smaller scope (filters, lower depth/max_nodes) or check if the target app is hung.',
    };
  }
  return {
    ok: false,
    error: 'request_failed',
    code: e.code || 'UNKNOWN',
    message: e.message,
    next_action: 'Retry once; if it persists, check %LOCALAPPDATA%\\AIProcessManager\\log.txt.',
  };
}

function requireArg(args, name) {
  if (args[name] == null || args[name] === '') {
    const err = new Error(name + ' is required');
    err.code = 'invalid_params';
    throw err;
  }
}

const CMDLINE_MAX = 120;

function slimProcess(p, fullCmd) {
  const out = {};
  for (const k in p) {
    const v = p[k];
    if (v == null) continue;
    if (k === 'status' && v === 'running') continue;
    if (k === 'parent' && v === p.name) continue;
    out[k] = v;
  }
  if (!fullCmd && typeof out.command_line === 'string' && out.command_line.length > CMDLINE_MAX)
    out.command_line = out.command_line.slice(0, CMDLINE_MAX) + '\u2026';
  return out;
}

function winQuery(args) {
  const q = new URLSearchParams();
  if (args.hwnd != null) q.set('hwnd', String(args.hwnd));
  else if (args.title_contains) q.set('title_contains', args.title_contains);
  return q;
}

const READ_TOOLS = [
  {
    name: 'health_check',
    annotations: { title: 'Check AI Process Manager status' },
    description:
      'Ping the AI Process Manager backend. Returns version, API URL, and whether the local service is reachable. Call this first in a new session.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'check_process',
    annotations: { title: 'Check if a process is running' },
    description:
      'Check if a process is running on the user\'s Windows machine — no screenshot. Filter by executable name fragment (e.g. "python", "ffmpeg") and/or window title (e.g. "RENDER VIDEO 02"). Returns PID, CPU%, RAM, title, command line, start time. Command lines are truncated to 120 chars unless full_command_line=true. Results are capped at 10 matches, windowed processes first.',
    inputSchema: {
      type: 'object',
      properties: {
        name_contains: { type: 'string', description: 'Executable name fragment (case-insensitive)' },
        title_contains: { type: 'string', description: 'Window title fragment (case-insensitive)' },
        full_command_line: {
          type: 'boolean',
          description: 'true for full command line (default: truncated to 120 chars)',
        },
      },
    },
  },
  {
    name: 'list_processes',
    annotations: { title: 'List running processes' },
    description:
      'List running processes sorted by CPU. Use "top" to limit (default 25, max 200). Prefer check_process when searching for one process. Command lines truncated unless full_command_line=true.',
    inputSchema: {
      type: 'object',
      properties: {
        top: { type: 'number', description: 'How many processes to return (default 25)' },
        full_command_line: { type: 'boolean', description: 'true for full command lines' },
      },
    },
  },
  {
    name: 'list_windows',
    annotations: { title: 'List open windows' },
    description:
      'List open desktop windows: title, process, minimized/maximized state, position, Z-order, and which has focus. Replaces screenshots for "what is open".',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_system_status',
    annotations: { title: 'Get system status (CPU, RAM, GPU, disk)' },
    description:
      'Machine snapshot: CPU%, RAM used/total, GPU name and usage, disk free space per drive, network, uptime, active displays.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_taskbar',
    annotations: { title: 'Show taskbar apps' },
    description:
      'Human view of the taskbar: pinned apps and running apps grouped with window titles.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_window',
    annotations: { title: 'Read text from a window' },
    description:
      'Read TEXT from inside a window via UI Automation — no screenshot. Works with consoles (cmd, PowerShell, Windows Terminal), editors, and most native apps. Typical use: read render progress from a console ("frame 4812/5000"). Identify the window by title_contains or hwnd from list_windows.',
    inputSchema: {
      type: 'object',
      properties: {
        title_contains: { type: 'string', description: 'Window title fragment (case-insensitive)' },
        hwnd: { type: 'number', description: 'Exact window handle from list_windows' },
        max_chars: { type: 'number', description: 'Max characters (default 20000)' },
      },
    },
  },
  {
    name: 'get_ui_tree',
    annotations: { title: "Get a window's UI element tree" },
    description:
      'UI Automation tree of a window (roles, names, states) — the accessibility snapshot of a native Windows app. ' +
      'depth: default 4, max 30. max_nodes: default 200, max 1000 — max_nodes is the cost brake, NOT depth. ' +
      'Win32 apps expose content within 4-6 levels. Chromium/Electron apps (VS Code, Slack, Discord, Claude Desktop, Teams) ' +
      'bury real content under ~10 levels of Pane/Group wrappers: at low depth you get only empty Panes and conclude, wrongly, ' +
      'that the window is empty. Measured on Claude Desktop: depth=8 -> 15 useless nodes; depth=17 -> 115 nodes, 87 of them named (~8 KB) — ' +
      'the tree saturates at 17. So for Chromium/Electron ask for depth=15-20 and cap cost with max_nodes. ' +
      'The response reports depth, max_nodes, nodes, depth_reached and truncated; when truncated=true the tree was cut ' +
      '(read next_action) and you should repeat with a higher depth and/or max_nodes before concluding anything about the window. ' +
      'For finding a clickable target prefer ui_find (already filtered to interactive elements).',
    inputSchema: {
      type: 'object',
      properties: {
        title_contains: { type: 'string', description: 'Window title fragment' },
        hwnd: { type: 'number', description: 'Exact window handle' },
        depth: {
          type: 'number',
          description:
            'Max tree depth (default 4, max 30). 4-6 for native Win32; 15-20 for Chromium/Electron apps, whose content sits under ~10 wrapper levels.',
        },
        max_nodes: {
          type: 'number',
          description:
            'Max nodes returned (default 200, max 1000). This is the token-cost brake — raise depth freely and cap cost here.',
        },
      },
    },
  },
  {
    name: 'wait_for',
    annotations: { title: 'Wait until a condition is met' },
    description:
      'Long-poll until a condition is met (or timeout). Replaces polling loops. Conditions: process_ended, process_started, file_stable (render/download done), file_exists, window_title_contains. Max 50s per call; if satisfied=false, call again to keep waiting.',
    inputSchema: {
      type: 'object',
      properties: {
        process_ended: { type: 'string', description: 'Process name fragment that must exit' },
        process_started: { type: 'string', description: 'Process name fragment that must start' },
        file_stable: { type: 'string', description: 'File path that must stop growing' },
        file_exists: { type: 'string', description: 'File path that must appear' },
        window_title_contains: { type: 'string', description: 'Window title fragment that must appear' },
        stable_for: { type: 'number', description: 'For file_stable: seconds unchanged (default 10)' },
        timeout: { type: 'number', description: 'Max wait seconds (default 50, max 50)' },
      },
    },
  },
  {
    name: 'get_recent_events',
    annotations: { title: 'List recent PC events' },
    description:
      'Last 24h of PC events: process_started, process_ended (with duration), window_focused, file_changed. Useful for "what happened while I was away" (e.g. when did the render finish?).',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Filter by type (process_ended, file_changed, ...)' },
        limit: { type: 'number', description: 'Max events (default 50, max 1000)' },
      },
    },
  },
  {
    name: 'check_file',
    annotations: { title: 'Check a file or folder' },
    description:
      'File or folder status: exists, size, last modified, locked?, locking process. Ideal for checking if a render/export finished without opening Explorer.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path, e.g. D:/videos/output.mp4' },
      },
      required: ['path'],
    },
  },
  {
    name: 'get_app_knowledge',
    annotations: { title: 'Get learned recipes for an app' },
    description:
      'Query what AIPM learned locally about an app: successful (role, name) -> action recipes, plus common_failures (targets that keep failing — do not retry them). ' +
      'Call BEFORE acting in an app. Even with known=false you may get ui_shape: the shape of the app\'s UI tree (counts, roles, depth) learned passively from earlier reads — useful cold-start map. ' +
      'Pass the process name as shown in task manager (e.g. "notepad.exe", "chrome.exe").',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'App/process name (e.g. notepad.exe)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_economy_stats',
    annotations: { title: 'Get token economy statistics' },
    description:
      'Local economy metrics: tokens and time saved by structured state vs screenshots, queries served, task/action success rates, top apps, 24h/7d trends. ' +
      'Two independent views of savings — economy_measured_by_api (measured here) and economy_reported_by_agents (self-reported): never add them together. ' +
      'The store block states which local database the totals came from.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_audit_log',
    annotations: { title: 'View API audit log' },
    description:
      'Recent API audit log: which agents called which endpoints and when. Works even when the API is paused. For compliance and debugging agent behavior. Secrets and typed text (api_key=, value=) are masked before being recorded.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max entries (default 50, max 1000)' },
      },
    },
  },
];

// Todas as tools de leitura carregam os mesmos hints. Object.assign ESCREVE POR CIMA
// do objeto existente, preservando o `title` que cada tool já declarou (o title é
// exigido pela revisão de extensão e é o que o cliente mostra ao usuário).
READ_TOOLS.forEach((t) => {
  t.annotations = Object.assign(t.annotations || {}, {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  });
});

const ACTION_TOOLS = [
  {
    name: 'ui_find',
    description:
      'List interactive UI elements in a window (buttons, fields, menus first; grid cells last). Each item has a stable global element_index plus can_invoke/can_set_value flags. Paginated (total/offset/limit/has_more). Read-only — no action tier required. Pass element_index to ui_invoke/ui_set_value.',
    inputSchema: {
      type: 'object',
      properties: {
        title_contains: { type: 'string', description: 'Window title fragment' },
        hwnd: { type: 'number', description: 'Exact window handle' },
        name_contains: { type: 'string', description: 'Filter elements by name' },
        role: { type: 'string', description: 'Filter by role (Button, Edit, MenuItem, ...)' },
        limit: { type: 'number', description: 'Page size (default 30, max 200)' },
        offset: { type: 'number', description: 'Pagination offset (default 0)' },
      },
    },
    annotations: {
      title: 'Find interactive UI elements',
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'ui_invoke',
    description:
      'Semantically CLICK a UI element via UI Automation (button, menu item, checkbox). Target by name_contains or element_index from ui_find. REQUIRES user-enabled action tier + app allowlist; otherwise returns action_denied. Confirm with the user before acting.',
    inputSchema: {
      type: 'object',
      properties: {
        title_contains: { type: 'string', description: 'Window title fragment' },
        hwnd: { type: 'number', description: 'Exact window handle' },
        name_contains: { type: 'string', description: 'Element name to click (e.g. "Save")' },
        element_index: { type: 'number', description: 'Stable index from ui_find' },
      },
    },
    annotations: {
      title: 'Click a UI element',
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'ui_set_value',
    description:
      'Set text in an editable field via UI Automation (no key simulation). REQUIRES action tier + allowlist. Check can_set_value in ui_find; modern apps (e.g. Win11 Notepad) may not expose fields. Confirm with the user first.',
    inputSchema: {
      type: 'object',
      properties: {
        title_contains: { type: 'string', description: 'Window title fragment' },
        hwnd: { type: 'number', description: 'Exact window handle' },
        name_contains: { type: 'string', description: 'Field name' },
        element_index: { type: 'number', description: 'Stable index from ui_find' },
        value: { type: 'string', description: 'Text to set' },
      },
      required: ['value'],
    },
    annotations: {
      title: 'Set the value of a UI field',
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'focus_window',
    description:
      'Bring a window to the foreground. REQUIRES action tier + app allowlist.',
    inputSchema: {
      type: 'object',
      properties: {
        title_contains: { type: 'string', description: 'Window title fragment' },
        hwnd: { type: 'number', description: 'Exact window handle' },
      },
    },
    // Trazer janela para frente não destrói nada e repetir dá o mesmo resultado.
    annotations: {
      title: 'Bring a window to the foreground',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

const TELEMETRY_TOOLS = [
  {
    name: 'report_task_outcome',
    description:
      'Report task outcome to local telemetry (metadata only — never screen content). Call at END of a computer-use task. Feeds get_app_knowledge and get_economy_stats.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Short task description (metadata)' },
        app: { type: 'string', description: 'Primary app (e.g. chrome.exe)' },
        success: { type: 'boolean', description: 'Task succeeded?' },
        steps: { type: 'number', description: 'Number of steps/actions' },
        tokens_estimated: { type: 'number', description: 'Estimated tokens consumed' },
        duration_s: { type: 'number', description: 'Duration in seconds' },
        screenshots_avoided: { type: 'number', description: 'Screenshots avoided via structured state' },
        notes: { type: 'string', description: 'Short notes (metadata)' },
      },
      required: ['app'],
    },
    annotations: {
      title: 'Report task outcome (telemetry)',
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'report_action_outcome',
    description:
      'Report one UI action outcome (invoke/set_value/focus). Feeds per-app recipes in get_app_knowledge. Metadata only — never screen content or typed text. ' +
      'Report FAILURES too (ok=false plus reason): they become common_failures and stop the next agent from repeating the same dead end.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App where action occurred' },
        element_role: { type: 'string', description: 'Element role (Button, Edit, ...)' },
        element_name: { type: 'string', description: 'Element name (e.g. "Save")' },
        action: { type: 'string', description: 'Action performed (invoke, set_value, focus)' },
        ok: { type: 'boolean', description: 'Action succeeded?' },
        ms: { type: 'number', description: 'Action duration in ms' },
        reason: {
          type: 'string',
          description:
            'Only when ok=false. Closed vocabulary: elemento_nao_encontrado, elemento_nao_suporta_invoke, elemento_nao_suporta_set_value, campo_somente_leitura, janela_nao_encontrada, ui_timeout, acao_bloqueada, erro_uia, outro. Anything else is stored as "outro" — free text never reaches disk.',
        },
      },
      required: ['app', 'action'],
    },
    annotations: {
      title: 'Report UI action outcome (telemetry)',
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
];

const TOOLS = READ_TOOLS.concat(ACTION_TOOLS, TELEMETRY_TOOLS);

async function callTool(name, args) {
  args = args || {};

  switch (name) {
    case 'health_check': {
      try {
        const r = await apiGet('/', 3000);
        if (r.status >= 400) return enrichApiError(r.status, r.json);
        return {
          ok: true,
          api_url: API,
          mcp_version: VERSION,
          backend: r.json,
        };
      } catch (e) {
        return mapThrownError(e);
      }
    }
    case 'check_process': {
      const q = new URLSearchParams();
      if (args.name_contains) q.set('name_contains', args.name_contains);
      if (args.title_contains) q.set('title_contains', args.title_contains);
      const r = await apiGet('/processes?' + q.toString());
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      let procs = (r.json.processes || []).map((p) => slimProcess(p, args.full_command_line === true));
      procs.sort(
        (a, b) => (b.title ? 1 : 0) - (a.title ? 1 : 0) || (b.cpu_percent - a.cpu_percent)
      );
      const out = {
        running: procs.length > 0,
        matches: procs.length,
        processes: procs.slice(0, 10),
      };
      if (procs.length > 10)
        out.note = 'showing 10 of ' + procs.length + ' (windowed processes first)';
      return out;
    }
    case 'list_processes': {
      const r = await apiGet('/processes');
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      const top = Math.max(1, Math.min(200, args.top || 25));
      const procs = (r.json.processes || [])
        .slice(0, top)
        .map((p) => slimProcess(p, args.full_command_line === true));
      return { count: r.json.count, processes: procs };
    }
    case 'list_windows': {
      const r = await apiGet('/windows');
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'get_system_status': {
      const r = await apiGet('/system');
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'get_taskbar': {
      const r = await apiGet('/taskbar');
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'get_recent_events': {
      const q = new URLSearchParams();
      if (args.type) q.set('type', args.type);
      q.set('limit', String(Math.max(1, Math.min(1000, args.limit || 50))));
      const r = await apiGet('/events/history?' + q.toString());
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'read_window': {
      const q = new URLSearchParams();
      if (args.title_contains) q.set('title_contains', args.title_contains);
      if (args.hwnd) q.set('hwnd', String(args.hwnd));
      if (args.max_chars) q.set('max_chars', String(args.max_chars));
      const r = await apiGet('/window/text?' + q.toString(), 15000);
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'get_ui_tree': {
      const q = new URLSearchParams();
      if (args.title_contains) q.set('title_contains', args.title_contains);
      if (args.hwnd) q.set('hwnd', String(args.hwnd));
      if (args.depth) q.set('depth', String(args.depth));
      if (args.max_nodes) q.set('max_nodes', String(args.max_nodes));
      const r = await apiGet('/ui/tree?' + q.toString(), 15000);
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'wait_for': {
      const q = new URLSearchParams();
      const conds = [
        'process_ended',
        'process_started',
        'file_stable',
        'file_exists',
        'window_title_contains',
      ];
      for (const c of conds) if (args[c]) q.set(c, args[c]);
      if (args.stable_for) q.set('for', String(args.stable_for));
      const timeout = Math.max(1, Math.min(50, args.timeout || 50));
      q.set('timeout', String(timeout));
      const r = await apiGet('/wait?' + q.toString(), (timeout + 10) * 1000);
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'ui_find': {
      const q = winQuery(args);
      if (args.name_contains) q.set('name_contains', args.name_contains);
      if (args.role) q.set('role', args.role);
      if (args.limit != null) q.set('limit', String(args.limit));
      if (args.offset != null) q.set('offset', String(args.offset));
      const r = await apiGet('/ui/find?' + q.toString(), 15000);
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'ui_invoke': {
      const q = winQuery(args);
      if (args.name_contains) q.set('name_contains', args.name_contains);
      if (args.element_index != null) q.set('element_index', String(args.element_index));
      const r = await apiPost('/ui/invoke?' + q.toString());
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'ui_set_value': {
      requireArg(args, 'value');
      const q = winQuery(args);
      if (args.name_contains) q.set('name_contains', args.name_contains);
      if (args.element_index != null) q.set('element_index', String(args.element_index));
      q.set('value', String(args.value));
      const r = await apiPost('/ui/set_value?' + q.toString());
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'focus_window': {
      const q = winQuery(args);
      const r = await apiPost('/ui/focus?' + q.toString());
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'check_file': {
      requireArg(args, 'path');
      const r = await apiGet('/filesystem/watch?path=' + encodeURIComponent(args.path));
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'get_app_knowledge': {
      requireArg(args, 'name');
      const r = await apiGet('/knowledge/app?name=' + encodeURIComponent(args.name));
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'get_economy_stats': {
      const r = await apiGet('/analytics/summary');
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'get_audit_log': {
      const limit = Math.max(1, Math.min(1000, args.limit || 50));
      const r = await apiGet('/audit?limit=' + limit);
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'report_task_outcome': {
      requireArg(args, 'app');
      const q = new URLSearchParams();
      q.set('agent', clientName);
      if (args.task != null) q.set('task', String(args.task));
      q.set('app', String(args.app));
      if (args.success != null) q.set('success', args.success ? 'true' : 'false');
      if (args.steps != null) q.set('steps', String(args.steps));
      if (args.tokens_estimated != null) q.set('tokens_estimated', String(args.tokens_estimated));
      if (args.duration_s != null) q.set('duration_s', String(args.duration_s));
      if (args.screenshots_avoided != null)
        q.set('screenshots_avoided', String(args.screenshots_avoided));
      if (args.notes != null) q.set('notes', String(args.notes));
      const r = await apiPost('/telemetry/task?' + q.toString());
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    case 'report_action_outcome': {
      requireArg(args, 'app');
      requireArg(args, 'action');
      const q = new URLSearchParams();
      q.set('agent', clientName);
      q.set('app', String(args.app));
      if (args.element_role != null) q.set('element_role', String(args.element_role));
      if (args.element_name != null) q.set('element_name', String(args.element_name));
      q.set('action', String(args.action));
      if (args.ok != null) q.set('ok', args.ok ? 'true' : 'false');
      if (args.ms != null) q.set('ms', String(args.ms));
      // reason= só faz sentido com ok=false; o backend normaliza para o vocabulário
      // fechado (texto livre vira "outro"), então repassar é seguro.
      if (args.reason != null) q.set('reason', String(args.reason));
      const r = await apiPost('/telemetry/action?' + q.toString());
      if (r.status >= 400) return enrichApiError(r.status, r.json);
      return r.json;
    }
    default:
      throw new Error('unknown tool: ' + name);
  }
}

function toolResultText(obj) {
  return JSON.stringify(obj, null, 2);
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    return;
  }

  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      if (params && params.clientInfo && params.clientInfo.name)
        clientName = String(params.clientInfo.name).slice(0, 40);
      API = resolveApiBase();
      reply(id, {
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'ai-process-manager', version: VERSION },
        instructions: SERVER_INSTRUCTIONS,
      });
    } else if (method === 'notifications/initialized' || method === 'initialized') {
      // notification — no reply
    } else if (method === 'ping') {
      reply(id, {});
    } else if (method === 'tools/list') {
      reply(id, { tools: TOOLS });
    } else if (method === 'tools/call') {
      try {
        const result = await callTool(params.name, params.arguments);
        const isError =
          result &&
          typeof result === 'object' &&
          result.ok === false &&
          (result.code === 'connection_refused' ||
            result.code === 'ETIMEDOUT' ||
            result.code === 'api_paused' ||
            result.code === 'action_denied' ||
            result.error === 'connection_refused');
        reply(id, {
          content: [{ type: 'text', text: toolResultText(result) }],
          isError: !!isError,
        });
      } catch (e) {
        const payload =
          e.code === 'invalid_params'
            ? {
                ok: false,
                error: 'invalid_params',
                message: e.message,
                next_action: 'Fix the tool arguments and retry.',
              }
            : mapThrownError(e);
        reply(id, {
          content: [{ type: 'text', text: toolResultText(payload) }],
          isError: true,
        });
      }
    } else if (id !== undefined) {
      replyError(id, -32601, 'method not supported: ' + method);
    }
  } catch (e) {
    logErr(method + ': ' + e.message);
    if (id !== undefined) replyError(id, -32603, e.message);
  }
});
