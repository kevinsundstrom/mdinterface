// @ts-check
// The block classifier decides which DOM nodes render() reuses vs. rebuilds — the exact
// logic behind the incremental renderer (and where the edit-flow regressions lived). These
// pin its contract: same / changed / new, plus the oldIdx mapping that reused nodes rely on.
const test = require("node:test");
const assert = require("node:assert/strict");
const { tokenizeWords, diffOps, classifyBlocks } = require("../public/render-core.js");

/** Build a block list where each block's text mirrors its raw (enough for classification). */
const blocks = (...raws) => raws.map((raw) => ({ raw, text: raw }));
/** newB only needs `.raw` for classification. */
const news = (...raws) => raws.map((raw) => ({ raw }));

test("tokenizeWords splits into alternating words/whitespace, dropping empties", () => {
  assert.deepEqual(tokenizeWords("a b"), ["a", " ", "b"]);
  assert.deepEqual(tokenizeWords("  x"), ["  ", "x"]);
  assert.deepEqual(tokenizeWords(""), []);
});

test("diffOps reconstructs the new sequence and marks unchanged items eq", () => {
  const a = ["the", "quick", "fox"];
  const b = ["the", "brown", "fox"];
  const ops = diffOps(a, b);
  const out = [];
  for (const [op, ai, bj] of ops) {
    if (op === "eq") out.push(a[ai]);
    else if (op === "ins") out.push(b[bj]);
  }
  assert.deepEqual(out, b); // del ops are skipped, ins/eq rebuild b
  assert.equal(ops.filter((o) => o[0] === "eq").length, 2); // "the" and "fox" unchanged
});

test("classifyBlocks: identical input → every block 'same' with its own oldIdx", () => {
  const old = blocks("# H", "para", "- item");
  assert.deepEqual(classifyBlocks(old, news("# H", "para", "- item")), [
    { type: "same", oldIdx: 0 },
    { type: "same", oldIdx: 1 },
    { type: "same", oldIdx: 2 },
  ]);
});

test("classifyBlocks: a changed middle block is 'changed' (with oldText), neighbours 'same'", () => {
  const old = blocks("# H", "para", "- item");
  const res = classifyBlocks(old, news("# H", "para EDITED", "- item"));
  assert.deepEqual(res[0], { type: "same", oldIdx: 0 });
  assert.equal(res[1].type, "changed");
  assert.equal(res[1].oldText, "para");
  assert.deepEqual(res[2], { type: "same", oldIdx: 2 });
});

test("classifyBlocks: an inserted block is 'new'; existing blocks keep correct oldIdx", () => {
  const old = blocks("# H", "para");
  assert.deepEqual(classifyBlocks(old, news("# H", "NEW", "para")), [
    { type: "same", oldIdx: 0 },
    { type: "new" },
    { type: "same", oldIdx: 1 },
  ]);
});

test("classifyBlocks: a deleted block leaves survivors 'same' with the right (shifted) oldIdx", () => {
  const old = blocks("a", "b", "c");
  assert.deepEqual(classifyBlocks(old, news("a", "c")), [
    { type: "same", oldIdx: 0 },
    { type: "same", oldIdx: 2 }, // "c" still maps to old index 2, not 1
  ]);
});
