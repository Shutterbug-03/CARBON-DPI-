import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import pino from "pino";
import pinoHttp from "pino-http";
import rateLimit from "express-rate-limit";
import { signBecknRequest, verifyBecknSignature } from "@carbon-dpi/beckn-adapter";
import client from "prom-client";
import { createServer } from "node:net";

dotenv.config();

const app = express();
const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(",").map(o => o.trim())
  : ["http://localhost:3000", "http://localhost:3001", "http://localhost:3004"];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: origin '${origin}' not allowed`));
    }
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Digest", "x-api-key", "x-tenant-id"],
  credentials: true,
}));
app.use(express.json({ limit: "512kb" }));

// Per-tenant rate limiting — each tenant gets its own 200 req/min quota
const tenantRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  message: { error: "Too many requests — per-tenant quota exceeded" },
  keyGenerator: (req) => {
    const tenantId = req.headers["x-tenant-id"] as string | undefined;
    return tenantId?.trim() || req.ip || "unknown";
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(tenantRateLimiter);

const LOG_LEVEL = process.env.LOG_LEVEL || "info";
export const logger = pino({ level: LOG_LEVEL });
app.use(pinoHttp({ logger }));

// Prometheus Metrics setup
client.collectDefaultMetrics();

const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status"]
});

export const mqttMessagesReceivedTotal = new client.Counter({
  name: "mqtt_messages_received_total",
  help: "Total number of MQTT messages received"
});

export const telemetryIngestedTotal = new client.Counter({
  name: "telemetry_ingested_total",
  help: "Total number of telemetry points ingested"
});

app.use((req, res, next) => {
  res.on("finish", () => {
    httpRequestsTotal.inc({
      method: req.method,
      route: req.route?.path || req.path,
      status: res.statusCode.toString()
    });
  });
  next();
});

app.get("/metrics", async (req, res) => {
  res.set("Content-Type", client.register.contentType);
  res.send(await client.register.metrics());
});

const openApiSpec = {
  openapi: "3.0.0",
  info: {
    title: "Carbon DPI Event Bus API",
    version: "1.0.0",
    description: "Event Bus service with embedded MQTT broker"
  },
  paths: {
    "/v1/ingest": { post: { summary: "Ingest telemetry via HTTP" } },
    "/v1/on_search": { post: { summary: "Receive on_search callback" } },
    "/v1/on_select": { post: { summary: "Receive on_select callback" } },
    "/v1/on_init": { post: { summary: "Receive on_init callback" } },
    "/v1/on_confirm": { post: { summary: "Receive on_confirm callback" } },
    "/v1/on_cancel": { post: { summary: "Receive on_cancel callback" } }
  }
};

app.get("/openapi.json", (req, res) => {
  res.json(openApiSpec);
});

app.get("/docs", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Carbon DPI Event Bus Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
  <style>html { box-sizing: border-box; overflow: -y-scroll; } *, *:before, *:after { box-sizing: inherit; } body { margin:0; background: #fafafa; }</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = () => {
      window.ui = SwaggerUIBundle({
        url: '/openapi.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        plugins: [SwaggerUIBundle.plugins.DownloadUrl],
        layout: "StandaloneLayout"
      });
    };
  </script>
</body>
</html>
  `);
});

const PORT = parseInt(process.env.PORT ?? "3004", 10);
let BECKN_GATEWAY_URL = process.env.BECKN_GATEWAY_URL ?? "http://localhost:3005/v1";
if (!BECKN_GATEWAY_URL.endsWith("/v1")) {
  BECKN_GATEWAY_URL = `${BECKN_GATEWAY_URL}/v1`;
}
let BAP_URI = process.env.BAP_URI ?? `http://localhost:${PORT}/v1`;
if (!BAP_URI.endsWith("/v1")) {
  BAP_URI = `${BAP_URI}/v1`;
}
const BATCH_INTERVAL_MS = parseInt(process.env.BATCH_INTERVAL_MS ?? "5000", 10);
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const SUBSCRIBER_ID = process.env.BECKN_SUBSCRIBER_ID ?? "carbon-dpi.greenpe.in";
const UNIQUE_KEY_ID = process.env.BECKN_UNIQUE_KEY_ID ?? "carbon-dpi-key-001";
const ED25519_PRIVATE_KEY = process.env.BECKN_ED25519_PRIVATE_KEY ?? undefined;

