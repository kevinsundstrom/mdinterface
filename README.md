# mdinterface

[![CI](https://github.com/kevinsundstrom/mdinterface/actions/workflows/ci.yml/badge.svg)](https://github.com/kevinsundstrom/mdinterface/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)

<!-- TODO: drop a demo GIF here (select text → ask → the block flashes and re-renders). It's a
     visual tool; a 10-second capture sells it faster than any paragraph. e.g. docs/demo.gif -->

mdinterface makes editing with Claude precise. A rendered markdown canvas sits beside a live
Claude session, bridged by the file on disk. The passage you highlight sets both what Claude
sees and what it is allowed to change, so edits stay scoped to what you pointed at instead of
sprawling across the document. Ask for a small fix or a full rewrite of that part, and watch
just that block change and re-render.

The two panes never talk to each other directly. The file on disk is the interface,
and Claude's awareness is wired through its hooks, not by typing into its prompt:


    full doc          ──SessionStart hook──▶ in Claude's context from the start
    canvas selection  ──file + UserPromptSubmit hook──▶ rides along with each message
    Claude Code       ──edits──────────────▶ the file on disk
    file watcher      ──content────────────▶ canvas re-render

## Install

No clone, no install — run it straight from npm:

    npx mdinterface            # empty canvas; pick a file in the browser
    npx mdinterface doc.md     # open a file directly

Or install it globally so `mdinterface` is always on your PATH:

    npm install -g mdinterface
    mdinterface doc.md

Requires **Node 18+** and the `claude` CLI on your PATH. The first `npx` run downloads the
package and caches it; later runs reuse the cache. If a new release doesn't show up, force a
refresh with `npx mdinterface@latest`.

## Run

    mdinterface path/to/doc.md
    # prints a URL like http://localhost:7777/?t=… — open THAT (it carries a session token)

Or start with **no file** — you get an empty canvas and a file browser; pick a `.md` and the
session begins. The folder of that first document becomes Claude's working directory for the
rest of the session, so launch from (or pick within) the project you want Claude to work in:

    mdinterface
    # empty canvas → Browse → pick a doc; Claude starts in that doc's folder

Options:

    --port 8000        # different port
    --cmd "claude --continue"   # custom launch command (or set MDINTERFACE_CMD)
    --help             # usage and exit

## From source (development)

    git clone https://github.com/kevinsundstrom/mdinterface
    cd mdinterface
    npm install        # express, ws, node-pty (ships a native helper)
    node server.js doc.md

If the terminal pane says **"Terminal unavailable,"** `node-pty`'s prebuilt helper lost its
executable bit (a common install hiccup). mdinterface tries to self-heal this at startup; if it
still fails, restore the bit yourself:

    chmod +x node_modules/node-pty/prebuilds/*/spawn-helper

If there's no prebuilt binary for your platform, build it instead (needs Xcode Command Line
Tools / build-essential):

    npm rebuild node-pty

Either way the canvas and selection bridge work even if the embedded terminal can't — just run
`claude` in your own terminal beside the window. The rendering and terminal libraries (`marked`,
`xterm` and its addons, `DOMPurify`) are **bundled in `public/vendor/`** and served locally, so
mdinterface works fully offline — no CDN, no first-load internet requirement.

## Use

- **Select** any text in the rendered doc and it becomes *ambient context* — nothing is
  typed into the prompt. The selection is mirrored to `.claude/mdinterface-selection.txt`
  next to the doc, and a `UserPromptSubmit` hook (auto-installed into
  `.claude/settings.local.json`) silently attaches it to your next message. Give a normal
  instruction — "tighten this up", "explain this" — and Claude already knows what "this"
  is. Clear the selection and it stops.
- **Edits apply immediately** — Claude changes the file and the canvas re-renders. To take
  one back, use the **Undo** button (rolls back the last change) or ask Claude to revert it;
  in a git repo, every change is also one `git diff` away.
- The right pane is the genuine CLI: `/commands`, plan mode, `claude --resume`,
  everything works, because it *is* claude running in a PTY.
- When Claude (or anything else — your editor, git checkout) changes the file,
  only what changed flashes green and updates. Scroll position is preserved.

## Notes

- If `claude` isn't found, it falls back to your shell so you can debug.
- Undo = git. Run it in a repo and every accepted change is one `git diff` away.

## Security

mdinterface runs a live shell/Claude session over a local WebSocket, so it is locked down to
this machine only:

- The server binds to **127.0.0.1** (loopback), never reachable from the network.
- Every request carries a **per-launch token** (in the URL); the WebSocket also checks the
  `Origin` and `Host` headers, so a website you visit can't connect to it.
- Rendered markdown HTML is **sanitized** (DOMPurify) before display.

Still your responsibility:

- **Only open documents you trust.** The whole file is fed into Claude's context and an
  auto-approved `canvas_edit` tool can write it, so a malicious document is a
  prompt-injection vector.
- **Single-user machines only.** The launch token is written to
  `.claude/mdinterface-runtime.json` (mode `600`) so the helper process can reach the server.
  Anyone who can read your files can read that token and drive the session — fine on your
  own machine, not on a shared host.
- mdinterface **writes into the document's folder**: `.claude/settings.local.json`
  (hooks + MCP pre-approval), `.mcp.json`, `.claude/mdinterface-selection.txt`, and
  `.claude/mdinterface-runtime.json`. The shipped `.gitignore` covers these for mdinterface's
  own repo; when you point it at a doc in **another** repo, add them to that repo's
  `.gitignore`.

### Threat model — how you'd actually get owned

There is essentially **one door, and it's a document you didn't write.** A remote attacker
can't reach the server (loopback bind + per-launch token + WebSocket `Origin`/`Host` checks
mean a website you visit or someone on your network can't connect — they don't have the token
and can't read it cross-origin). So the only way in is to get a file *to* you and have you
open it in the canvas — a contributor's PR, a shared `.md`, a downloaded doc.

When you open it, the **whole file is fed into Claude's context**, so any instructions hidden
in it (an HTML comment, white-on-white text, or just confident prose) are read as if you'd
typed them. From there:

- **The dangerous escalation is `Bash`, and `Bash` is not pre-approved** — it hits the normal
  permission prompt. So a poisoned doc degrades to social engineering: it tries to get Claude
  to propose a benign-looking command (`npm install && ./setup.sh`) that you approve on
  autopilot. **Approving a command you didn't ask for, with a foreign doc open, is the whole
  ballgame** — that's RCE as you. Don't.
- **Never run the pane in bypass-permissions / "YOLO" mode with an untrusted doc open.** That
  auto-approves `Bash`, turning the above into a true zero-click RCE on file open.
- **Zero-click, no approval needed (bounded):** an injection can still use whatever is already
  auto-approved — e.g. a `WebFetch(domain:…)` grant becomes a silent exfiltration channel
  (doc/selection text smuggled in a URL), and `canvas_edit` can silently tamper with the doc
  you're about to publish. **Prune auto-approve grants you aren't using.**

What an attacker **cannot** do, by construction: reach you over the network, escape
`canvas_edit`/`canvas_open` into `.claude/` to plant a hook (path-scoped: realpath +
extension allow-list + `.claude` refusal), steal the token via XSS (sanitized, with a
plain-text fallback), or read the `600` token file as another user. The boundary that's
*yours* to hold is the first line: **treat any document you didn't write as untrusted input,
and don't approve commands for it.**
