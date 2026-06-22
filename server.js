#!/usr/bin/env node
/* mdinterface — rendered markdown canvas + live Claude Code session.
 *
 * Usage:  node server.js <file.md> [--port 7777] [--cmd claude]
 *
 * Three one-way arrows:
 *   canvas selection ──keystrokes──▶ Claude Code PTY
 *   Claude Code      ──edits──────▶ the file on disk
 *   file watcher     ──content────▶ canvas re-render
 */

const express = require("express");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { WebSocketServer } = require("ws");
// node-pty powers the embedded terminal pane. It's an OPTIONAL native dependency (see
// optionalDependencies in package.json): if it didn't install or build, the rendered canvas,
// the file watcher, and the selection bridge all still come up — only the in-window terminal
// is disabled, and you run `claude` in your own terminal instead (the hooks still feed it the
// selection off disk). The specific reason is surfaced to the user at spawn time.
let pty = null;
try {
  pty = require("node-pty");
} catch {}

// ---------- args ----------
const args = process.argv.slice(2);
const fileArg = args.find((a) => !a.startsWith("--"));
if (!fileArg) {
  console.error("Usage: mdinterface <file.md> [--port 7777] [--cmd claude]");
  process.exit(1);
}
let DOC = path.resolve(fileArg); // reassignable: the toolbar file picker can switch docs
if (!fs.existsSync(DOC)) {
  console.error(`File not found: ${DOC}`);
  process.exit(1);
}
if (fs.statSync(DOC).isDirectory()) {
  console.error(
    `${DOC} is a directory — point me at a markdown file, e.g.:\n  node server.js ${path.join(fileArg, "doc.md")}`
  );
  process.exit(1);
}
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : dflt;
};
const PORT = parseInt(flag("port", "7777"), 10);
const CLAUDE_CMD = flag("cmd", process.env.MDINTERFACE_CMD || "claude");

// ---------- access control ----------
// mdinterface drives a live shell/Claude PTY, so the server must NOT be reachable by other
// machines or by random web pages. Three layers:
//   1) bind to loopback only (see server.listen) — no LAN exposure;
//   2) a per-launch secret token in the URL, required by /doc and the WebSocket — blocks
//      other local processes/pages that don't have the token;
//   3) Origin + Host validation on the WebSocket — blocks a malicious site you visit from
//      driving the PTY (WebSockets bypass same-origin) and blocks DNS-rebinding.
const TOKEN = crypto.randomBytes(16).toString("hex");
const { wsAllowed } = require("./access")(PORT, TOKEN);

// ---------- web server ----------
const app = express();
// Never send the per-launch token (it rides in the URL's ?t=) to anywhere via Referer —
// a link in a rendered doc must not leak it. Applies to every response below.
app.use((_req, res, next) => {
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});
app.use(express.static(path.join(__dirname, "public")));
app.get("/doc", (req, res) => {
  if (req.query.t !== TOKEN) return res.status(403).end();
  // path is returned (for the file picker) but only to a token-holding client.
  res.json({ name: path.basename(DOC), path: DOC, content: read() });
});
// Directory listing for the file browser: folders (to navigate) + markdown files. Token
// gated. Lists any dir the user can read — same reach the PTY already has.
app.get("/ls", (req, res) => {
  if (req.query.t !== TOKEN) return res.status(403).end();
  const dir =
    typeof req.query.dir === "string" && req.query.dir
      ? path.resolve(req.query.dir)
      : path.dirname(DOC);
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return res.status(400).json({ error: e.code === "EACCES" ? "Permission denied" : e.message });
  }
  const entries = [];
  for (const e of ents) {
    if (e.name.startsWith(".")) continue; // skip dotfiles
    const full = path.join(dir, e.name);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try {
        isDir = fs.statSync(full).isDirectory();
      } catch {
        continue;
      }
    }
    if (isDir) entries.push({ name: e.name, path: full, isDir: true });
    else if (/\.(md|markdown)$/i.test(e.name))
      entries.push({ name: e.name, path: full, isDir: false });
  }
  entries.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
  const parent = path.dirname(dir);
  res.json({ dir, parent: parent === dir ? null : parent, current: DOC, entries });
});
// Switch the canvas to a different document — lets Claude (via the canvas_open MCP tool)
// open a file it just created, e.g. one pulled from Notion. Same path → same openDoc().
app.post("/open", express.json({ limit: "64kb" }), (req, res) => {
  if (req.query.t !== TOKEN) return res.status(403).end();
  res.json(openDoc(req.body?.path));
});
const server = http.createServer(app);

