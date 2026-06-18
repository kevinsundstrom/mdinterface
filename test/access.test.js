// @ts-check
// The access layer is the security boundary (loopback + token + Origin/Host), so it gets
// the most direct coverage — especially the look-alike-host cases a substring check would miss.
const test = require("node:test");
const assert = require("node:assert/strict");
const makeAccess = require("../access");

const PORT = 7777;
const TOKEN = "secrettoken-0123456789abcdef";
const { tokenOf, originAllowed, wsAllowed, ALLOWED_HOSTS } = makeAccess(PORT, TOKEN);

test("tokenOf extracts the ?t= query param", () => {
  assert.equal(tokenOf(`/?t=${TOKEN}`, `localhost:${PORT}`), TOKEN);
  assert.equal(tokenOf("/ws?t=abc&x=1", `localhost:${PORT}`), "abc");
  assert.equal(tokenOf("/", `localhost:${PORT}`), null);
});

test("originAllowed: loopback origins on the right port pass", () => {
  assert.equal(originAllowed(`http://localhost:${PORT}`), true);
  assert.equal(originAllowed(`http://127.0.0.1:${PORT}`), true);
});

test("originAllowed: absent Origin passes (non-browser client; token still gates it)", () => {
  assert.equal(originAllowed(undefined), true);
  assert.equal(originAllowed(""), true);
});

test("originAllowed: cross-site, look-alike, and wrong-port origins are rejected", () => {
  assert.equal(originAllowed("https://evil.com"), false);
  // The DNS-rebinding / substring-bypass case: must be exact host equality, not "contains".
  assert.equal(originAllowed(`http://127.0.0.1.attacker.com:${PORT}`), false);
  assert.equal(originAllowed(`http://localhost.evil.com:${PORT}`), false);
  assert.equal(originAllowed(`http://localhost:1234`), false);
  assert.equal(originAllowed("not a url"), false);
});

const okReq = {
  url: `/?t=${TOKEN}`,
  headers: { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}` },
};

test("wsAllowed: valid host + origin + token is accepted", () => {
  assert.equal(wsAllowed(okReq), true);
});

test("wsAllowed: wrong or missing token is rejected", () => {
  assert.equal(wsAllowed({ ...okReq, url: "/?t=wrong" }), false);
  assert.equal(wsAllowed({ ...okReq, url: "/" }), false);
});

test("wsAllowed: look-alike Host is rejected (DNS-rebinding guard)", () => {
  assert.equal(
    wsAllowed({
      url: `/?t=${TOKEN}`,
      headers: { host: `127.0.0.1.attacker.com:${PORT}`, origin: `http://127.0.0.1:${PORT}` },
    }),
    false
  );
});

test("wsAllowed: cross-site Origin is rejected even with a valid host", () => {
  assert.equal(
    wsAllowed({
      url: `/?t=${TOKEN}`,
      headers: { host: `127.0.0.1:${PORT}`, origin: "https://evil.com" },
    }),
    false
  );
});

test("wsAllowed: a non-browser client (no Origin) with valid host + token passes", () => {
  assert.equal(wsAllowed({ url: `/?t=${TOKEN}`, headers: { host: `localhost:${PORT}` } }), true);
});

test("ALLOWED_HOSTS holds exactly the three loopback forms for this port", () => {
  assert.ok(ALLOWED_HOSTS.has(`localhost:${PORT}`));
  assert.ok(ALLOWED_HOSTS.has(`127.0.0.1:${PORT}`));
  assert.ok(ALLOWED_HOSTS.has(`[::1]:${PORT}`));
});
