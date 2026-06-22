import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import pino from "pino";
import pinoHttp from "pino-http";
import client from "prom-client";
import { signBecknRequest, verifyBecknSignature } from "@carbon-dpi/beckn-adapter";

dotenv.config();

const app = express();
const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS ? process.env.CORS_ALLOWED_ORIGINS.split(",") : ["http://localhost:3000", "http://localhost:3001"];
app.use(cors({
  origin: function(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
}));
app.use(express.json());

const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 200, // Limit each IP to 200 requests per windowMs
  message: { error: "Too many requests, please try again later." }
});

app.use(limiter);

const PORT = parseInt(process.env.PORT ?? "3005", 10);
const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";
const TRUST_REGISTRY_URL = process.env.TRUST_REGISTRY_URL ?? "http://localhost:3003";
const GATEWAY_SUBSCRIBER_ID = process.env.BECKN_GATEWAY_SUBSCRIBER_ID ?? "gateway.carbon-dpi.in";
const GATEWAY_KEY_ID = process.env.BECKN_GATEWAY_KEY_ID ?? "gateway-key-1";
const GATEWAY_PRIVATE_KEY = process.env.BECKN_GATEWAY_PRIVATE_KEY;

export const logger = pino({ level: LOG_LEVEL });
app.use(pinoHttp({ logger }));

// Prometheus Metrics setup
client.collectDefaultMetrics();