const redis = new Redis(REDIS_URL);
const REDIS_QUEUE_KEY = "carbon-dpi:telemetry-queue";

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

interface RawTelemetry {
  id: string;
  cihReference: string;
  sourceType: string;
  sourceId: string;
  timestamp: string;
  geolocation: { lat: number; lng: number };
  value: number;
  unit: string;
  deviceSignature: string;
  tenantId?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// API Endpoints
// ──────────────────────────────────────────────────────────────────────────────

const v1Router = express.Router();

v1Router.get("/heartbeat", async (_req: Request, res: Response) => {
  try {
    await redis.ping();
    const bufferSize = await redis.llen(REDIS_QUEUE_KEY);
    res.status(200).json({ status: "UP", redis: "CONNECTED", bufferSize, timestamp: new Date().toISOString() });
  } catch (error: any) {
    logger.error({ err: error }, "Redis connection failed in heartbeat");
    res.status(500).json({ status: "DOWN", redis: "DISCONNECTED", timestamp: new Date().toISOString() });
  }
});

v1Router.post("/ingest", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const apiKey = req.headers["x-api-key"];
    const validApiKey = process.env.EVENT_BUS_API_KEY || "default-ingest-key";
    if (process.env.NODE_ENV !== "test" && apiKey !== validApiKey) {
      res.status(401).json({ error: "Unauthorized. Invalid x-api-key" });
      return;
    }

    const payload = req.body;
    
    if (!payload.cihReference || !payload.value || !payload.timestamp) {
      res.status(400).json({ error: "Missing cihReference, value, or timestamp" });
      return;
    }

    const dataPoint: RawTelemetry = {
      id: payload.id || `dp-${randomUUID()}`,
      cihReference: payload.cihReference,
      sourceType: payload.sourceType || "IOT_SENSOR",
      sourceId: payload.sourceId || "UNKNOWN",
      timestamp: payload.timestamp,
      geolocation: payload.geolocation || { lat: 0, lng: 0 },
      value: parseFloat(payload.value),
      unit: payload.unit || "kWh",
      deviceSignature: payload.deviceSignature,
      tenantId: (req.headers["x-tenant-id"] as string) || payload.tenantId || "default",
    };

    // Security: Explicitly reject unsigned or placeholder signatures.
    // Passing "unsigned" through would cause a confusing error deep in the verification pipeline.
    if (!dataPoint.deviceSignature || dataPoint.deviceSignature === "unsigned" || dataPoint.deviceSignature === "MANUAL") {
      logger.warn({ id: dataPoint.id, sourceId: dataPoint.sourceId }, "Rejected telemetry: missing or placeholder deviceSignature");
      res.status(400).json({
        error: "Invalid deviceSignature",
        detail: "Telemetry must include a valid Ed25519 device signature. Use the Carbon DPI SDK's signTelemetry() function.",
        code: "UNSIGNED_TELEMETRY_REJECTED"
      });
      return;
    }

    // Idempotency Check: Prevent duplicate telemetry processing
    const idempotencyKey = `idemp:${dataPoint.deviceSignature}:${dataPoint.id}`;
    const isNew = await redis.setnx(idempotencyKey, "1");
    if (!isNew) {
      logger.warn(`Duplicate telemetry rejected: ${dataPoint.id}`);
      res.status(200).json({ 
        status: "ACK", 
        message: "Telemetry already buffered",
        id: dataPoint.id
      });
      return;
    }
    await redis.expire(idempotencyKey, 86400); // 24 hours

    // Stateless buffering using Redis
    await redis.lpush(REDIS_QUEUE_KEY, JSON.stringify(dataPoint));
    telemetryIngestedTotal.inc();
    
    res.status(202).json({ 
      status: "ACCEPTED", 
      message: "Telemetry buffered for processing",
      id: dataPoint.id
    });
  } catch (error: any) {
    next(error);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// State Management Helpers
// ──────────────────────────────────────────────────────────────────────────────

const getMethodology = (sourceType: string, unit: string) => {
  const st = sourceType.toUpperCase();
  const u = unit.toLowerCase();
  
  if (u === "kwh") {
    if (st === "SMART_METER" || st === "WIND_SENSOR" || st === "WIND_TURBINE") {
      return "CUPI-METH-005"; // Grid-Connected Wind
    }
    return "CUPI-METH-001"; // Grid-Connected Solar
  }
  if (u === "km" || u === "mi") {
    return "CUPI-METH-004"; // EV Fleet — Avoided Tailpipe Emissions
  }
  if (u === "m3" || u === "m³") {
    return "CUPI-METH-003"; // Biogas / Methane Capture
  }
  if (u === "tc" || u === "tc_per_ha") {
    return "CUPI-METH-002"; // Soil Carbon Sequestration
  }
  
  return "CUPI-METH-001"; // Default fallback
};

const sendToGateway = async (path: string, body: any, tenantId?: string) => {
  try {
    const bodyStr = JSON.stringify(body);
    let headers: any = { "Content-Type": "application/json" };
    
    if (tenantId) {
      headers["x-tenant-id"] = tenantId;
    }
    
    if (ED25519_PRIVATE_KEY) {
      const signed = signBecknRequest({
        subscriberId: SUBSCRIBER_ID,
        uniqueKeyId: UNIQUE_KEY_ID,
        privateKeyBase64: ED25519_PRIVATE_KEY,
        body: bodyStr
      });
      headers["Authorization"] = signed.Authorization;
      headers["Digest"] = signed.Digest;
    }

    const res = await fetch(`${BECKN_GATEWAY_URL}${path}`, {
      method: "POST",
      headers,
      body: bodyStr
    });
    const data = await res.json();
    return data.message?.ack?.status === "ACK";
  } catch (e) {
    console.error(`[EventBus] Error calling ${path} on Gateway:`, e);
    return false;
  }
};

// ──────────────────────────────────────────────────────────────────────────────
// Middleware for Beckn Signatures
// ──────────────────────────────────────────────────────────────────────────────

const becknAuth = async (req: Request, res: Response, next: express.NextFunction) => {
  const authHeader = req.headers["authorization"];
  const digestHeader = req.headers["digest"];
  
  if (!authHeader || typeof authHeader !== "string") {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }
  
  if (!digestHeader || typeof digestHeader !== "string") {
    res.status(401).json({ error: "Missing or invalid Digest header" });
    return;
  }

  // Dynamic key lookup: parse subscriber_id from Authorization header and fetch its
  // signing public key from the Trust Registry. Falls back to static env-var override.
  const keyIdMatch = authHeader.match(/keyId="([^|"]+)/);
  const subscriberId = keyIdMatch?.[1];
  const staticPublicKey = process.env.BECKN_BPP_PUBLIC_KEY;
  let resolvedPublicKey: string | null = staticPublicKey ?? null;

