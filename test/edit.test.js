// @ts-check
// canvas_edit's matching logic decides whether an edit lands on the right text, so it's worth
// pinning: exact match, ambiguity guard, replace_all, the whitespace-tolerant fallback, and
// the not-found path. applyEdit reads/writes a real temp file (dryRun avoids the write).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { applyEdit, wsTolerantRegex } = require("../mcp-server.js");

/** Write `content` to a throwaway doc and return its path. */
function tmpDoc(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdc-"));
  const p = path.join(dir, "doc.md");
  fs.writeFileSync(p, content);
  return p;
}

test("applyEdit replaces an exact, unique match and writes the file", () => {
  const p = tmpDoc("# Title\n\nhello world\n");
  const msg = applyEdit(p, "hello world", "goodbye", false, false);
  assert.match(msg, /Edited doc\.md/);
  assert.equal(fs.readFileSync(p, "utf8"), "# Title\n\ngoodbye\n");
});

test("applyEdit with dryRun validates without writing", () => {
  const p = tmpDoc("abc def");
  applyEdit(p, "abc", "xyz", false, true);
  assert.equal(fs.readFileSync(p, "utf8"), "abc def");
});

test("applyEdit refuses a non-unique match unless replace_all is set", () => {
  const p = tmpDoc("foo foo foo");
  assert.throws(() => applyEdit(p, "foo", "bar", false, false), /matches 3 places/);
  const msg = applyEdit(p, "foo", "bar", true, false);
  assert.match(msg, /Replaced 3 occurrence/);
  assert.equal(fs.readFileSync(p, "utf8"), "bar bar bar");
});

test("applyEdit falls back to whitespace-tolerant matching", () => {
  const p = tmpDoc("the  quick\nbrown fox");
  const msg = applyEdit(p, "the quick brown fox", "X", false, false);
  assert.match(msg, /ignoring whitespace/);
  assert.equal(fs.readFileSync(p, "utf8"), "X");
});

test("applyEdit throws a helpful error when the text isn't found", () => {
  const p = tmpDoc("# Heading\n\nsome text");
  assert.throws(() => applyEdit(p, "nonexistent passage", "x", false, false), /not found/);
});

test("wsTolerantRegex matches across differing whitespace and escapes regex specials", () => {
  assert.ok(wsTolerantRegex("a b", "").test("a   b"));
  assert.ok(wsTolerantRegex("a b", "").test("a\nb"));
  assert.ok(wsTolerantRegex("c++ (x)", "").test("c++ (x)")); // specials treated literally
  assert.equal(wsTolerantRegex("nomatch", "").test("different"), false);
});
