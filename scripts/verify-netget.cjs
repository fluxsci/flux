// Verification of the pdf:netGet backend (electron/netFetch.cjs) under real Electron:
// the COOKIE JAR is the point — publishers count a "session" per cookie-less request
// (Cell Press IP-bans at >90 sessions/5min), so netGet must present ONE session across
// requests and across redirect hops, not one per request like Node fetch did.
//   Run: DISPLAY=:0 ./node_modules/.bin/electron scripts/verify-netget.cjs --no-sandbox
const { app, session } = require("electron");
const http = require("node:http");
const path = require("node:path");
const { createNetGet } = require(path.join(__dirname, "..", "electron", "netFetch.cjs"));

let failures = 0;
function ok(cond, name, detail = "") {
  console.log(`${cond ? "✓" : "✗"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}

app.whenReady().then(async () => {
  // A local "publisher": counts a new session whenever a request arrives WITHOUT its
  // cookie (exactly how the real session-counting works).
  let sessionsCreated = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    const hasCookie = /sid=/.test(req.headers.cookie || "");
    if (!hasCookie) {
      sessionsCreated++;
      res.setHeader("Set-Cookie", "sid=abc123; Path=/");
    }
    if (u.pathname === "/cookie") return res.end(hasCookie ? "HIT" : "NEW");
    if (u.pathname === "/redirect") {
      res.statusCode = 302;
      res.setHeader("Location", "/cookie");
      return res.end();
    }
    if (u.pathname === "/hop2") {
      res.statusCode = 302;
      res.setHeader("Location", "/redirect");
      return res.end();
    }
    if (u.pathname === "/pdf") {
      res.setHeader("Content-Type", "application/pdf");
      return res.end(Buffer.from("%PDF-1.4 test\n%%EOF"));
    }
    if (u.pathname === "/hang") return; // never responds — timeout test
    res.statusCode = 404;
    res.end("nope");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const netGet = createNetGet({
    session,
    getKey: () => "",
    allowPrivate: true, // harness targets 127.0.0.1
    partition: "netget-test", // in-memory partition — fresh jar per run
    timeouts: { bytes: 1500, meta: 1500 },
  });

  const r1 = await netGet(`${base}/cookie`, "text");
  ok(r1.text === "NEW", "first request creates ONE session", JSON.stringify(r1));
  const r2 = await netGet(`${base}/cookie`, "text");
  ok(r2.text === "HIT" && sessionsCreated === 1, "second request REUSES it (cookie jar works)", `sessions=${sessionsCreated}`);
  const r3 = await netGet(`${base}/hop2`, "text");
  ok(r3.text === "HIT" && sessionsCreated === 1, "2-hop redirect chain carries the cookie — still ONE session", `sessions=${sessionsCreated}`);

  const r4 = await netGet(`${base}/pdf`, "bytes");
  const bytes = r4.bytesB64 ? Buffer.from(r4.bytesB64, "base64").toString() : "";
  ok(bytes.startsWith("%PDF") && /pdf/.test(r4.contentType || ""), "bytes mode returns the PDF + content type");

  const t0 = Date.now();
  const r5 = await netGet(`${base}/hang`, "text");
  ok(!!r5.error && Date.now() - t0 < 5000, "hung server times out instead of stalling the run", JSON.stringify(r5));

  const guarded = createNetGet({ session, getKey: () => "" });
  const r6 = await guarded(`${base}/cookie`, "text");
  ok(!!r6.error && /blocked/.test(r6.error), "SSRF guard still blocks private ranges in production mode");

  server.close();
  console.log(failures ? `\nNETGET VERIFY: ${failures} FAILED` : "\nNETGET VERIFY: PASS");
  app.exit(failures ? 1 : 0);
});
