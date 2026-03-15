import type { Database } from "bun:sqlite";
import type { ThreadRow, WindowRow } from "./db.js";
import { type ProgressReport, readProgress } from "./progress.js";

interface ThreadWithWindows extends ThreadRow {
  windows: Array<WindowRow & { progress: ProgressReport | null }>;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function getThreads(
  db: Database,
  statusFilter?: string,
): Promise<ThreadWithWindows[]> {
  let threadQuery = `
    SELECT * FROM threads
    ORDER BY (status IN ('active', 'paused')) DESC, updated_at DESC
  `;
  const params: string[] = [];

  if (statusFilter) {
    threadQuery = `
      SELECT * FROM threads WHERE status = ?
      ORDER BY updated_at DESC
    `;
    params.push(statusFilter);
  }

  const threads = db.query(threadQuery).all(...params) as ThreadRow[];
  const allWindows = db
    .query("SELECT * FROM windows ORDER BY started_at ASC")
    .all() as WindowRow[];

  const windowsByThread = new Map<
    string,
    Array<WindowRow & { progress: ProgressReport | null }>
  >();

  for (const win of allWindows) {
    if (!windowsByThread.has(win.thread_id)) {
      windowsByThread.set(win.thread_id, []);
    }
    const progress =
      win.status === "running" ? await readProgress(win.progress_file) : null;
    windowsByThread.get(win.thread_id)?.push({ ...win, progress });
  }

  return threads.map((t) => ({
    ...t,
    windows: windowsByThread.get(t.thread_id) ?? [],
  }));
}

function serveHTML(): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dispatch Dashboard</title>
<style>
:root {
  --bg: #0d1117;
  --bg-card: #161b22;
  --bg-hover: #1c2128;
  --border: #30363d;
  --text: #e6edf3;
  --text-muted: #8b949e;
  --green: #3fb950;
  --yellow: #d29922;
  --red: #f85149;
  --blue: #58a6ff;
  --gray: #6e7681;
  --progress-bg: #21262d;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
  min-height: 100vh;
}
.container { max-width: 960px; margin: 0 auto; padding: 24px 16px; }
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 24px;
}
header h1 { font-size: 20px; font-weight: 600; letter-spacing: 0.5px; }
.stats { display: flex; gap: 16px; font-size: 13px; color: var(--text-muted); }
.stat-value { font-weight: 600; color: var(--text); }
.stat-green .stat-value { color: var(--green); }
.stat-yellow .stat-value { color: var(--yellow); }
.stat-red .stat-value { color: var(--red); }

.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  cursor: pointer;
  user-select: none;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--text-muted);
}
.section-header:hover { color: var(--text); }
.section-header .arrow { transition: transform 0.2s; display: inline-block; }
.section-header .arrow.collapsed { transform: rotate(-90deg); }
.section-header .count {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0 8px;
  font-size: 11px;
}

.thread-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 8px;
  transition: border-color 0.15s;
}
.thread-card:hover { border-color: #484f58; }
.thread-card.active { border-left: 3px solid var(--blue); }
.thread-card.done { border-left: 3px solid var(--green); opacity: 0.85; }
.thread-card.error { border-left: 3px solid var(--red); }
.thread-card.paused { border-left: 3px solid var(--yellow); }

.thread-header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 8px; }
.thread-subject { font-weight: 600; font-size: 15px; }
.thread-meta { font-size: 12px; color: var(--text-muted); margin-bottom: 12px; }

.badge {
  display: inline-block;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 2px 8px;
  border-radius: 4px;
  white-space: nowrap;
}
.badge-active { background: rgba(88,166,255,0.15); color: var(--blue); }
.badge-running { background: rgba(210,153,34,0.15); color: var(--yellow); }
.badge-done { background: rgba(63,185,80,0.15); color: var(--green); }
.badge-error { background: rgba(248,81,73,0.15); color: var(--red); }
.badge-cancelled { background: rgba(110,118,129,0.15); color: var(--gray); }
.badge-paused { background: rgba(210,153,34,0.15); color: var(--yellow); }

.windows { display: flex; flex-direction: column; gap: 6px; }
.window-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  padding: 8px 10px;
  background: var(--bg);
  border-radius: 6px;
}
.window-name { font-weight: 500; min-width: 120px; flex-shrink: 0; }
.window-task { color: var(--text-muted); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.progress-bar {
  width: 120px;
  height: 6px;
  background: var(--progress-bg);
  border-radius: 3px;
  overflow: hidden;
  flex-shrink: 0;
}
.progress-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.5s ease;
}
.progress-fill.running { background: var(--yellow); }
.progress-fill.done { background: var(--green); width: 100% !important; }
.progress-fill.error { background: var(--red); }
.progress-pct { font-size: 12px; color: var(--text-muted); min-width: 35px; text-align: right; flex-shrink: 0; }

.current-step {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 4px;
  padding-left: 10px;
  font-style: italic;
}

.error-list {
  margin-top: 4px;
  padding-left: 10px;
  font-size: 12px;
  color: var(--red);
}

footer {
  margin-top: 32px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-muted);
  display: flex;
  justify-content: space-between;
}
.conn-error { color: var(--red); }

.empty-state {
  text-align: center;
  color: var(--text-muted);
  padding: 32px 0;
  font-size: 14px;
}