function read() {
  try {
    return fs.readFileSync(DOC, "utf8");
  } catch {
    return "";
  }
}

// ---------- selection mirror: the browser's selection, written to disk ----------
// The canvas never types into Claude. Instead the current selection is mirrored to a
// file, and a UserPromptSubmit hook injects that file as context on the user's next
// message — so Claude is ambiently aware of what's selected, with zero prompt noise.
const CLAUDE_DIR = path.join(path.dirname(DOC), ".claude");
const SEL_FILE = path.join(CLAUDE_DIR, "mdinterface-selection.txt");

// ---------- runtime file: how the separate MCP process reaches this server ----------
// canvas_edit writes the open document directly; canvas_open POSTs back to this server. The
// MCP process reads port/token/doc from this file before each call, so edits follow the
// toolbar file picker. Edits always apply immediately — undo is the Undo button (or git).
const RUNTIME_FILE = path.join(CLAUDE_DIR, "mdinterface-runtime.json");
function writeRuntime() {
  try {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    // Owner-only: this file holds the session token, so keep it unreadable by other users.
    // `doc` is the currently-open document — canvas_edit reads it so it follows file switches.
    fs.writeFileSync(RUNTIME_FILE, JSON.stringify({ port: PORT, token: TOKEN, doc: DOC }), {
      mode: 0o600,
    });
    try {
      fs.chmodSync(RUNTIME_FILE, 0o600);
    } catch {} // tighten even if the file pre-existed
  } catch {}
}

function lineRange(blocks, content) {
  let start = Infinity,
    end = -Infinity;
  for (const raw of blocks) {
    const idx = content.indexOf(raw);
    if (idx === -1) continue;
    const s = content.slice(0, idx).split("\n").length; // 1-based start line
    const e = s + raw.replace(/\n+$/, "").split("\n").length - 1;
    start = Math.min(start, s);
    end = Math.max(end, e);
  }
  return start <= end ? [start, end] : null;
}

function writeSelection(text, blocks) {
  try {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    if (!text) {
      // Explicitly announce "nothing selected" rather than staying silent, so a cleared
      // selection actively cancels any stale CANVAS SELECTION blocks left in history.
      fs.writeFileSync(
        SEL_FILE,
        `===== CANVAS SELECTION: NONE (as of this message) =====\n` +
          `No text is currently selected in the canvas. Any CANVAS SELECTION block shown ` +
          `earlier in this conversation is STALE — do not act on it.\n`
      );
      return;
    }
    const rng = lineRange(blocks || [], read());
    const where = rng
      ? rng[0] === rng[1]
        ? `line ${rng[0]}`
        : `lines ${rng[0]}-${rng[1]}`
      : "an unknown location";
    // Lead with the passage inside hard delimiters so it can't be skimmed past; the live
    // block supersedes every earlier one. Injected verbatim before each message.
    const body =
      `===== CURRENT CANVAS SELECTION (${path.basename(DOC)}, ${where}) =====\n` +
      `${text}\n` +
      `===== END CANVAS SELECTION =====\n` +
      `^ This is the user's selection AS OF THIS MESSAGE. It supersedes any CANVAS ` +
      `SELECTION block shown earlier in the conversation — a changed selection means the ` +
      `user has moved on, so ignore the older ones unless the message is very clearly ` +
      `about earlier discussion. When they say "this", "here", "the selection", or ` +
      `similar, THIS passage is the referent — use it directly.\n`;
    fs.writeFileSync(SEL_FILE, body);
  } catch {}
}