const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status"]
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
    title: "Carbon DPI Beckn Gateway API",
    version: "1.0.0",
    description: "Beckn Gateway service"
  },
  paths: {
    "/v1/search": { post: { summary: "Forward search request to verifiers" } },
    "/v1/select": { post: { summary: "Forward select request to verifiers" } },
    "/v1/init": { post: { summary: "Forward init request to verifiers" } },
    "/v1/confirm": { post: { summary: "Forward confirm request to verifiers" } },
    "/v1/cancel": { post: { summary: "Forward cancel request to verifiers" } },
    "/v1/gic/{id}": { get: { summary: "Get verified GIC" } }
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
  <title>Carbon DPI Gateway Docs</title>
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

let ACTIVE_BPPS: string[] = [
  process.env.REFERENCE_NODE_URL ?? "http://localhost:3099" // Fallback
];

// ──────────────────────────────────────────────────────────────────────────────
// Gateway Discovery Logic
// ──────────────────────────────────────────────────────────────────────────────

async function refreshActiveBPPs() {
  try {
    const res = await fetch(`${TRUST_REGISTRY_URL}/v1/lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "BPP" })
    });
    if (res.ok) {
      const subscribers = await res.json();
      ACTIVE_BPPS = subscribers
        .filter((s: any) => s.status === "SUBSCRIBED" && s.subscriber_url)
        .map((s: any) => s.subscriber_url);
      
      logger.debug(`Discovered ${ACTIVE_BPPS.length} active BPPs from Registry`);
    } else {
      logger.error(`Lookup failed with status ${res.status}`);
    }
  } catch (error: any) {
    logger.error({ err: error }, "Failed to discover BPPs from Trust Registry");
  }
}

// Initial fetch and periodic refresh
refreshActiveBPPs();
setInterval(refreshActiveBPPs, 60000); // refresh every minute

// ──────────────────────────────────────────────────────────────────────────────
// Gateway Multicast Logic
// ──────────────────────────────────────────────────────────────────────────────

async function multicastToBPPs(path: string, body: any, incomingHeaders: any) {
  const bodyStr = JSON.stringify(body);
  const promises = ACTIVE_BPPS.map(async (bppUrl) => {
    try {
      const reqHeaders: any = { "Content-Type": "application/json" };
      if (incomingHeaders["x-tenant-id"]) reqHeaders["x-tenant-id"] = incomingHeaders["x-tenant-id"];

      if (GATEWAY_PRIVATE_KEY) {
        const signed = signBecknRequest({
          subscriberId: GATEWAY_SUBSCRIBER_ID,
          uniqueKeyId: GATEWAY_KEY_ID,
          privateKeyBase64: GATEWAY_PRIVATE_KEY,
          body: bodyStr
        });
        reqHeaders["Authorization"] = signed.Authorization;
        reqHeaders["Digest"] = signed.Digest;
      } else {
        if (incomingHeaders["authorization"]) reqHeaders["Authorization"] = incomingHeaders["authorization"];
        if (incomingHeaders["digest"]) reqHeaders["Digest"] = incomingHeaders["digest"];
      }

      const res = await fetch(`${bppUrl}${path}`, {
        method: "POST",
        headers: reqHeaders,
        body: bodyStr,
      });
      if (!res.ok) {
        logger.error(`Error from BPP ${bppUrl}: ${res.status}`);
        return null;
      }
      return await res.json();
    } catch (e: any) {
      logger.error({ err: e }, `Failed to reach BPP ${bppUrl}`);
      return null;
    }
  });

  return Promise.all(promises);
}

// ──────────────────────────────────────────────────────────────────────────────
// API Endpoints
// ──────────────────────────────────────────────────────────────────────────────

app.get("/heartbeat", (_req: Request, res: Response) => {
  res.status(200).json({ status: "UP", gateway: "Carbon DPI Beckn Gateway" });
});

// BAP -> Gateway Endpoints
const becknActions = ["/search", "/select", "/init", "/confirm", "/cancel"];

const v1Router = express.Router();

const becknAuth = async (req: Request, res: Response, next: express.NextFunction) => {
  if (process.env.NODE_ENV === "test") {
    next();
    return;
  }
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

  const bapPublicKeyBase64 = process.env.BECKN_BAP_PUBLIC_KEY || "dummy"; 

  if (bapPublicKeyBase64 !== "dummy") {
    const rawBody = JSON.stringify(req.body);
    const verification = verifyBecknSignature({
      authorizationHeader: authHeader,
      digestHeader: digestHeader,
      body: rawBody,
      publicKeyBase64: bapPublicKeyBase64
    });
    
    if (!verification.valid) {
      res.status(401).json({ error: `Beckn Signature Invalid: ${verification.reason}` });
      return;
    }
  }

  next();
};

becknActions.forEach((action) => {
  v1Router.post(action, becknAuth, async (req: Request, res: Response) => {
    if (LOG_LEVEL === "debug") {
      logger.debug(`Forwarding ${action} to BPPs...`);
    }

    multicastToBPPs(`/v1${action}`, req.body, req.headers).catch(e => logger.error({ err: e }, "Multicast error"));

    res.status(200).json({ message: { ack: { status: "ACK" } } });
  });
});

// Public GIC Verification Proxy
v1Router.get("/gic/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const gicId = req.params.id;
    const format = req.query.format ?? "json";
    
    if (ACTIVE_BPPS.length === 0) {
      res.status(503).json({ error: "No active verifier nodes found" });
      return;
    }

    // Gateway tries BPPs until it finds the certificate
    for (const bppUrl of ACTIVE_BPPS) {
      try {
        const proxyRes = await fetch(`${bppUrl}/v1/gic/${gicId}?format=${format}`);
        if (proxyRes.ok) {
          const data = await proxyRes.json();
          res.status(200).json(data);
          return;
        }
      } catch (e) {
        logger.error({ err: e, bppUrl }, `Multicast failed to BPP`);
      }
    }

    res.status(404).json({ error: "GIC not found across active verifier nodes" });
  } catch (err: any) {
    next(err);
  }
});

app.use("/v1", v1Router);

app.get("/gic/:id", (req: Request, res: Response) => {
  res.redirect(`/v1/gic/${req.params.id}?format=${req.query.format ?? "json"}`);
});

// ──────────────────────────────────────────────────────────────────────────────
// Start
// ──────────────────────────────────────────────────────────────────────────────

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
    logger.info(`🛣️  Carbon DPI Beckn Gateway Service listening on port ${PORT}`);
  });
}
