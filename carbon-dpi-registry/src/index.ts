import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import fs from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import pinoHttp from "pino-http";
import client from "prom-client";
import { gzipSync } from "node:zlib";
import { DeviceRegistration, VerifierRegistration } from "./types";

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
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Digest", "x-api-key", "x-tenant-id"],
  credentials: true,
}));
app.use(express.json({ limit: "512kb" }));

// Per-tenant rate limiting — each tenant gets its own 100 req/min quota
const tenantRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: "Too many requests — per-tenant quota exceeded" },
  keyGenerator: (req) => {
    const tenantId = req.headers["x-tenant-id"] as string | undefined;
    return tenantId?.trim() || req.ip || "unknown";
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(tenantRateLimiter);

const PORT = parseInt(process.env.PORT ?? "3003", 10);
const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

import { PrismaClient } from "@prisma/client-registry";

const prisma = new PrismaClient();

// ──────────────────────────────────────────────────────────────────────────────
// Middleware
// ──────────────────────────────────────────────────────────────────────────────

const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // Limit each IP to 100 requests per windowMs
  message: { error: "Too many requests, please try again later." }
});

app.use(limiter);

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
    title: "Carbon DPI Trust Registry API",
    version: "1.0.0",
    description: "Trust Registry service"
  },
  paths: {
    "/v1/registry/devices": {
      post: { summary: "Register device" },
      get: { summary: "Get all devices" }
    },
    "/v1/registry/devices/{cih}": {
      get: { summary: "Get device by CIH" }
    },
    "/v1/registry/verifiers": {
      post: { summary: "Register verifier" },
      get: { summary: "Get all verifiers" }
    },
    "/v1/registry/verifiers/{did}/revoke": {
      post: { summary: "Revoke verifier status" }
    },
    "/v1/status-list/verifiers": {
      get: { summary: "W3C Status List for verifiers" }
    },
    "/1.0/identifiers/{did}": {
      get: { summary: "W3C DID resolver endpoint" }
    },
    "/v1/lookup": {
      post: { summary: "Beckn subscriber lookup" }
    }
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
  <title>Carbon DPI Trust Registry Docs</title>
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

const ADMIN_API_KEY = process.env.REGISTRY_ADMIN_KEY || "dev-admin-key";

const requireAdminKey = (req: Request, res: Response, next: NextFunction) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== ADMIN_API_KEY) {
    res.status(401).json({ error: "Unauthorized. Invalid or missing x-api-key header." });
    return;
  }
  next();
};

// ──────────────────────────────────────────────────────────────────────────────
// Validation Schemas
// ──────────────────────────────────────────────────────────────────────────────

const DeviceRegistrationSchema = z.object({
  cihReference: z.string().length(64),
  sourceType: z.string().optional(),
  sourceId: z.string().min(1),
  publicKeyBase64: z.string().min(1),
  geolocation: z.object({
    lat: z.number(),
    lng: z.number(),
  }).optional(),
  status: z.string().optional(),
});

// ──────────────────────────────────────────────────────────────────────────────
// Infrastructure Endpoints
// ──────────────────────────────────────────────────────────────────────────────

const v1Router = express.Router();

v1Router.get("/heartbeat", async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: "UP", db: "CONNECTED", timestamp: new Date().toISOString() });
  } catch (error: any) {
    logger.error({ err: error }, "Database connection failed in heartbeat");
    res.status(500).json({ status: "DOWN", db: "DISCONNECTED", timestamp: new Date().toISOString() });
  }
});