// Apply a direct edit from the canvas: replace the nth occurrence of a block's raw
// markdown with the user's edited version, then write the file. The file watcher
// broadcasts the new content, so every canvas (including the editor's) re-renders.
function applyDirectEdit(oldRaw, newRaw, nth) {
  if (typeof oldRaw !== "string" || typeof newRaw !== "string" || !oldRaw) return;
  const content = read();
  let idx = -1,
    from = 0;
  for (let i = 0; i <= (nth | 0); i++) {
    idx = content.indexOf(oldRaw, from);
    if (idx === -1) return; // block no longer present (file changed underneath) — ignore
    from = idx + oldRaw.length;
  }
  const updated = content.slice(0, idx) + newRaw + content.slice(idx + oldRaw.length);
  if (updated !== content) {
    try {
      fs.writeFileSync(DOC, updated);
    } catch {}
  }
}

// Install the hooks that feed Claude (idempotent, non-destructive merge into
// settings.local.json, which reloads live):
//   SessionStart    → cat the whole doc, so the full document is in context from the
//                     start of every session (and on resume / clear / compact).
//   UserPromptSubmit → cat the selection mirror, so the current selection rides along
//                     with each message — read instantly from disk, no round-trip.
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function ensureHook(settings, event, command) {
  settings.hooks = settings.hooks || {};
  settings.hooks[event] = settings.hooks[event] || [];
  const arr = settings.hooks[event];
  if (arr.some((g) => (g.hooks || []).some((h) => h.command === command))) return false;
  arr.push({ matcher: "", hooks: [{ type: "command", command }] });
  return true;
}

function installHooks() {
  const settingsPath = path.join(CLAUDE_DIR, "settings.local.json");
  const selCmd = `cat ${shQuote(SEL_FILE)} 2>/dev/null`;
  // The preamble also carries the behavioral directive so it travels with ANY document
  // (not just one that happens to have a CLAUDE.md): edit via canvas_edit, and stay terse.
  const docCmd =
    `printf '[mdinterface] You are in a mdinterface session: %s is shown in a live canvas the ` +
    `user reads, selects in, and edits. To CHANGE the document, use the ` +
    `mcp__mdinterface__canvas_edit tool, NOT the built-in Edit/Write — it needs no prior Read and ` +
    `the canvas re-renders instantly. After an edit, reply in one short line or not at all. ` +
    `Full on-disk contents of %s as of session start:\\n\\n' ${shQuote(path.basename(DOC))} ${shQuote(path.basename(DOC))} && cat ${shQuote(DOC)}`;
  try {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) || {};
      } catch {}
    }
    // Drop any prior mdinterface-managed hooks first, so switching documents REPLACES them
    // rather than accumulating a SessionStart `cat` per doc ever opened.
    const notMine = (event, marker) => {
      if (!settings.hooks || !Array.isArray(settings.hooks[event])) return;
      settings.hooks[event] = settings.hooks[event].filter(
        (g) =>
          !(g.hooks || []).some((h) => typeof h.command === "string" && h.command.includes(marker))
      );
    };
    notMine("SessionStart", "[mdinterface]");
    notMine("UserPromptSubmit", "mdinterface-selection.txt");
    // Migration: strip hooks from the old "mdcanvas" and "line0" names so upgrading doesn't
    // leave duplicates.
    notMine("SessionStart", "[mdcanvas]");
    notMine("UserPromptSubmit", "mdcanvas-selection.txt");
    notMine("SessionStart", "[line0]");
    notMine("UserPromptSubmit", "line0-selection.txt");
    let changed = true; // we always rewrite (hooks were just normalized)
    ensureHook(settings, "SessionStart", docCmd);
    ensureHook(settings, "UserPromptSubmit", selCmd);
    // Pre-approve the mdinterface MCP server + its tools so they load without prompts.
    if (!Array.isArray(settings.enabledMcpjsonServers)) settings.enabledMcpjsonServers = [];
    // Migration: drop the old "mdcanvas"/"line0" server names + their blanket grants if present.
    settings.enabledMcpjsonServers = settings.enabledMcpjsonServers.filter(
      (s) => s !== "mdcanvas" && s !== "line0"
    );
    if (!settings.enabledMcpjsonServers.includes("mdinterface")) {
      settings.enabledMcpjsonServers.push("mdinterface");
      changed = true;
    }
    settings.permissions = settings.permissions || {};
    if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];
    settings.permissions.allow = settings.permissions.allow.filter(
      (p) => p !== "mcp__mdcanvas__*" && p !== "mcp__line0__*"
    );
    if (!settings.permissions.allow.includes("mcp__mdinterface__*")) {
      settings.permissions.allow.push("mcp__mdinterface__*");
      changed = true;
    }
    if (changed) fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  } catch (e) {
    console.warn(
      `Could not install hooks (${e.message}). The selection is still written to\n  ${SEL_FILE}\n` +
        `— add a UserPromptSubmit hook running \`${selCmd}\` and a SessionStart hook running \`cat <doc>\`.`
    );
  }
}

