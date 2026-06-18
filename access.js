/* Access control for mdinterface. The server drives a live shell/Claude PTY, so it must be
 * reachable only from this machine's loopback, only by clients holding the per-launch
 * token, and (for WebSockets) only from the mdinterface page itself — not a random site you
 * visit (WebSockets bypass same-origin) and not via DNS rebinding.
 *
 * Exported as a factory so it can be unit-tested without starting the server.
 *
 * @param {number} PORT  the loopback port the server listens on
 * @param {string} TOKEN the per-launch secret required on every request
 */
module.exports = function makeAccess(PORT, TOKEN) {
  const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);

  /**
   * Pull the `?t=` token out of a request URL (resolved against `host`).
   * @param {string} reqUrl
   * @param {string} [host]
   * @returns {string | null}
   */
  function tokenOf(reqUrl, host) {
    try {
      return new URL(reqUrl, `http://${host || "localhost"}`).searchParams.get("t");
    } catch {
      return null;
    }
  }

  /**
   * True iff the WebSocket Origin is a loopback origin on our port (or absent — non-browser).
   * Exact host equality, so `127.0.0.1.attacker.com` can't slip past a substring check.
   * @param {string} [origin]
   * @returns {boolean}
   */
  function originAllowed(origin) {
    if (!origin) return true; // non-browser clients omit Origin; the token still gates them
    try {
      const u = new URL(origin);
      const loopback =
        u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
      return loopback && (u.port === String(PORT) || (!u.port && String(PORT) === "80"));
    } catch {
      return false;
    }
  }

  /**
   * Gate a WebSocket upgrade: exact Host (anti-rebinding) + loopback Origin + valid token.
   * @param {{ url?: string, headers: { host?: string, origin?: string } }} req
   * @returns {boolean}
   */
  function wsAllowed(req) {
    return (
      ALLOWED_HOSTS.has(req.headers.host) && // DNS-rebinding guard
      originAllowed(req.headers.origin) && // cross-site WebSocket guard
      tokenOf(req.url, req.headers.host) === TOKEN
    ); // per-launch secret token
  }

  return { ALLOWED_HOSTS, tokenOf, originAllowed, wsAllowed };
};
