// Pure render/diff helpers shared by the browser canvas (public/index.html) and the
// node:test suite. NO DOM access — strings/arrays in, diff classification out. In the
// browser this loads as a plain <script>, so these functions become globals that render()
// calls directly; in Node, the export block at the bottom hands the same functions to
// require() so they can be unit-tested without a DOM.

function tokenizeWords(s) {
  return s.split(/(\s+)/).filter((x) => x.length); // alternating words / whitespace
}

// Longest-common-subsequence diff ops over two string arrays.
function diffOps(a, b) {
  const m = a.length,
    n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0,
    j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push(["eq", i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push(["del", i, -1]);
      i++;
    } else {
      ops.push(["ins", -1, j]);
      j++;
    }
  }
  while (i < m) ops.push(["del", i++, -1]);
  while (j < n) ops.push(["ins", -1, j++]);
  return ops;
}

// LCS-classify a slice (oldB[lo..endO), newB[lo..endN)) into the result array at `lo`.
function classifyMiddle(oldB, newB, lo, endO, endN, res) {
  const oldRaw = [],
    newRaw = [];
  for (let i = lo; i < endO; i++) oldRaw.push(oldB[i].raw);
  for (let j = lo; j < endN; j++) newRaw.push(newB[j].raw);
  // Guard: a pathologically large divergent region would make the O(n·m) DP allocate a
  // huge matrix. Past a cap, skip the LCS and just mark the new blocks changed/new
  // positionally — the highlight is cosmetic; document correctness is unaffected.
  if (oldRaw.length * newRaw.length > 250000) {
    for (let j = 0; j < newRaw.length; j++)
      res[lo + j] =
        j < oldRaw.length ? { type: "changed", oldText: oldB[lo + j].text } : { type: "new" };
    return;
  }
  const ops = diffOps(oldRaw, newRaw);
  let k = 0;
  while (k < ops.length) {
    if (ops[k][0] === "eq") {
      res[lo + ops[k][2]] = { type: "same", oldIdx: lo + ops[k][1] };
      k++;
      continue;
    }
    const dels = [],
      inses = [];
    while (k < ops.length && ops[k][0] !== "eq") {
      if (ops[k][0] === "del") dels.push(ops[k][1]);
      else inses.push(ops[k][2]);
      k++;
    }
    inses.forEach((bIdx, idx) => {
      res[lo + bIdx] =
        idx < dels.length
          ? { type: "changed", oldText: oldB[lo + dels[idx]].text }
          : { type: "new" };
    });
  }
}

// For each new block: { type: 'same'|'new'|'changed', oldIdx? (when 'same'), oldText? (when 'changed') }.
function classifyBlocks(oldB, newB) {
  const res = new Array(newB.length).fill(null);
  // Trim the common prefix/suffix first — almost every edit changes one contiguous
  // region, so this turns a full N×N diff into a tiny one over just the changed window.
  let lo = 0;
  const minLen = Math.min(oldB.length, newB.length);
  while (lo < minLen && oldB[lo].raw === newB[lo].raw) {
    res[lo] = { type: "same", oldIdx: lo };
    lo++;
  }
  let endO = oldB.length,
    endN = newB.length;
  while (endO > lo && endN > lo && oldB[endO - 1].raw === newB[endN - 1].raw) {
    res[--endN] = { type: "same", oldIdx: endO - 1 };
    endO--;
  }
  if (endN > lo) classifyMiddle(oldB, newB, lo, endO, endN, res);
  return res;
}

// Node (tests) only; in the browser `module` is undefined and the functions above are globals.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { tokenizeWords, diffOps, classifyMiddle, classifyBlocks };
}
