# Working through the mdinterface canvas

This project is viewed in **mdinterface**: a rendered doc on the left, a live Claude Code
session (you) on the right, bridged only by files on disk. Two standing rules:

## Notion sync — git-native, 3-way ("sync" / "pull" / "push")

A document mirrors a Notion page via a marker on its first line:

    <!-- mdinterface:notion <page-url-or-id> -->

The legacy `<!-- line0:notion … -->` and `<!-- mdcanvas:notion … -->` markers are still
recognized (documents synced under either earlier name keep working); write the
`mdinterface:notion` form on any new pull.

**Sync requires the document to be in a git repo.** If `git rev-parse --is-inside-work-tree`
fails, do NOT sync — tell the user to `git init` (and commit the file) first. Git is the base
and the history; mdinterface adds nothing on top of it but the Notion round-trip. There are no
backup folders — git history is the backup.

The "last-synced" point is a lightweight tag, **`mdinterface-synced/<page-id>`**, that each sync
moves to the commit holding the agreed content. The file at that tag is BASE
(`git show mdinterface-synced/<id>:<file>`). Derive `<page-id>` from the marker (the 32-hex id).

Cleaning, whenever you bring Notion content local: strip `<span discussion-urls="…">…</span>`
keeping inner text, drop `<mention-user .../>`, turn `<br>— Name` attributions into their own
`>` line, unescape `\[ \]`; if the page has multiple version toggles, ask which (or use the
latest). Keep the marker on line 1 of the local file; strip it before sending to Notion.

**"sync"** — reconcile automatically:
1. BASE = file at the tag (no tag ⇒ first sync). LOCAL = working file, marker stripped.
   REMOTE = the Notion page, fetched + cleaned.
2. `localMoved = LOCAL≠BASE` (i.e. `git diff mdinterface-synced/<id> -- <file>` is non-empty);
   `remoteMoved = REMOTE≠BASE`.
   - **neither** → already in sync; do nothing.
   - **only REMOTE moved** (the common case) → PULL: write REMOTE to the file.
   - **only LOCAL moved** → PUSH: update the Notion page with LOCAL.
   - **both moved** → CONFLICT: do NOT clobber. You hold BASE, LOCAL, and REMOTE — summarize
     what each side changed and ask the user to take Notion, take local, or merge (do a real
     3-way merge if they pick merge); then apply their choice.
   - **first sync, no tag, sides differ** → treat as a conflict and ask.
3. **Land the agreed content:** write it to the file, `git add <file> && git commit -m
   "sync(notion): <page>"`, then `git tag -f mdinterface-synced/<id>` at that commit. On a PULL,
   also `canvas_open` the file so the canvas re-points to the updated content.

**"pull"** / **"push"** force a direction regardless of state, then commit + move the tag the
same way. **"open <page>"** just `canvas_open`s the existing local file without fetching.

Undo a sync with git: `git revert` the sync commit (local), or restore the page from its
content at the prior tagged commit via `notion-update-page` (remote). The marker is mdinterface
metadata — strip before sending to Notion, never show it as content.

## The canvas selection is injected every turn — use it

The user's current selection in the canvas is written to
`.claude/mdinterface-selection.txt` and injected before every message, wrapped like:

```
===== CANVAS SELECTION (<file>, line N) =====
<the highlighted text>
===== END CANVAS SELECTION =====
```

When that block is present and the user says "this", "here", "the selection", "the
highlighted text", or anything deictic, **that passage is the referent**. Read it and
act on it directly — do not ask which text they mean.

**Only the selection block in the CURRENT message is live.** The hook re-injects the
selection every turn, so earlier turns leave their own (now stale) CANVAS SELECTION
blocks in the history. A changed selection is a hard signal that the user has moved on
to a new referent — always use the most recent block and ignore older ones, unless the
message is *very clearly* about earlier discussion. A `CANVAS SELECTION: NONE` block
means nothing is selected right now; don't reach back to a previous selection.

## Imperative commands act on the document, not on the conversation

Short commands like "delete that", "remove X", "change this", "cut it", "fix it" are
edits to the **canvas document** — almost always about the current selection. Never
interpret them as meta-commands about the session, your context, or chat history, and
never clear or reset the conversation. Treat something as "clear my context" ONLY if the
user says so explicitly (e.g. "clear the conversation", "start over", "/clear"). When in
doubt, the instruction is about the text in the canvas. Example: with "…the entire
interface" selected, **"delete entire"** means remove the word *entire* from the doc —
not wipe anything.

## To edit the doc, use `canvas_edit` — NOT the built-in Edit/Write

mdinterface provides an MCP tool, **`canvas_edit`** (`mcp__mdinterface__canvas_edit`), for
changing the canvas document. **Always prefer it over the built-in `Edit`/`Write` tools**
for this doc. Why: the document is already in your context (SessionStart), so `canvas_edit`
takes `old_string`/`new_string` directly with **no prior `Read`** — whereas the built-in
`Edit` *requires* a Read first, adding a wasted round-trip. `canvas_edit` writes the file
and the canvas re-renders instantly.

- `old_string` must match the document exactly and be unique (add surrounding context if
  not), or pass `replace_all: true`. Pass an empty `new_string` to delete text.
- Only fall back to the built-in `Edit` (Read-then-Edit) if `canvas_edit` is unavailable.

**The open document can change mid-session** via the toolbar file picker — and doing so
does NOT restart you, so the doc loaded into your context at SessionStart may be stale.
`canvas_edit` and the canvas selection always follow the *current* file, but if you need
the full current content (e.g. to summarize or do broad edits) and the user has switched
files since you started, **`Read` the current document first** rather than trusting your
preloaded copy.

## Edits should be fast and terse — the canvas shows the result, not your prose

When the user asks for a text change:

1. Go straight to `canvas_edit` — no `Read`, no preamble explaining what you're about to do.
2. The canvas re-renders the instant the file is written, so the user *sees* the change
   immediately — don't quote it back, show a diff, or describe it.
3. After a **successful** edit, say **nothing at all** — no "Done", no confirmation, no
   summary. The canvas is the feedback. Reply only if the edit *failed*, or you genuinely
   need to ask the user something. Never narrate what you did.

The ideal edit turn is a single `canvas_edit` call and **zero** words of reply.
