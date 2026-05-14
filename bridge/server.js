const tls = require("tls");
tls.DEFAULT_MIN_VERSION = "TLSv1.2";
const http = require("http");
const https = require("https");

// ── Config ────────────────────────────────────────────────────────────────────
const PORT = 3001;
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const FLEET_TTL = 300;    // seconds before data is considered stale
const SECRET = process.env.BRIDGE_SECRET || "changeme";

// ── Redis writer ──────────────────────────────────────────────────────────────
function writeToRedis(key, value, ttl) {
  return new Promise((resolve, reject) => {
    const encoded = encodeURIComponent(JSON.stringify(value));
    const path = `/set/${key}/${encoded}?EX=${ttl}`;
    const url = new URL(UPSTASH_URL);
    const options = {
      hostname: url.hostname,
      path: path,
      method: "GET",
      headers: {
        "Authorization": `Bearer ${UPSTASH_TOKEN}`,
      },
      minVersion: "TLSv1.2",
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        console.log(`Redis write response: ${res.statusCode} ${data}`);
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(data); }
      });
    });
    req.on("error", (err) => {
      console.log("Redis write error:", err.message);
      reject(err);
    });
    req.end();
  });
}

// ── Schema validator ──────────────────────────────────────────────────────────
function validateFleetPayload(payload) {
  const errors = [];
  if (!payload.schemaVersion) errors.push("missing schemaVersion");
  if (!payload.timestamp) errors.push("missing timestamp");
  if (!payload.sessionDate) errors.push("missing sessionDate");
  if (!Array.isArray(payload.bots)) errors.push("bots must be an array");
  else {
    payload.bots.forEach((bot, i) => {
      if (!bot.id) errors.push(`bots[${i}] missing id`);
      if (typeof bot.isTradingBlocked !== "boolean")
        errors.push(`bots[${i}] isTradingBlocked must be boolean`);
      if (typeof bot.dailyPnL !== "number")
        errors.push(`bots[${i}] dailyPnL must be number`);
      if (typeof bot.ddUsedPct !== "number")
        errors.push(`bots[${i}] ddUsedPct must be number`);
    });
  }
  return errors;
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {

  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", time: new Date().toISOString() }));
    return;
  }

  // Fleet state ingestion
  if (req.method === "POST" && req.url === "/ingest") {
    // Auth check
    const auth = req.headers["x-bridge-secret"];
    if (auth !== SECRET) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      console.log(`[${new Date().toISOString()}] Rejected - bad secret`);
      return;
    }

    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body);

        // Validate
        const errors = validateFleetPayload(payload);
        if (errors.length > 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Validation failed", errors }));
          console.log(`[${new Date().toISOString()}] Validation failed:`, errors);
          return;
        }

        // Write to Redis
        await writeToRedis("fleet:state", payload, FLEET_TTL);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ 
          success: true, 
          bots: payload.bots.length,
          timestamp: payload.timestamp 
        }));
        console.log(`[${new Date().toISOString()}] Fleet updated - ${payload.bots.length} bots`);

      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
        console.log(`[${new Date().toISOString()}] Error:`, err.message);
      }
    });
    return;
  }

  // 404 for everything else
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[${new Date().toISOString()}] Bridge server running on port ${PORT}`);
  console.log(`Upstash URL: ${UPSTASH_URL ? "configured" : "MISSING"}`);
  console.log(`Secret: ${SECRET !== "changeme" ? "configured" : "WARNING - using default secret"}`);
});