  if (!resolvedPublicKey && subscriberId) {
    try {
      const registryUrl = process.env.REGISTRY_URL ?? "http://localhost:3003";
      const lookupRes = await fetch(`${registryUrl}/v1/lookup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscriber_id: subscriberId })
      });
      if (lookupRes.ok) {
        const subscribers: any[] = await lookupRes.json();
        const match = subscribers.find((s: any) => s.subscriber_id === subscriberId && s.status === "SUBSCRIBED");
        if (match?.signing_public_key) resolvedPublicKey = match.signing_public_key;
      }
    } catch {
      logger.warn({ subscriberId }, "Trust Registry lookup failed during event bus becknAuth — verification skipped");
    }
  }

  if (resolvedPublicKey) {
    const rawBody = JSON.stringify(req.body);
    const verification = verifyBecknSignature({
      authorizationHeader: authHeader,
      digestHeader: digestHeader,
      body: rawBody,
      publicKeyBase64: resolvedPublicKey
    });
    
    if (!verification.valid) {
      res.status(401).json({ error: `Beckn Signature Invalid: ${verification.reason}` });
      return;
    }
  } else {
    logger.warn({ subscriberId }, "No public key resolved for event bus BPP — verification skipped (register subscriber or set BECKN_BPP_PUBLIC_KEY)");
  }

  next();
};

// ──────────────────────────────────────────────────────────────────────────────
// Beckn Callback Webhooks (from Reference Node)
// ──────────────────────────────────────────────────────────────────────────────

v1Router.post("/on_search", becknAuth, async (req: Request, res: Response) => {
  res.status(200).json({ message: { ack: { status: "ACK" } } });
  const { context, message } = req.body;
  const txId = context?.transaction_id;
  if (!txId) return;

  const stateStr = await redis.get(`tx:${txId}`);
  if (!stateStr) return;
  const state = JSON.parse(stateStr);

  const providerId = message?.catalog?.providers?.[0]?.id || "carbon-dpi-bpp";
  state.providerId = providerId;
  state.step = "select";
  await redis.set(`tx:${txId}`, JSON.stringify(state));

  // Build /select
  const newCtx = { ...context, action: "select", message_id: `msg-${randomUUID()}` };
  await sendToGateway("/select", {
    context: newCtx,
    message: {
      order: {
        items: [{ id: state.methodologyId }],
        xinput: { dataPoints: state.cdifPoints }
      }
    }
  }, state.tenantId);
});

v1Router.post("/on_select", becknAuth, async (req: Request, res: Response) => {
  res.status(200).json({ message: { ack: { status: "ACK" } } });
  const { context } = req.body;
  const txId = context?.transaction_id;
  if (!txId) return;

  const stateStr = await redis.get(`tx:${txId}`);
  if (!stateStr) return;
  const state = JSON.parse(stateStr);

  state.step = "init";
  await redis.set(`tx:${txId}`, JSON.stringify(state));

  const newCtx = { ...context, action: "init", message_id: `msg-${randomUUID()}` };
  await sendToGateway("/init", {
    context: newCtx,
    message: {
      order: {
        items: [{ id: state.methodologyId }],
        provider: { id: state.providerId }
      }
    }
  }, state.tenantId);
});

v1Router.post("/on_init", becknAuth, async (req: Request, res: Response) => {
  res.status(200).json({ message: { ack: { status: "ACK" } } });
  const { context } = req.body;
  const txId = context?.transaction_id;
  if (!txId) return;

  const stateStr = await redis.get(`tx:${txId}`);
  if (!stateStr) return;
  const state = JSON.parse(stateStr);

  state.step = "confirm";
  await redis.set(`tx:${txId}`, JSON.stringify(state));

  const newCtx = { ...context, action: "confirm", message_id: `msg-${randomUUID()}` };
  await sendToGateway("/confirm", {
    context: newCtx,
    message: {
      order: {
        items: [{ id: state.methodologyId }],
        provider: { id: state.providerId }
      }
    }
  }, state.tenantId);
});

v1Router.post("/on_cancel", becknAuth, (req: Request, res: Response) => res.status(200).json({ message: { ack: { status: "ACK" } } }));

v1Router.post("/on_confirm", becknAuth, async (req: Request, res: Response) => {
  const order = req.body.message?.order;
  if (order?.gic) {
    console.log("═══════════════════════════════════════════════════════════════");
    console.log(`[Webhook] ✅ Received Verified Certificate!`);
    console.log(`[Webhook]   Tx ID:   ${req.body.context?.transaction_id}`);
    console.log(`[Webhook]   GIC ID:  ${order.gic.id}`);
    console.log(`[Webhook]   Hash:    ${order.gic.hash}`);
    console.log(`[Webhook]   Impact:  ${order.gic.impactValue.amount} ${order.gic.impactValue.unit}`);
    console.log("═══════════════════════════════════════════════════════════════");
  }
  
  const txId = req.body.context?.transaction_id;
  if (txId) {
    await redis.del(`tx:${txId}`);
    await redis.zrem("carbon-dpi:tx-index", txId);
  }
  res.status(200).json({ message: { ack: { status: "ACK" } } });
});

app.use("/v1", v1Router);

app.get("/heartbeat", async (_req: Request, res: Response) => {
  try {
    await redis.ping();
    const bufferSize = await redis.llen(REDIS_QUEUE_KEY);
    res.status(200).json({ status: "UP", redis: "CONNECTED", bufferSize, timestamp: new Date().toISOString() });
  } catch (error: any) {
    logger.error({ err: error }, "Redis connection failed in heartbeat");
    res.status(500).json({ status: "DOWN", redis: "DISCONNECTED", timestamp: new Date().toISOString() });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Background Batch Processor & Beckn Orchestrator
// ──────────────────────────────────────────────────────────────────────────────

async function orchestrateBecknFlow(batch: RawTelemetry[]) {
  const txId = `tx-evbus-${randomUUID()}`;
  const timestamp = new Date().toISOString();

  const context = {
    domain: "deg:climate-verification",
    action: "search",
    version: "1.1.0",
    bap_id: "carbon-dpi-event-bus",
    bap_uri: BAP_URI,
    transaction_id: txId,
    message_id: `msg-${randomUUID()}`,
    city: "std:080",
    country: "IND",
    core_version: "1.1.0",
    timestamp
  };

  const cdifPoints = batch.map(p => ({
    ...p,
    reportingPeriod: { start: p.timestamp, end: p.timestamp },
    schemaVersion: "CDIF-1.0",
    trustScore: "HIGH"
  }));

  const methodologyId = getMethodology(batch[0].sourceType, batch[0].unit);
  const tenantId = batch[0]?.tenantId || "default";

  console.log(`[EventBus] Initiating Beckn flow for TX ${txId} using ${methodologyId} (${batch.length} points)`);

  await redis.set(`tx:${txId}`, JSON.stringify({
    step: "search",
    batch,
    cdifPoints,
    methodologyId,
    timestamp,
    tenantId
  }));
  await redis.zadd("carbon-dpi:tx-index", Date.now(), txId);

  const ok = await sendToGateway("/search", {
    context,
    message: { intent: { category: { descriptor: { name: "Energy" } } } }
  }, tenantId);
  
  if (!ok) {
    console.error(`[EventBus] /search failed for TX ${txId}`);
    await redis.del(`tx:${txId}`);
    await redis.zrem("carbon-dpi:tx-index", txId);
  }
}

setInterval(async () => {
  try {
    const queueLen = await redis.llen(REDIS_QUEUE_KEY);
    if (queueLen === 0) return;

    // Pull up to 100 items from Redis atomically
    const luaScript = `return redis.call('RPOP', KEYS[1], ARGV[1])`;
    let popped = await redis.eval(luaScript, 1, REDIS_QUEUE_KEY, "100") as any;
    if (!popped) popped = [];
    if (typeof popped === "string") popped = [popped];
    
    const allItems: RawTelemetry[] = popped.map((item: string) => JSON.parse(item));

    if (allItems.length === 0) return;

    // ── CRITICAL FIX: Group by (methodologyId + cihReference + tenantId) ──
    // This prevents mixing solar kWh data with EV km data or data from different
    // devices/tenants into a single Beckn verification transaction.
    const groups = new Map<string, RawTelemetry[]>();
    for (const item of allItems) {
      const methodologyId = getMethodology(item.sourceType, item.unit);
      const tenantId = item.tenantId || "default";
      const groupKey = `${methodologyId}::${item.cihReference ?? "unknown"}::${tenantId}`;
      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }
      groups.get(groupKey)!.push(item);
    }

    console.log(`[EventBus] Processing ${allItems.length} points across ${groups.size} isolated transaction group(s)...`);

    // Launch one Beckn transaction per group — fully isolated
    const groupPromises = Array.from(groups.entries()).map(async ([groupKey, batch]) => {
      console.log(`[EventBus] → Group "${groupKey}": ${batch.length} point(s)`);
      try {
        await orchestrateBecknFlow(batch);
      } catch (err) {
        console.error(`[EventBus] orchestrateBecknFlow failed for group "${groupKey}":`, err);
      }
    });

    await Promise.allSettled(groupPromises);
  } catch (err) {
    console.error("[EventBus] Redis polling error:", err);
  }
}, BATCH_INTERVAL_MS);

// DLQ Sweep Interval (Runs every 10 mins)
setInterval(async () => {
  try {
    const cutoff = Date.now() - 3600000; // 1 hour ago
    const staleTxs = await redis.zrangebyscore("carbon-dpi:tx-index", "-inf", cutoff);
    if (staleTxs.length > 0) {
      console.warn(`[EventBus] Found ${staleTxs.length} stale transactions. Moving to DLQ...`);
      for (const txId of staleTxs) {
        const stateStr = await redis.get(`tx:${txId}`);
        if (stateStr) {
          await redis.lpush("carbon-dpi:failed-transactions", stateStr);
        }
        await redis.del(`tx:${txId}`);
        await redis.zrem("carbon-dpi:tx-index", txId);
      }
    }
  } catch (err) {
    console.error("[EventBus] DLQ Sweep error:", err);
  }
}, 600000);

// ──────────────────────────────────────────────────────────────────────────────
// Start
// ──────────────────────────────────────────────────────────────────────────────

redis.on("connect", () => logger.info("[EventBus] 🔌 Connected to Redis"));

export const becknErrorHandler = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  logger.error({ err }, "Express route error occurred");
  const context = req.body?.context;
  if (context && typeof context === "object") {
    res.status(err.status || 500).json({
      context: {
        ...context,
        action: context.action ? `on_${context.action}` : undefined,
        timestamp: new Date().toISOString()
      },
      message: { ack: { status: "NACK" } },
      error: {
        type: err.type || "SYSTEM-ERROR",
        code: err.code || "50000",
        message: err.message || "Internal Server Error"
      }
    });
    return;
  }
  res.status(err.status || 500).json({
    error: err.message || "Internal Server Error"
  });
};

app.use(becknErrorHandler);

export { app };

if (require.main === module) {
  app.listen(PORT, () => {
    logger.info(`💨 Carbon DPI Event Bus Service listening on port ${PORT}`);
  });

  import("aedes").then(async (aedesModule: any) => {
    const AedesClass = aedesModule.Aedes || aedesModule.default;
    const aedesServer = await AedesClass.createBroker();
    const mqttServer = createServer(aedesServer.handle);

    aedesServer.on("publish", async (packet: any, clientSession: any) => {
      if (packet.topic === "carbon-dpi/telemetry") {
        try {
          const payloadStr = packet.payload.toString();
          const payload = JSON.parse(payloadStr);
          
          mqttMessagesReceivedTotal.inc();

          if (!payload.cihReference || !payload.value || !payload.timestamp) {
            logger.warn("MQTT telemetry ignored: Missing cihReference, value, or timestamp");
            return;
          }

          const dataPoint: RawTelemetry = {
            id: payload.id || `dp-${randomUUID()}`,
            cihReference: payload.cihReference,
            sourceType: payload.sourceType || "IOT_SENSOR",
            sourceId: payload.sourceId || "UNKNOWN",
            timestamp: payload.timestamp,
            geolocation: payload.geolocation || { lat: 0, lng: 0 },
            value: parseFloat(payload.value),
            unit: payload.unit || "kWh",
            deviceSignature: payload.deviceSignature || "unsigned",
            tenantId: payload.tenantId || "default",
          };

          // Idempotency check
          const idempotencyKey = `idemp:${dataPoint.deviceSignature}:${dataPoint.id}`;
          const isNew = await redis.setnx(idempotencyKey, "1");
          if (!isNew) {
            logger.warn(`Duplicate MQTT telemetry rejected: ${dataPoint.id}`);
            return;
          }
          await redis.expire(idempotencyKey, 86400);

          await redis.lpush(REDIS_QUEUE_KEY, JSON.stringify(dataPoint));
          telemetryIngestedTotal.inc();
          logger.info(`Buffered telemetry from MQTT: ${dataPoint.id}`);
        } catch (e: any) {
          logger.error(`Error processing MQTT packet: ${e.message}`);
        }
      }
    });

    mqttServer.listen(1883, () => {
      logger.info("📡 Embedded MQTT Broker listening on port 1883");
    });
  }).catch(err => {
    logger.error("Failed to load aedes MQTT broker: " + err.message);
  });
}