// Register the canvas_edit MCP server in .mcp.json (project root = the doc's folder),
// non-destructively. Claude spawns it at session start; it writes the doc directly so
// Claude can edit without the built-in Edit tool's mandatory Read. Needs a session
// restart to take effect (.mcp.json is read at startup, not live).
function installMcpServer() {
  const mcpPath = path.join(path.dirname(DOC), ".mcp.json");
  const entry = {
    type: "stdio",
    command: process.execPath, // same node that runs mdinterface — avoids PATH surprises
    args: [path.join(__dirname, "mcp-server.js"), DOC],
  };
  try {
    let cfg = {};
    if (fs.existsSync(mcpPath)) {
      try {
        cfg = JSON.parse(fs.readFileSync(mcpPath, "utf8")) || {};
      } catch {}
    }
    cfg.mcpServers = cfg.mcpServers || {};
    // Migration: remove the server under the old "mdcanvas"/"line0" names if still registered.
    let migrated = false;
    for (const old of ["mdcanvas", "line0"]) {
      if (cfg.mcpServers[old]) {
        delete cfg.mcpServers[old];
        migrated = true;
      }
    }
    const cur = cfg.mcpServers.mdinterface;
    const same =
      cur &&
      cur.command === entry.command &&
      JSON.stringify(cur.args) === JSON.stringify(entry.args);
    if (!same || migrated) {
      cfg.mcpServers.mdinterface = entry;
      fs.writeFileSync(mcpPath, `${JSON.stringify(cfg, null, 2)}\n`);
    }
  } catch (e) {
    console.warn(
      `Could not register the canvas_edit MCP server (${e.message}). Built-in Edit still works.`
    );
  }
}

installHooks();
installMcpServer();
writeRuntime(); // mode + callback info for the MCP server
writeSelection("", []); // start clean

for (const sig of ["exit", "SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    try {
      fs.writeFileSync(SEL_FILE, "");
    } catch {}
    try {
      fs.unlinkSync(RUNTIME_FILE);
    } catch {} // gone → MCP server defaults back to auto
    if (sig !== "exit") process.exit(0);
  });
}

// ---------- one shared PTY running Claude Code ----------
let shell;
// Recent terminal output, replayed to each newly connected client so a page reload
// reconstructs the current screen (Claude's TUI is otherwise idle and won't repaint).
const TERM_BUFFER_MAX = 256 * 1024;
let termBuffer = "";
let ptyCols = 100,
  ptyRows = 32; // last known size, for the repaint nudge
