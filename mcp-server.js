#!/usr/bin/env node
/* mdinterface MCP server — exposes `canvas_edit` so Claude can edit the canvas document
 * WITHOUT the built-in Edit/Write tools' mandatory prior Read. The document is already
 * in Claude's context (via the SessionStart hook), so it can supply old/new text
 * directly. This process just writes the file; the running mdinterface server's file
 * watcher broadcasts the change, so the canvas re-renders instantly.
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdio (the MCP stdio transport).
 * Only stdout carries protocol messages — never log to stdout; use stderr.
 */
const fs = require("node:fs");
const path = require("node:path");

const DOC = process.argv[2] ? path.resolve(process.argv[2]) : null;
const RUNTIME_FILE = DOC
  ? path.join(path.dirname(DOC), ".claude", "mdinterface-runtime.json")
  : null;

// How to reach the mdinterface server (port/token) and which document is open (doc), written by
// the server. Used by canvas_open and to follow file switches; absent ⇒ empty (editing still
// works, since canvas_edit writes the file directly).
function runtime() {
  try {
    return JSON.parse(fs.readFileSync(RUNTIME_FILE, "utf8"));
  } catch {
    return {};
  }
}

// Switch the canvas to a different document via the server (so it broadcasts + re-points
// the watcher). The file must already exist.
async function canvasOpen(args) {
  const p = args?.path;
  if (typeof p !== "string" || !p.trim()) throw new Error("path is required.");
  const rt = runtime();
  if (!rt.port || !rt.token) throw new Error("The mdinterface server can't be reached.");
  let r;
  try {
    r = await fetch(`http://127.0.0.1:${rt.port}/open?t=${rt.token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: p }),
    });
  } catch {
    throw new Error("The mdinterface server can't be reached.");
  }
  const j = await r.json().catch(() => ({}));
  if (j.error) throw new Error(j.error);
  return `Opened ${path.basename(p)} in the canvas.`;
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}
function result(id, res) {
  send({ jsonrpc: "2.0", id, result: res });
}
function rpcError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

const TOOLS = [
  {
    name: "canvas_edit",
    description:
      "Edit the markdown document shown in the mdinterface canvas by replacing an exact " +
      "string. Use this INSTEAD of the built-in Edit/Write tools for the canvas document: " +
      "it needs no prior Read (the document is already in your context) and the canvas " +
      "updates instantly. `old_string` must match the file exactly and be unique unless " +
      "`replace_all` is true. To delete text, pass an empty `new_string`.",
    inputSchema: {
      type: "object",
      properties: {
        old_string: {
          type: "string",
          description: "Exact text to replace, verbatim from the document.",
        },
        new_string: { type: "string", description: "Replacement text (empty string to delete)." },
        replace_all: { type: "boolean", description: "Replace every occurrence (default false)." },
      },
      required: ["old_string", "new_string"],
    },
  },
  {
    name: "canvas_open",
    description:
      "Switch the mdinterface canvas to a different document so the user sees and edits it. " +
      "Pass an absolute path to a local .md file (the file must already exist — write it " +
      "first if needed). Use this to open a draft you just created, e.g. one pulled from " +
      "Notion. Does not restart the session.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the .md file to open." },
      },
      required: ["path"],
    },
  },
];

// A regex that matches `str` literally EXCEPT runs of whitespace match any whitespace,
// so an edit succeeds even if the model got indentation / line-wrapping slightly off.
/**
 * @param {string} str
 * @param {string} flags
 * @returns {RegExp}
 */
function wsTolerantRegex(str, flags) {
  const escaped = str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped.replace(/\s+/g, "\\s+"), flags);
}

// Line numbers of up to 5 exact matches, for a "not unique" hint.
function matchLines(content, str) {
  const lines = [];
  let idx = content.indexOf(str);
  while (idx !== -1 && lines.length < 5) {
    lines.push(content.slice(0, idx).split("\n").length);
    idx = content.indexOf(str, idx + str.length);
  }
  return lines.length ? ` (lines ${lines.join(", ")})` : "";
}

// When nothing matches, point the model at the closest text so it fixes its next attempt
// in one try instead of guessing — the main cause of repeated failed edits.
function nearbyHint(content, oldStr) {
  const norm = oldStr.replace(/\s+/g, " ").trim();
  for (let len = Math.min(norm.length, 50); len >= 10; len -= 5) {
    let m;
    try {
      m = wsTolerantRegex(norm.slice(0, len), "").exec(content);
    } catch {
      continue;
    }
    if (m) {
      const line = content.slice(0, m.index).split("\n").length;
      const text = (content.split("\n")[line - 1] || "").trim();
      return ` Closest text is at line ${line}: «${text.slice(0, 90)}».`;
    }
  }
  return "";
}

// Match (exact, then whitespace-tolerant) and apply — or, with dryRun, just validate and
// return the message that WOULD result without writing (used by the unit tests).
/**
 * @param {string} doc absolute path to the document to edit
 * @param {string} old_string exact text to replace
 * @param {string} new_string replacement text ("" to delete)
 * @param {boolean} [replace_all] replace every occurrence instead of requiring uniqueness
 * @param {boolean} [dryRun] validate only — do not write the file
 * @returns {string} a human-readable result message
 */
function applyEdit(doc, old_string, new_string, replace_all, dryRun) {
  const content = fs.readFileSync(doc, "utf8");
  const base = path.basename(doc);

  const exact = content.split(old_string).length - 1;
  if (exact >= 1) {
    if (exact > 1 && !replace_all)
      throw new Error(
        `old_string matches ${exact} places${matchLines(content, old_string)} — add surrounding context to make it unique, or set replace_all: true.`
      );
    if (!dryRun)
      fs.writeFileSync(
        doc,
        replace_all
          ? content.split(old_string).join(new_string)
          : content.replace(old_string, () => new_string)
      );
    return replace_all ? `Replaced ${exact} occurrence(s) in ${base}.` : `Edited ${base}.`;
  }

  const re = wsTolerantRegex(old_string, "g");
  const fuzzy = (content.match(re) || []).length;
  if (fuzzy >= 1) {
    if (fuzzy > 1 && !replace_all)
      throw new Error(
        `old_string matches ${fuzzy} places (ignoring whitespace) — add surrounding context, or set replace_all: true.`
      );
    if (!dryRun)
      fs.writeFileSync(
        doc,
        content.replace(re, () => new_string)
      ); // global re; fuzzy===1 unless replace_all
    return `Edited ${base} (matched ignoring whitespace differences).`;
  }

  throw new Error(
    `old_string not found in ${base}.${nearbyHint(content, old_string)} ` +
      `Copy the text verbatim from the document, including punctuation such as em dashes (—) and arrows.`
  );
}

async function canvasEdit(args) {
  const { old_string, new_string, replace_all } = args || {};
  if (typeof old_string !== "string" || typeof new_string !== "string")
    throw new Error("old_string and new_string are required strings.");
  if (!old_string) throw new Error("old_string must not be empty.");
  if (old_string === new_string) throw new Error("old_string and new_string are identical.");

  const rt = runtime();
  // The currently-open document — read from the runtime file so canvas_edit follows the
  // file picker, falling back to the doc this server was launched with.
  const doc = rt.doc ? path.resolve(rt.doc) : DOC;
  if (!doc) throw new Error("No document is open.");
  return applyEdit(doc, old_string, new_string, replace_all, false);
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    result(id, {
      protocolVersion: params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "mdinterface", version: "0.1.0" },
    });
  } else if (method === "tools/list") {
    result(id, { tools: TOOLS });
  } else if (method === "tools/call") {
    const name = params?.name;
    const tool = name === "canvas_edit" ? canvasEdit : name === "canvas_open" ? canvasOpen : null;
    if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
    // Tools are async; surface failures as isError results
    // so the model can react and retry.
    tool(params.arguments)
      .then((text) => result(id, { content: [{ type: "text", text }] }))
      .catch((e) =>
        result(id, { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true })
      );
  } else if (method === "ping") {
    result(id, {});
  } else if (id !== undefined) {
    rpcError(id, -32601, `Method not found: ${method}`);
  }
  // notifications (no id), e.g. notifications/initialized — nothing to return
}

// Run the stdio JSON-RPC loop only when invoked directly. When this file is `require`d
// (e.g. by the unit tests) the loop stays dormant and only the pure helpers are exposed.
if (require.main === module) {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    while (true) {
      const nl = buf.indexOf("\n");
      if (nl === -1) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      try {
        handle(msg);
      } catch (e) {
        if (msg && msg.id !== undefined) rpcError(msg.id, -32603, e.message);
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

// Exposed for unit tests; importing this module never starts the stdio server (see guard above).
module.exports = { applyEdit, wsTolerantRegex, matchLines, nearbyHint };