v1Router.post("/registry/devices", requireAdminKey, async (req: Request, res: Response) => {
  try {
    const data = DeviceRegistrationSchema.parse(req.body);

    const device = await prisma.device.upsert({
      where: { cihReference: data.cihReference },
      update: {
        publicKeyBase64: data.publicKeyBase64,
        lat: data.geolocation?.lat ?? 0,
        lng: data.geolocation?.lng ?? 0,
        status: data.status ?? "ACTIVE",
      },
      create: {
        cihReference: data.cihReference,
        sourceType: data.sourceType ?? "IOT_SENSOR",
        sourceId: data.sourceId,
        publicKeyBase64: data.publicKeyBase64,
        lat: data.geolocation?.lat ?? 0,
        lng: data.geolocation?.lng ?? 0,
        status: data.status ?? "ACTIVE",
      }
    });

    res.status(201).json({ message: "Device registered successfully", device });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

v1Router.get("/registry/devices/:cih", async (req: Request, res: Response) => {
  try {
    const cih = req.params.cih as string;
    const device = await prisma.device.findUnique({
      where: { cihReference: cih }
    });

    if (!device) {
      res.status(404).json({ error: "Device not found" });
      return;
    }

    res.status(200).json(device);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

v1Router.get("/registry/devices", async (_req: Request, res: Response) => {
  try {
    const devices = await prisma.device.findMany();
    res.status(200).json(devices);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

v1Router.get("/registry/verifiers", async (_req: Request, res: Response) => {
  try {
    const verifiers = await prisma.verifier.findMany();
    res.status(200).json(verifiers);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

v1Router.post("/lookup", async (req: Request, res: Response) => {
  try {
    const { type, domain, subscriber_id } = req.body;
    let whereClause: any = { status: "SUBSCRIBED" };
    if (type) whereClause.type = type;
    if (subscriber_id) whereClause.subscriber_id = subscriber_id;

    const subscribers = await prisma.subscriber.findMany({ where: whereClause });
    res.status(200).json(subscribers.map((s: any) => ({
      subscriber_id: s.subscriber_id,
      subscriber_url: s.subscriber_url,
      type: s.type,
      signing_public_key: s.signing_public_key,
      valid_until: s.valid_until.toISOString(),
      status: s.status
    })));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// DID Resolver Endpoint (Layer 1)
// ──────────────────────────────────────────────────────────────────────────────

app.get("/1.0/identifiers/:did", async (req: Request, res: Response) => {
  try {
    const did = req.params.did as string;

    if (did.includes(":verifier:")) {
      const verifier = await prisma.verifier.findUnique({ where: { did } });
      if (!verifier) {
        res.status(404).json({ error: "DID not found" });
        return;
      }
      if (verifier.status === "REVOKED") {
        res.status(404).json({ error: "DID not found (Revoked)" });
        return;
      }
      res.status(200).json({
        "@context": ["https://www.w3.org/ns/did/v1"],
        id: did,
        verificationMethod: [],
        service: [{
          id: `${did}#beckn`,
          type: "BecknBPP",
          serviceEndpoint: verifier.url
        }]
      });
      return;
    }

    if (did.includes(":asset:")) {
      const cih = did.split(":asset:")[1];
      const device = await prisma.device.findFirst({ where: { cihReference: { startsWith: cih } } });
      if (!device) {
        res.status(404).json({ error: "DID not found" });
        return;
      }
      res.status(200).json({
        "@context": ["https://www.w3.org/ns/did/v1"],
        id: did,
        verificationMethod: [{
          id: `${did}#key-1`,
          type: "Ed25519VerificationKey2020",
          controller: did,
          publicKeyMultibase: device.publicKeyBase64
        }]
      });
      return;
    }

    res.status(400).json({ error: "Unsupported DID method" });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Methodology Registry Endpoints
// ──────────────────────────────────────────────────────────────────────────────

v1Router.get("/registry/methodologies", async (_req: Request, res: Response) => {
  try {
    const methDir = path.resolve(__dirname, "../../carbon-dpi-methodologies/methodologies");
    const files = await fs.readdir(methDir);
    const methodologies = [];
    for (const file of files) {
      if (file.endsWith(".json")) {
        const content = await fs.readFile(path.join(methDir, file), "utf-8");
        methodologies.push(JSON.parse(content));
      }
    }
    res.status(200).json(methodologies);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

v1Router.get("/registry/methodologies/:id", async (req: Request, res: Response) => {
  try {
    const methDir = path.resolve(__dirname, "../../carbon-dpi-methodologies/methodologies");
    const files = await fs.readdir(methDir);
    for (const file of files) {
      if (file.endsWith(".json")) {
        const content = await fs.readFile(path.join(methDir, file), "utf-8");
        const json = JSON.parse(content);
        if (json.id === req.params.id) {
          res.status(200).json(json);
          return;
        }
      }
    }
    res.status(404).json({ error: "Methodology not found" });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

v1Router.post("/registry/verifiers/:did/revoke", requireAdminKey, async (req: Request, res: Response) => {
  try {
    const did = req.params.did;
    const verifier = await prisma.verifier.findUnique({ where: { did } });
    if (!verifier) {
      res.status(404).json({ error: "Verifier not found" });
      return;
    }
    await prisma.verifier.update({
      where: { did },
      data: { status: "REVOKED" }
    });
    res.status(200).json({ status: "REVOKED", did });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

v1Router.get("/status-list/verifiers", async (req: Request, res: Response) => {
  try {
    const verifiers = await prisma.verifier.findMany({
      orderBy: { did: "asc" }
    });
    const listSize = Math.max(1, Math.ceil(verifiers.length / 8));
    const buffer = Buffer.alloc(listSize);
    verifiers.forEach((v: any, index: number) => {
      if (v.status === "REVOKED") {
        const byteIndex = Math.floor(index / 8);
        const bitIndex = index % 8;
        buffer[byteIndex] |= (1 << bitIndex);
      }
    });
    const compressed = gzipSync(buffer);
    const encodedList = compressed.toString("base64");
    
    res.status(200).json({
      "@context": [
        "https://www.w3.org/2018/credentials/v1",
        "https://w3id.org/vc/status-list/2021/v1"
      ],
      id: `http://localhost:${PORT}/v1/status-list/verifiers`,
      type: ["VerifiableCredential", "StatusList2021Credential"],
      issuer: "did:cdpi:india:registry",
      issuanceDate: new Date().toISOString(),
      credentialSubject: {
        id: `http://localhost:${PORT}/v1/status-list/verifiers#list`,
        type: "StatusList2021",
        statusPurpose: "revocation",
        encodedList
      }
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.use("/v1", v1Router);

app.get("/heartbeat", async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: "UP", db: "CONNECTED", timestamp: new Date().toISOString() });
  } catch (error: any) {
    logger.error({ err: error }, "Database connection failed in heartbeat");
    res.status(500).json({ status: "DOWN", db: "DISCONNECTED", timestamp: new Date().toISOString() });
  }
});

// Seed data function
async function seedDatabase() {
  await prisma.verifier.upsert({
    where: { did: "did:cdpi:india:verifier:greenpe" },
    update: {},
    create: {
      did: "did:cdpi:india:verifier:greenpe",
      name: "GreenPe Reference Verifier",
      accreditationBody: "CUPI-METH-001,CUPI-METH-002,CUPI-METH-003,CUPI-METH-004,CUPI-METH-005",
      status: "ACTIVE",
      url: process.env.REFERENCE_NODE_URL ?? "http://localhost:3001"
    }
  });

  await prisma.subscriber.upsert({
    where: { subscriber_id: "carbon-dpi.greenpe.in" },
    update: {},
    create: {
      subscriber_id: "carbon-dpi.greenpe.in",
      subscriber_url: process.env.REFERENCE_NODE_URL ?? "http://localhost:3001",
      type: "BPP",
      signing_public_key: process.env.BECKN_ED25519_PUBLIC_KEY ?? "dummy_pub_key",
      valid_until: new Date("2030-01-01T00:00:00Z"),
      status: "SUBSCRIBED"
    }
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Start
// ──────────────────────────────────────────────────────────────────────────────

export { app };

if (require.main === module) {
  seedDatabase().then(() => {
    app.listen(PORT, () => {
      logger.info(`🌍 Carbon DPI Trust Registry Service listening on port ${PORT}`);
    });
  }).catch(err => logger.error({ err }, "Startup failed"));
}