// Force the TUI to redraw the current frame cleanly: a momentary size change (rows-1 →
// rows) triggers a SIGWINCH-driven repaint even when the real size is unchanged. Used to
// un-stick a desynced terminal (after reconnect, refocus, or a settled resize).
function repaintPty() {
  if (!shell) return;
  try {
    shell.resize(ptyCols, Math.max(1, ptyRows - 1));
    shell.resize(ptyCols, ptyRows);
  } catch {}
}
// Coalesce PTY output: Claude's TUI emits many tiny writes per frame. Batching them
// into one message every few ms collapses hundreds of WebSocket messages/sec into a
// handful, which is the difference between a laggy and a snappy terminal.
//
// Leading-edge: the first chunk after an idle gap is sent IMMEDIATELY (zero added latency,
// so keystroke echo and the start of a response feel instant), then anything arriving
// within the next few ms is coalesced into one trailing flush. Best of both.
const TERM_FLUSH_MS = 8;
let pending = "";
let flushTimer = null;
function flushTerm() {
  if (!pending) return;
  const data = pending;
  pending = "";
  broadcast({ type: "term", data });
}
function onPtyData(d) {
  termBuffer += d;
  // Trim only once we've grown a full buffer past the cap, not on every write — under heavy
  // output that turns a 256KB re-allocation per flush into one per ~256KB of throughput.
  if (termBuffer.length > TERM_BUFFER_MAX * 2) termBuffer = termBuffer.slice(-TERM_BUFFER_MAX);
  pending += d;
  if (flushTimer) return; // inside a batch window — accumulate; the timer flushes it
  flushTerm(); // leading edge: emit the first chunk with no delay
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushTerm();
  }, TERM_FLUSH_MS);
}
// pnpm, Yarn PnP, CI caches, and Docker COPY frequently strip the +x bit from node-pty's
// prebuilt spawn-helper, which makes pty.spawn die — the single most common runtime failure.
// Restore it in-process, since a postinstall script can't help the people who hit this most
// (--ignore-scripts / pnpm users disable postinstall). Returns true if it actually fixed a bit.
function ensureSpawnHelperExecutable() {
  let fixed = false;
  try {
    const root = path.dirname(require.resolve("node-pty/package.json")); // works wherever it's hoisted
    for (const base of [path.join(root, "prebuilds"), path.join(root, "build", "Release")]) {
      let ents;
      try {
        ents = fs.readdirSync(base, { withFileTypes: true });
      } catch {
        continue;
      }
      const files = [];
      for (const ent of ents) {
        if (ent.isDirectory()) files.push(path.join(base, ent.name, "spawn-helper"));
        else if (ent.name === "spawn-helper") files.push(path.join(base, ent.name));
      }
      for (const f of files) {
        try {
          if (!(fs.statSync(f).mode & 0o111)) {
            fs.chmodSync(f, 0o755);
            fixed = true;
          }
        } catch {}
      }
    }
  } catch {}
  return fixed;
}

// Turn a spawn failure into a specific, actionable message instead of a generic one.
function diagnosePtyFailure(e) {
  const msg = (e && e.message) || String(e);
  let hint;
  if (/NODE_MODULE_VERSION|compiled against|different Node/i.test(msg))
    hint = "node-pty was built for a different Node version — rebuild it:\n  npm rebuild node-pty";
  else if (/spawn-helper|EACCES|ENOENT|permission/i.test(msg))
    hint =
      "node-pty's spawn-helper is missing or not executable:\n" +
      "  chmod +x node_modules/node-pty/prebuilds/*/spawn-helper\n  npm rebuild node-pty";
  else hint = "Reinstall the native module:\n  npm rebuild node-pty";
  return (
    `Embedded terminal could not start (${msg}).\n${hint}\n` +
    `The canvas and selection bridge still work — run \`${CLAUDE_CMD}\` in your own terminal beside this window.`
  );
}

function spawnPty(cols = 100, rows = 32) {
  if (!pty) return null; // optional dependency absent — startShell shows the fallback message
  ensureSpawnHelperExecutable(); // proactively fix a stripped +x bit before we spawn
  const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
  const cwd = path.dirname(DOC);
  const sh = process.env.SHELL || (os.platform() === "win32" ? "powershell.exe" : "/bin/bash");
  const opts = { name: "xterm-256color", cols, rows, cwd, env };
  // Launch through the user's interactive login shell so PATH, rc files, and aliases apply —
  // this is how `claude` is normally found.
  try {
    return pty.spawn(sh, ["-ilc", CLAUDE_CMD], opts);
  } catch (e) {
    console.warn(
      `Could not start "${CLAUDE_CMD}" via ${sh} (${e.message}); opening a plain shell.`
    );
  }
  // Plain-shell fallback. If even this fails, a stripped +x bit on spawn-helper is the usual
  // cause: self-heal it and retry once before giving up with a diagnosis.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return pty.spawn(sh, [], opts);
    } catch (e) {
      if (attempt === 0 && ensureSpawnHelperExecutable()) continue; // fixed a bit → retry
      console.error(diagnosePtyFailure(e));
      return null;
    }
  }
  return null;
}