.section { margin-bottom: 24px; }
.hidden { display: none; }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>DISPATCH</h1>
    <div class="stats" id="stats"></div>
  </header>

  <div class="section">
    <div class="section-header" onclick="toggleSection('active')">
      <span class="arrow" id="active-arrow">&#9660;</span>
      Active Threads
      <span class="count" id="active-count">0</span>
    </div>
    <div id="active-threads"></div>
  </div>

  <div class="section">
    <div class="section-header" onclick="toggleSection('past')">
      <span class="arrow collapsed" id="past-arrow">&#9660;</span>
      Past Threads
      <span class="count" id="past-count">0</span>
    </div>
    <div id="past-threads" class="hidden"></div>
  </div>

  <footer>
    <span>Auto-refreshes every 5s</span>
    <span id="status-line">Loading...</span>
  </footer>
</div>

<script>
const REFRESH = 5000;
const sections = { active: true, past: false };

function toggleSection(name) {
  sections[name] = !sections[name];
  const el = document.getElementById(name + '-threads');
  const arrow = document.getElementById(name + '-arrow');
  if (sections[name]) {
    el.classList.remove('hidden');
    arrow.classList.remove('collapsed');
  } else {
    el.classList.add('hidden');
    arrow.classList.add('collapsed');
  }
}

function relTime(iso) {
  if (!iso) return '';
  const d = new Date(iso + (iso.endsWith('Z') ? '' : 'Z'));
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60) return diff + 's ago';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function badgeClass(status) {
  return 'badge badge-' + status;
}

function renderWindow(w) {
  const pct = w.progress ? w.progress.percent_complete : (w.status === 'done' ? 100 : 0);
  const fillClass = w.status === 'done' ? 'done' : w.status === 'error' ? 'error' : 'running';

  let stepHtml = '';
  if (w.status === 'running' && w.progress && w.progress.current_step) {
    stepHtml = '<div class="current-step">' + esc(w.progress.current_step) + '</div>';
  }

  let errHtml = '';
  if (w.progress && w.progress.errors && w.progress.errors.length > 0) {
    errHtml = '<div class="error-list">' + w.progress.errors.map(e => esc(e)).join('<br>') + '</div>';
  }

  return '<div class="window-row">' +
    '<span class="window-name">' + esc(w.window_name) + '</span>' +
    '<span class="window-task">' + esc(w.task_summary) + '</span>' +
    '<span class="' + badgeClass(w.status) + '">' + w.status + '</span>' +
    '<div class="progress-bar"><div class="progress-fill ' + fillClass + '" style="width:' + pct + '%"></div></div>' +
    '<span class="progress-pct">' + (w.status === 'running' || w.status === 'done' ? pct + '%' : '') + '</span>' +
    '</div>' + stepHtml + errHtml;
}

function renderThread(t) {
  const windowsHtml = t.windows.length > 0
    ? '<div class="windows">' + t.windows.map(renderWindow).join('') + '</div>'
    : '';

  return '<div class="thread-card ' + t.status + '">' +
    '<div class="thread-header">' +
      '<span class="thread-subject">' + esc(t.subject || '(no subject)') + '</span>' +
      '<span class="' + badgeClass(t.status) + '">' + t.status + '</span>' +
    '</div>' +
    '<div class="thread-meta">' +
      'from ' + esc(t.sender) + ' &middot; ' + relTime(t.updated_at) +
      (t.repo_path ? ' &middot; ' + esc(t.repo_path) : '') +
    '</div>' +
    windowsHtml +
  '</div>';
}

async function refresh() {
  try {
    const res = await fetch('/api/threads');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const threads = data.threads;

    const active = threads.filter(t => t.status === 'active' || t.status === 'paused');
    const past = threads.filter(t => t.status === 'done' || t.status === 'error');

    document.getElementById('active-count').textContent = active.length;
    document.getElementById('past-count').textContent = past.length;

    const totalWindows = threads.reduce((s, t) => s + t.windows.length, 0);
    const runningWindows = threads.reduce((s, t) => s + t.windows.filter(w => w.status === 'running').length, 0);
    const errorWindows = threads.reduce((s, t) => s + t.windows.filter(w => w.status === 'error').length, 0);

    document.getElementById('stats').innerHTML =
      '<span>Threads: <span class="stat-value">' + threads.length + '</span></span>' +
      '<span class="stat-yellow">Running: <span class="stat-value">' + runningWindows + '</span></span>' +
      '<span>Tasks: <span class="stat-value">' + totalWindows + '</span></span>' +
      (errorWindows > 0 ? '<span class="stat-red">Errors: <span class="stat-value">' + errorWindows + '</span></span>' : '');

    document.getElementById('active-threads').innerHTML = active.length > 0
      ? active.map(renderThread).join('')
      : '<div class="empty-state">No active threads</div>';

    document.getElementById('past-threads').innerHTML = past.length > 0
      ? past.map(renderThread).join('')
      : '<div class="empty-state">No past threads</div>';

    document.getElementById('status-line').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    document.getElementById('status-line').innerHTML = '<span class="conn-error">Connection error</span>';
  }
}

refresh();
setInterval(refresh, REFRESH);
</script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export function startDashboard(port: number, db: Database): void {
  Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/") {
        return serveHTML();
      }

      if (url.pathname === "/api/threads") {
        const statusFilter = url.searchParams.get("status") ?? undefined;
        const threads = await getThreads(db, statusFilter);
        return json({ threads });
      }

      const threadMatch = url.pathname.match(/^\/api\/threads\/(.+)$/);
      if (threadMatch) {
        const threads = await getThreads(db);
        const thread = threads.find((t) => t.thread_id === threadMatch[1]);
        if (!thread) return json({ error: "Thread not found" }, 404);
        return json(thread);
      }

      return new Response("Not Found", { status: 404 });
    },
  });
}