// Start the PTY and wire BOTH its data and exit handlers (the earlier version reattached
// only onData on restart, so auto-restart silently worked just once). On exit we restart —
// but a command that dies immediately (claude missing, an instant crash, or the user typing
// `exit`) would otherwise respawn in a tight loop, so we count rapid exits, back off, and
// stop after a few with a clear message instead of spinning the CPU.
const RAPID_EXIT_MS = 1000;
const MAX_RAPID_EXITS = 5;
let shellSpawnAt = 0;
let rapidExits = 0;
function startShell() {
  shell = spawnPty(ptyCols, ptyRows); // respawn at the current size, not the 100x32 default
  if (!shell) {
    // Two cases, both non-fatal: node-pty isn't installed at all, or it is but the spawn
    // failed (details already in the server console via diagnosePtyFailure). Either way the
    // canvas + selection bridge work, so point the user at running claude in their own terminal.
    const data = pty
      ? "\r\nEmbedded terminal could not start (see the server console). The canvas and selection still work — run claude in your own terminal beside this window and it gets the same context.\r\n"
      : "\r\nEmbedded terminal disabled: node-pty isn't installed. The canvas and selection still work — run claude in your own terminal beside this window (it gets the same context via the hooks). To enable the in-window terminal: npm i node-pty\r\n";
    broadcast({ type: "term", data });
    return;
  }
  shellSpawnAt = Date.now();
  shell.onData(onPtyData);
  shell.onExit(({ exitCode }) => {
    termBuffer = "";
    pending = ""; // new session — drop the old screen
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    rapidExits = Date.now() - shellSpawnAt < RAPID_EXIT_MS ? rapidExits + 1 : 0;
    if (rapidExits >= MAX_RAPID_EXITS) {
      shell = null;
      broadcast({
        type: "term",
        data: `\r\n[session kept exiting (last code ${exitCode}) — stopped. Check that your command ('${CLAUDE_CMD}') runs, then reload to retry.]\r\n`,
      });
      return;
    }
    broadcast({ type: "term", data: `\r\n[session exited ${exitCode} — restarting]\r\n` });
    setTimeout(startShell, rapidExits ? Math.min(rapidExits * 400, 2000) : 0);
  });
}

// ---------- websocket: terminal stream + doc pushes + selection bridge ----------
// verifyClient rejects the upgrade (HTTP 401) unless it passes Host + Origin + token.
const wss = new WebSocketServer({ server, verifyClient: ({ req }) => wsAllowed(req) });
const clients = new Set();

wss.on("connection", (ws) => {
  clients.add(ws);
  let reconnect = false;
  if (!shell) {
    termBuffer = "";
    rapidExits = 0; // a fresh manual connect (e.g. reload) earns a clean slate of retries
    startShell();
  } else if (termBuffer) {
    // Reconnect (e.g. page reload): replay the current screen for instant content, and
    // flag for a forced repaint once this client's real size lands (see resize handler).
    ws.send(JSON.stringify({ type: "term", data: termBuffer }));
    reconnect = true;
  }
  ws.send(JSON.stringify({ type: "doc", content: read(), missing: !fs.existsSync(DOC) }));
  ws.send(JSON.stringify({ type: "history", canUndo: history.length > 0 }));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw)); // raw is RawData (Buffer/ArrayBuffer); coerce before parsing
    } catch {
      return;
    }
    // Selection mirroring is independent of the PTY — handle it before the shell guard.
    if (msg.type === "selection" && typeof msg.text === "string") {
      const passage = msg.text.replace(/\s+/g, " ").trim().slice(0, 2000);
      const blocks = Array.isArray(msg.blocks) ? msg.blocks.slice(0, 50) : [];
      // Mirror to disk — never typed into the prompt. The hook surfaces it to Claude.
      writeSelection(passage, blocks);
      return;
    }
    // Direct in-canvas edit — independent of the PTY; writes the file straight to disk.
    if (msg.type === "edit") {
      applyDirectEdit(msg.oldRaw, msg.newRaw, msg.nth);
      return;
    }
    // Restart the Claude session: kill the PTY; the onExit handler spawns a fresh one,
    // which reloads hooks, CLAUDE.md, the MCP server, and SessionStart context. (Does not
    // reload server.js itself — that still needs a manual relaunch.)
    if (msg.type === "restart") {
      if (shell) {
        try {
          shell.kill();
        } catch {}
      }
      return;
    }
    // Client asks for a clean repaint (on refocus / after a settled resize) to un-stick
    // a terminal whose drawing desynced from its size.
    if (msg.type === "repaint") {
      repaintPty();
      return;
    }
    // Switch to a different document (toolbar file picker).
    if (msg.type === "open") {
      const r = openDoc(msg.path);
      if (r.error) ws.send(JSON.stringify({ type: "open-error", message: r.error }));
      return;
    }
    // Roll back the last change. Write the previous version and broadcast it directly;
    // pre-set `last` so the watcher doesn't re-push it onto history (keeps undo linear).
    if (msg.type === "undo") {
      if (history.length) {
        const prev = history.pop();
        historyBytes -= prev.length;
        last = prev;
        lastMissing = false;
        try {
          fs.writeFileSync(DOC, prev);
        } catch {}
        broadcast({ type: "doc", content: prev, missing: false });
      }
      broadcastHistory();
      return;
    }
    if (!shell) return;
    if (msg.type === "term-in") shell.write(msg.data);
    if (msg.type === "resize" && msg.cols && msg.rows) {
      ptyCols = msg.cols;
      ptyRows = msg.rows;
      try {
        shell.resize(msg.cols, msg.rows);
      } catch {}
      if (reconnect) {
        reconnect = false;
        // The terminal is now correctly sized; force a clean repaint of the replayed screen.
        setTimeout(repaintPty, 50);
      }
    }
  });

  ws.on("close", () => clients.delete(ws));
});

function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const c of clients) if (c.readyState === 1) c.send(s);
}

// ---------- watch the file; the disk is the interface ----------
// Event-driven (near-instant) so the canvas re-renders the moment Claude's edit hits
// disk — mid-turn, before Claude finishes narrating. fs.watch on the *directory* (not
// the file) survives atomic save-by-rename, which an editor or Claude's writer may use
// and which would otherwise silence a file-level watch. A slow polling watch stays on
// as a safety net; the `last` check keeps either path from double-broadcasting.
let last = read();
let lastMissing = !fs.existsSync(DOC);
let updateTimer = null;
// Undo history: prior document contents, newest last. Every observed change (from Claude,
// the canvas, or an external editor) pushes the previous version, so the doc-side Undo
// button can roll back regardless of who made the change.
const HISTORY_BYTES_MAX = 8 * 1024 * 1024; // bound undo memory by total bytes, not count
const history = [];
let historyBytes = 0;
function broadcastHistory() {
  broadcast({ type: "history", canUndo: history.length > 0 });
}
function maybeUpdate() {
  const missing = !fs.existsSync(DOC);
  const next = read();
  if (next !== last || missing !== lastMissing) {
    if (!missing && !lastMissing && next !== last) {
      history.push(last);
      historyBytes += last.length;
      while (history.length > 1 && historyBytes > HISTORY_BYTES_MAX)
        historyBytes -= history.shift().length;
    }
    last = next;
    lastMissing = missing;
    // A deleted doc broadcasts an explicit `missing` flag so the canvas shows "removed"
    // rather than a blank page indistinguishable from an emptied file.
    broadcast({ type: "doc", content: next, missing });
    broadcastHistory();
  }
}
function scheduleUpdate() {
  // tiny debounce so a multi-write save coalesces into one re-render once it settles
  if (updateTimer) clearTimeout(updateTimer);
  updateTimer = setTimeout(maybeUpdate, 20);
}
// Re-pointable watcher so the file picker can switch documents at runtime.
let docWatcher = null,
  watchedDoc = null;
function startWatcher() {
  try {
    if (docWatcher) docWatcher.close();
  } catch {}
  if (watchedDoc) fs.unwatchFile(watchedDoc, maybeUpdate);
  watchedDoc = DOC;
  try {
    docWatcher = fs.watch(path.dirname(DOC), (_event, filename) => {
      if (!filename || filename === path.basename(DOC)) scheduleUpdate();
    });
  } catch (e) {
    console.warn(`fs.watch unavailable (${e.message}); relying on polling.`);
  }
  fs.watchFile(DOC, { interval: 1000 }, maybeUpdate); // fallback safety net
}
startWatcher();

// Switch the active document at runtime (toolbar file picker) WITHOUT restarting the
// Claude session. Only the content document changes; the support files (selection,
// runtime, hooks, MCP registration) stay anchored to the folder mdinterface launched in,
// so the hooks keep working and the chat is preserved. canvas_edit follows the new doc
// because it reads the current path from the runtime file (writeRuntime below).
// canvas_open is in the blanket-approved mcp__mdinterface__* set, and whatever it opens becomes
// the target canvas_edit writes to. So a prompt-injected document could otherwise chain
// canvas_open → canvas_edit to write a hook into .claude/settings.local.json (or .mcp.json)
// with zero further approval — turning "edit my markdown" into command execution. This guard
// is what keeps canvas_open to its intended job: swapping between documents.
//
// realpath FIRST so traversal ("../.claude/…") and symlinks (a .md pointing into .claude/)
// are checked on the resolved target, not the name — the naive version ships its own bypass.
const ALLOWED_DOC_EXT = new Set([".md", ".markdown", ".txt"]);
function resolveSafeDoc(requested) {
  let real;
  try {
    real = fs.realpathSync(requested);
  } catch {
    return null;
  } // must already exist + be readable
  if (!fs.statSync(real).isFile()) return null; // no directories
  if (!ALLOWED_DOC_EXT.has(path.extname(real).toLowerCase())) return null; // primary control
  if (real.split(path.sep).includes(".claude")) return null; // never anything under .claude/
  return real;
}

function openDoc(rawPath) {
  if (typeof rawPath !== "string" || !rawPath.trim()) return { error: "No path given." };
  let p = rawPath.trim();
  // Tolerate pasted paths wrapped in quotes (a common habit, esp. for paths with spaces).
  if (p.length >= 2 && ((p[0] === "'" && p.endsWith("'")) || (p[0] === '"' && p.endsWith('"'))))
    p = p.slice(1, -1);
  p = p.replace(/\\ /g, " "); // unescape "\ " from shell-style drag-and-drop
  const expanded = path.resolve(p.replace(/^~(?=\/|$)/, os.homedir()));
  if (!fs.existsSync(expanded)) return { error: `Not found: ${expanded}` };
  if (fs.statSync(expanded).isDirectory()) return { error: `That's a directory: ${expanded}` };
  const resolved = resolveSafeDoc(expanded);
  if (!resolved)
    return {
      error: `Refused to open ${path.basename(expanded)} — only .md/.markdown/.txt files outside .claude/ can be opened.`,
    };
  if (resolved === DOC) return { error: "That document is already open." };

  DOC = resolved;
  history.length = 0;
  historyBytes = 0;
  last = read();
  lastMissing = !fs.existsSync(DOC);
  writeRuntime(); // runtime.doc → new path, so canvas_edit edits the right file
  writeSelection("", []); // clear the (now-irrelevant) selection
  startWatcher(); // watch the new file/folder

  broadcast({ type: "opened", path: DOC, name: path.basename(DOC) });
  broadcast({ type: "doc", content: read(), missing: lastMissing });
  broadcastHistory();
  return { ok: true }; // no shell.kill() — the Claude session is preserved
}

// Bind to loopback only — never expose the PTY to the LAN.
// Fail clearly instead of throwing a raw stack trace when the port is taken (the common
// case: another mdinterface is already running). The listen error surfaces on the http server
// and/or the attached WebSocket server, so handle both.
function onServerError(e) {
  if (e && e.code === "EADDRINUSE") {
    console.error(
      `\n  Port ${PORT} is already in use — another mdinterface may be running.\n` +
        `  Stop it (lsof -ti :${PORT} | xargs kill) or pick another port:\n` +
        `    mdinterface ${JSON.stringify(path.basename(DOC))} --port 8001\n`
    );
  } else {
    console.error(`\n  mdinterface could not start: ${(e && e.message) || e}\n`);
  }
  process.exit(1);
}
server.on("error", onServerError);
wss.on("error", onServerError);

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://localhost:${PORT}/?t=${TOKEN}`;
  console.log(`mdinterface ▸ ${path.basename(DOC)} ▸ ${url}`);
  const opener =
    os.platform() === "darwin" ? "open" : os.platform() === "win32" ? "start" : "xdg-open";
  require("node:child_process").exec(`${opener} "${url}"`);
});
