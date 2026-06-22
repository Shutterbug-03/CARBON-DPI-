import express, { Request, Response, NextFunction } from "express";
import * as crypto from "node:crypto";
import { PrismaClient } from "@prisma/client-node";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import client from "prom-client";
import { gzipSync } from "node:zlib";
// Local bundled copies — no npm registry required for this standalone repo
import {
  METHODOLOGIES,
  updateMethodologies,
  validateCDIF,
  calculateMRV,
  generateGIC,
  toW3CVC,
  generateEvidencePackage
} from "./sdk";
import pino from "pino";
import pinoHttp from "pino-http";
import {
  buildBecknCatalog,
  buildBecknOrder,
  parseBecknSearchIntent,
  dispatchBecknCallback,
  BecknContext,
  verifyBecknSignature
} from "@carbon-dpi/beckn-adapter";

const prisma = new PrismaClient();

// ──────────────────────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT ?? "3001", 10);
const SUBSCRIBER_ID = process.env.BECKN_SUBSCRIBER_ID ?? "carbon-dpi.greenpe.in";
const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";
const ED25519_PRIVATE_KEY = process.env.BECKN_ED25519_PRIVATE_KEY ?? undefined;
const UNIQUE_KEY_ID = process.env.BECKN_UNIQUE_KEY_ID ?? "key-1";
const TRANSACTION_TTL_MS = parseInt(process.env.TRANSACTION_TTL_MS ?? "3600000", 10);  // 1 hour
const CLEANUP_INTERVAL_MS = parseInt(process.env.CLEANUP_INTERVAL_MS ?? "600000", 10); // 10 min
export const GIC_BASE_URL = process.env.GIC_BASE_URL ?? `http://localhost:${PORT}/v1`;

// ──────────────────────────────────────────────────────────────────────────────
// Middleware
// ──────────────────────────────────────────────────────────────────────────────

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: { error: "Too many requests" }
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

export const gicMintedTotal = new client.Counter({
  name: "gic_minted_total",
  help: "Total number of green impact certificates minted",
  labelNames: ["methodologyId", "tenantId"]
});

export const gicRevokedTotal = new client.Counter({
  name: "gic_revoked_total",
  help: "Total number of green impact certificates revoked",
  labelNames: ["tenantId"]
});

// Tenant ID middleware
app.use((req: any, res, next) => {
  req.tenantId = (req.headers["x-tenant-id"] as string) || "default";
  next();
});

// Prometheus HTTP request middleware
app.use((req: any, res, next) => {
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
    title: "Carbon DPI Reference Node API",
    version: "1.1.0",
    description: "Enterprise open protocol verifier node"
  },
  paths: {
    "/v1/search": { post: { summary: "Search verifier methodologies", responses: { 200: { description: "Beckn ACK" } } } },
    "/v1/select": { post: { summary: "Submit and validate telemetry", responses: { 200: { description: "Beckn ACK" } } } },
    "/v1/init": { post: { summary: "Initialize transaction", responses: { 200: { description: "Beckn ACK" } } } },
    "/v1/confirm": { post: { summary: "Confirm GIC issuance", responses: { 200: { description: "Beckn ACK" } } } },
    "/v1/cancel": { post: { summary: "Cancel transaction", responses: { 200: { description: "Beckn ACK" } } } },
    "/gic/{id}": { get: { summary: "Get public GIC", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "GIC details" } } } },
    "/v1/gic/{id}/revoke": { post: { summary: "Revoke GIC", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Revoked status" } } } },
    "/v1/status-list/certificates": { get: { summary: "W3C Status List for certificates", responses: { 200: { description: "Status List VC" } } } },
    "/v1/webhooks/subscribe": { post: { summary: "Subscribe to outbox webhooks", responses: { 200: { description: "Subscription response" } } } },
    "/v1/transaction/{id}": { get: { summary: "Get transaction audit details", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "Transaction details" } } } }
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
  <title>Carbon DPI Reference Node API Docs</title>
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

// Zod Schemas
const VerifyMRVSchema = z.object({
  cihReference: z.string().length(64),
  dataPointIds: z.array(z.string()),
  methodologyId: z.string(),
  timeWindow: z.object({
    start: z.string(),
    end: z.string()
  }).optional(),
  gridRegion: z.string().optional()
});

const GenerateGICSchema = z.object({
  mrvResultId: z.string()
});

// ──────────────────────────────────────────────────────────────────────────────
// Trust Registry Integration
// ──────────────────────────────────────────────────────────────────────────────

async function verifyDeviceRegistry(cih: string) {
  try {
    const registryUrl = process.env.REGISTRY_URL ?? "http://localhost:3003";
    const res = await fetch(`${registryUrl}/v1/registry/devices/${cih}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Middleware for Beckn Signatures
// ──────────────────────────────────────────────────────────────────────────────

const becknAuth = async (req: Request, res: Response, next: NextFunction) => {
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

  // Fetch the Gateway's public key (in a real system, you'd parse subscriber_id from auth header and lookup)
  // For simplicity, we use a single known public key or bypass if we don't know it, but here we'll mock Gateway key lookup.
  // Assuming the Gateway is registered in the Trust Registry... wait, the reference node is the BPP! BAP signed the request.
  // Carbon DPI Beckn Gateway is the BAP. We should have its public key.
  const bapPublicKeyBase64 = process.env.BECKN_BAP_PUBLIC_KEY || "dummy"; // Replace in prod

  if (bapPublicKeyBase64 !== "dummy") {
    const rawBody = JSON.stringify(req.body); // Ideally raw body string from express
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

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function ack(res: Response, context: BecknContext) {
  res.status(200).json({
    context: { ...context, action: `on_${context.action}`, timestamp: new Date().toISOString() },
    message: { ack: { status: "ACK" } }
  });
}

function nack(res: Response, context: BecknContext, error: string) {
  res.status(400).json({
    context: { ...context, action: `on_${context.action}`, timestamp: new Date().toISOString() },
    message: { ack: { status: "NACK" } },
    error: { type: "DOMAIN-ERROR", code: "40000", message: error }
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Infrastructure Endpoints
// ──────────────────────────────────────────────────────────────────────────────

/** GET /heartbeat — Beckn registry health check (must respond < 100ms) */
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

v1Router.get("/status", async (_req: Request, res: Response) => {
  const activeTransactions = await prisma.transaction.count();
  res.status(200).json({
    node: "Carbon DPI Reference Node",
    subscriber_id: SUBSCRIBER_ID,
    domain: "deg:climate-verification",
    activeTransactions,
    registeredMethodologies: METHODOLOGIES.map((m) => m.id),
    uptimeSeconds: process.uptime(),
    version: "1.1.0",
  });
});

v1Router.get("/transaction/:id", async (req: Request, res: Response) => {
  const tenantId = (req as any).tenantId;
  const tx = await prisma.transaction.findFirst({
    where: { transactionId: req.params.id, tenantId },
    include: { dataPoints: true, certificates: true, evidencePackages: true }
  });
  if (!tx) {
    res.status(404).json({ error: "Transaction not found" });
    return;
  }
  res.status(200).json(tx);
});

// ──────────────────────────────────────────────────────────────────────────────
// Discovery: /search
// ──────────────────────────────────────────────────────────────────────────────

/** POST /search */
v1Router.post("/search", becknAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { context, message } = req.body;
    if (!context?.transaction_id) {
      res.status(400).json({ error: "Missing context.transaction_id" });
      return;
    }

    const intent = parseBecknSearchIntent(message ?? {});
    const catalog = buildBecknCatalog(METHODOLOGIES, {
      filterSector: intent.sector,
      filterAssetType: intent.assetType,
    });

    const tenantId = (req as any).tenantId;
    const existingTx = await prisma.transaction.findUnique({
      where: { transactionId: context.transaction_id }
    });
    if (existingTx && existingTx.tenantId !== tenantId) {
      res.status(403).json({ error: "Access denied — Tenant mismatch" });
      return;
    }

    await prisma.transaction.upsert({
      where: { transactionId: context.transaction_id },
      update: { status: "SEARCH" },
      create: {
        transactionId: context.transaction_id,
        tenantId,
        bapUri: context.bap_uri ?? "",
        methodologyId: "",
        status: "SEARCH"
      }
    });

    if (context.bap_uri) {
      dispatchBecknCallback({
        action: "on_search",
        context,
        callbackUrl: `${context.bap_uri}/on_search`,
        message: { catalog },
        privateKeyBase64: ED25519_PRIVATE_KEY || "dummy", subscriberId: SUBSCRIBER_ID, uniqueKeyId: "key-1",
      }).catch((err) => console.error("[on_search dispatch error]", err));
    }

    ack(res, context);
  } catch (err: any) {
    next(err);
  }
});

/** POST /select */
v1Router.post("/select", becknAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { context, message } = req.body;
    const order = message?.order;
    if (!context?.transaction_id || !order) {
      nack(res, context ?? {}, "Missing context or order");
      return;
    }

    const selectedItem = order.items?.[0];
    const methodology = METHODOLOGIES.find(
      (m) =>
        m.id === selectedItem?.id ||
        `carbon-dpi-${m.id.toLowerCase()}` === selectedItem?.id
    );
    if (!methodology) {
      nack(res, context, `Methodology not found: ${selectedItem?.id}`);
      return;
    }

    const dataPoints = order.xinput?.dataPoints ?? [];
    const validation = validateCDIF(dataPoints);

    // Trust Registry Validation Check
    for (const point of validation.accepted) {
      const registryEntry = await verifyDeviceRegistry(point.cihReference);
      if (!registryEntry || registryEntry.status !== "ACTIVE") {
        nack(res, context, `Device ${point.cihReference} not registered or inactive in Trust Registry`);
        return;
      }
      
      const { verify, createPublicKey } = require('node:crypto');

      if (!point.deviceSignature) {
        nack(res, context, `Missing deviceSignature for ${point.id}`);
        return;
      }

      // Reconstruct the exact base payload that the device signed
      const basePayload = {
          id: point.id,
          cihReference: point.cihReference,
          sourceType: point.sourceType,
          sourceId: point.sourceId,
          timestamp: point.timestamp,
          geolocation: point.geolocation,
          value: point.value,
          unit: point.unit
      };
      
      const payloadStr = JSON.stringify(basePayload, Object.keys(basePayload).sort());
      const dataBuffer = Buffer.from(payloadStr);

      try {
        const pubKeyObj = createPublicKey({ 
            key: Buffer.from(registryEntry.publicKeyBase64, 'base64'), 
            format: 'der', 
            type: 'spki' 
        });

        const isValid = verify(null, dataBuffer, pubKeyObj, Buffer.from(point.deviceSignature, 'base64'));
        
        if (!isValid) {
            nack(res, context, `Cryptographic signature verification failed for ${point.id}`);
            return;
        }
      } catch (err) {
        nack(res, context, `Malformed signature or public key for ${point.id}`);
        return;
      }
    }

    const tenantId = (req as any).tenantId;
    const existingTx = await prisma.transaction.findUnique({
      where: { transactionId: context.transaction_id }
    });
    if (existingTx && existingTx.tenantId !== tenantId) {
      nack(res, context, "Access denied — Tenant mismatch");
      return;
    }

    await prisma.transaction.upsert({
      where: { transactionId: context.transaction_id },
      update: {
        bapUri: context.bap_uri ?? "",
        methodologyId: methodology.id,
        status: "SELECT"
      },
      create: {
        transactionId: context.transaction_id,
        tenantId,
        bapUri: context.bap_uri ?? "",
        methodologyId: methodology.id,
        status: "SELECT"
      }
    });

    // Save DataPoints
    for (const point of validation.accepted) {
      await prisma.dataPoint.upsert({
        where: { id: point.id },
        update: {},
        create: {
          id: point.id,
          transactionId: context.transaction_id,
          tenantId,
          cihReference: point.cihReference,
          sourceType: point.sourceType,
          sourceId: point.sourceId,
          timestamp: typeof point.timestamp === 'string' ? point.timestamp : (point.timestamp as Date).toISOString(),
          lat: point.geolocation.lat,
          lng: point.geolocation.lng,
          value: point.value,
          unit: point.unit,
          deviceSignature: point.deviceSignature
        }
      });
    }

    const responseOrder = {
      provider: { id: "carbon-dpi-bpp" },
      items: [selectedItem],
      quote: { price: { currency: "INR", value: "0.00" } },
      xinput: {
        validationSummary: validation.summary,
        rejectedPointsCount: validation.rejected.length,
        methodologySelected: methodology.id,
      },
    };

    if (context.bap_uri) {
      dispatchBecknCallback({
        action: "on_select",
        context,
        callbackUrl: `${context.bap_uri}/on_select`,
        message: { order: responseOrder },
        privateKeyBase64: ED25519_PRIVATE_KEY || "dummy", subscriberId: SUBSCRIBER_ID, uniqueKeyId: "key-1",
      }).catch((err) => console.error("[on_select dispatch error]", err));
    }

    ack(res, context);
  } catch (err: any) {
    next(err);
  }
});

/** POST /init */
v1Router.post("/init", becknAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { context, message } = req.body;
    const order = message?.order;
    if (!context?.transaction_id || !order) {
      nack(res, context ?? {}, "Missing context or order");
      return;
    }

    const tenantId = (req as any).tenantId;
    const tx = await prisma.transaction.findUnique({
      where: { transactionId: context.transaction_id }
    });

    if (!tx || !tx.methodologyId) {
      nack(res, context, "No active SELECT session. Call /select first.");
      return;
    }

    if (tx.tenantId !== tenantId) {
      nack(res, context, "Access denied — Tenant mismatch");
      return;
    }

    await prisma.transaction.update({
      where: { transactionId: context.transaction_id },
      data: { status: "INIT" }
    });

    const responseOrder = {
      provider: { id: "carbon-dpi-bpp" },
      items: order.items,
      quote: {
        price: { currency: "INR", value: "0.00" },
        breakup: [
          { title: "MRV Verification", price: { currency: "INR", value: "0.00" } },
          { title: "GIC Issuance", price: { currency: "INR", value: "0.00" } },
        ],
      },
      fulfillment: {
        id: `fulfillment-${context.transaction_id.slice(0, 8)}`,
        type: "CLIMATE_VERIFICATION",
        state: { descriptor: { code: "PENDING", name: "Awaiting Confirmation" } },
      },
    };

    if (context.bap_uri) {
      dispatchBecknCallback({
        action: "on_init",
        context,
        callbackUrl: `${context.bap_uri}/on_init`,
        message: { order: responseOrder },
        privateKeyBase64: ED25519_PRIVATE_KEY || "dummy", subscriberId: SUBSCRIBER_ID, uniqueKeyId: "key-1",
      }).catch((err) => console.error("[on_init dispatch error]", err));
    }

    ack(res, context);
  } catch (err: any) {
    next(err);
  }
});

/** POST /confirm — MRV calculation + GIC issuance + W3C VC */
v1Router.post("/confirm", becknAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { context, message } = req.body;
    const order = message?.order;
    if (!context?.transaction_id || !order) {
      nack(res, context ?? {}, "Missing context or order");
      return;
    }

    const tenantId = (req as any).tenantId;
    const tx = await prisma.transaction.findUnique({
      where: { transactionId: context.transaction_id },
      include: { dataPoints: true }
    });

    if (!tx || !tx.methodologyId || tx.dataPoints.length === 0) {
      nack(res, context, "No validated CDIF data. Call /select with dataPoints first.");
      return;
    }

    if (tx.tenantId !== tenantId) {
      nack(res, context, "Access denied — Tenant mismatch");
      return;
    }

    // Re-map DB points to CDIF format for MRV calculator
    const cdifPoints = tx.dataPoints.map((p: any) => ({
        id: p.id,
        cihReference: p.cihReference,
        sourceType: p.sourceType,
        sourceId: p.sourceId,
        timestamp: p.timestamp,
        geolocation: { lat: p.lat, lng: p.lng },
        value: p.value,
        unit: p.unit,
        deviceSignature: p.deviceSignature,
        trustScore: p.trustScore,
        reportingPeriod: { start: p.timestamp, end: p.timestamp },
        schemaVersion: "CDIF-1.0"
    }));

    // Run deterministic MRV engine
    const mrvResult = calculateMRV(tx.methodologyId, cdifPoints as any[], "India-National");
    if (!mrvResult.success) {
      nack(res, context, `MRV calculation failed: ${mrvResult.errors?.join(", ")}`);
      return;
    }

    const statusListIndex = await prisma.certificate.count();

    // Issue GIC + W3C VC (with real Ed25519 signature if key is configured)
    const cihRef = cdifPoints[0]?.cihReference ?? "UNKNOWN";
    const gic = generateGIC(mrvResult as any, cihRef, GIC_BASE_URL);
    const w3cVC = toW3CVC(gic, ED25519_PRIVATE_KEY, statusListIndex);

    // Generate and save Layer 4 Evidence Package
    const evidenceObj = generateEvidencePackage(
      context.transaction_id,
      cihRef,
      tx.methodologyId,
      cdifPoints,
      ED25519_PRIVATE_KEY
    );

    await prisma.evidencePackage.create({
      data: {
        evidenceId: evidenceObj.evidence_id,
        activityId: evidenceObj.activity_id,
        tenantId,
        ownerCih: evidenceObj.owner_cih,
        evidenceType: evidenceObj.evidence_type,
        rawDataHash: evidenceObj.raw_data_hash,
        dataPoints: evidenceObj.data_points,
        dataCompleteness: evidenceObj.data_completeness,
        evidenceSignature: evidenceObj.evidence_signature,
        sourceSystem: evidenceObj.source_system,
        collectionTimestamp: new Date(evidenceObj.collection_timestamp),
        schemaVersion: evidenceObj.schema_version
      }
    });

    await prisma.transaction.update({
      where: { transactionId: context.transaction_id },
      data: { status: "CONFIRMED" }
    });

    // Store full GIC + W3C VC for public verification
    await prisma.certificate.create({
      data: {
        gicHash: gic.hash,
        gicId: gic.id,
        transactionId: context.transaction_id,
        tenantId,
        methodologyId: gic.methodologyId,
        cihReference: gic.cihReference,
        totalCO2e: gic.impactValue.amount,
        confidenceScore: gic.confidenceScore,
        impactType: gic.impactValue.type,
        unit: gic.impactValue.unit,
        proofValue: (w3cVC as any).proof?.proofValue ?? "",
        w3cVcJson: JSON.stringify(w3cVC),
        status: "ISSUED"
      }
    });

    await prisma.outboxEvent.create({
      data: {
        eventType: "GIC_MINTED",
        payload: JSON.stringify({
          gicId: gic.id,
          totalCO2e: gic.impactValue.amount,
          unit: gic.impactValue.unit,
          cihReference: gic.cihReference,
          tenantId,
          timestamp: new Date().toISOString()
        })
      }
    });

    gicMintedTotal.inc({ methodologyId: gic.methodologyId, tenantId });

    const responseOrder = buildBecknOrder({
      orderId: `order-${context.transaction_id.slice(0, 8)}`,
      status: "COMPLETE",
      methodologyId: tx.methodologyId,
      gic: {
        id: gic.id,
        status: gic.status,
        hash: gic.hash,
        cihReference: gic.cihReference,
        methodologyId: gic.methodologyId,
        confidenceScore: gic.confidenceScore,
        impactValue: gic.impactValue,
      },
    });
    (responseOrder as any).xinput = { w3c_verifiable_credential: w3cVC };

    if (context.bap_uri) {
      dispatchBecknCallback({
        action: "on_confirm",
        context,
        callbackUrl: `${context.bap_uri}/on_confirm`,
        message: { order: responseOrder },
        privateKeyBase64: ED25519_PRIVATE_KEY || "dummy", subscriberId: SUBSCRIBER_ID, uniqueKeyId: "key-1",
      }).catch((err) => console.error("[on_confirm dispatch error]", err));
    }

    ack(res, context);
  } catch (err: any) {
    next(err);
  }
});

/** POST /cancel */
v1Router.post("/cancel", becknAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { context } = req.body;
    if (!context?.transaction_id) {
      res.status(400).json({ error: "Missing context.transaction_id" });
      return;
    }
    
    const tenantId = (req as any).tenantId;
    const tx = await prisma.transaction.findUnique({
      where: { transactionId: context.transaction_id }
    });

    if (!tx) {
      nack(res, context, "Transaction not found");
      return;
    }
    if (tx.tenantId !== tenantId) {
      nack(res, context, "Access denied — Tenant mismatch");
      return;
    }
    if (tx.status === "CONFIRMED") {
      nack(res, context, "Cannot cancel — GIC already issued");
      return;
    }

    await prisma.transaction.update({
      where: { transactionId: context.transaction_id },
      data: { status: "CANCELLED" }
    });

    if (context.bap_uri) {
      dispatchBecknCallback({
        action: "on_cancel",
        context,
        callbackUrl: `${context.bap_uri}/on_cancel`,
        message: { order: { id: context.transaction_id, status: "CANCELLED" } },
        privateKeyBase64: ED25519_PRIVATE_KEY || "dummy", subscriberId: SUBSCRIBER_ID, uniqueKeyId: "key-1",
      }).catch((err) => console.error("[on_cancel dispatch error]", err));
    }

    ack(res, context);
  } catch (err: any) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Public GIC Verification Endpoint
// ──────────────────────────────────────────────────────────────────────────────

/** GET /gic/:id — Public, unauthenticated GIC verification */
v1Router.get("/gic/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const gicId = req.params.id;
    const cert = await prisma.certificate.findUnique({
      where: { gicId },
    });

    if (!cert) {
      res.status(404).json({
        verified: false,
        error: "GIC not found",
        gicId,
      });
      return;
    }

    // Attempt to parse stored W3C VC
    let w3cVC: Record<string, unknown> | null = null;
    try {
      if (cert.w3cVcJson) {
        w3cVC = JSON.parse(cert.w3cVcJson);
      }
    } catch {
      // Stored VC JSON is malformed — still return the certificate data
    }

    // Verify the Ed25519 proof if public key is available
    let signatureVerified = false;
    const publicKeyBase64 = process.env.BECKN_ED25519_PUBLIC_KEY;
    if (publicKeyBase64 && w3cVC && (w3cVC as any).proof?.proofValue) {
      try {
        const proofValue = (w3cVC as any).proof.proofValue;
        // Reconstruct the credential without the proof for verification
        const { proof, ...credentialWithoutProof } = w3cVC as any;
        const canonicalized = JSON.stringify(credentialWithoutProof, Object.keys(credentialWithoutProof).sort());
        const publicKeyDer = Buffer.from(publicKeyBase64, "base64");
        const publicKey = crypto.createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
        signatureVerified = crypto.verify(
          null,
          Buffer.from(canonicalized),
          publicKey,
          Buffer.from(proofValue, "base64")
        );
      } catch {
        signatureVerified = false;
      }
    }

    const format = req.query.format ?? "json";

    if (format === "w3c_vc" && w3cVC) {
      res.status(200).json(w3cVC);
      return;
    }

    res.status(200).json({
      verified: cert.status !== "REVOKED",
      signatureVerified,
      gicId: cert.gicId,
      gicHash: cert.gicHash,
      status: cert.status,
      revocationReason: cert.revocationReason || undefined,
      methodologyId: cert.methodologyId,
      cihReference: cert.cihReference,
      verifiedImpact: {
        tCO2e: cert.totalCO2e,
        unit: cert.unit,
        type: cert.impactType,
        confidenceScore: cert.confidenceScore,
      },
      issueDate: cert.issueDate.toISOString(),
      publiclyVerifiable: true,
      w3cVC: format === "json" ? w3cVC : undefined,
    });
  } catch (err: any) {
    next(err);
  }
});

/** POST /v1/gic/:id/revoke — Admin only */
v1Router.post("/gic/:id/revoke", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const adminKey = process.env.REGISTRY_ADMIN_KEY ?? "deep_test_admin_key";
    if (req.headers["x-api-key"] !== adminKey) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const gicId = req.params.id;
    const { reason } = req.body;

    const cert = await prisma.certificate.findUnique({
      where: { gicId }
    });

    if (!cert) {
      res.status(404).json({ error: "Certificate not found" });
      return;
    }

    if (cert.status === "REVOKED") {
      res.status(400).json({ error: "Certificate is already revoked" });
      return;
    }

    await prisma.certificate.update({
      where: { gicId },
      data: {
        status: "REVOKED",
        revocationReason: reason ?? "No reason provided"
      }
    });

    // Record outbox event
    await prisma.outboxEvent.create({
      data: {
        eventType: "GIC_REVOKED",
        payload: JSON.stringify({
          gicId,
          reason: reason ?? "No reason provided",
          tenantId: cert.tenantId,
          timestamp: new Date().toISOString()
        })
      }
    });

    gicRevokedTotal.inc({ tenantId: cert.tenantId });

    res.status(200).json({ status: "REVOKED", gicId, reason });
  } catch (err: any) {
    next(err);
  }
});

/** GET /v1/status-list/certificates */
v1Router.get("/status-list/certificates", async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Fetch all certificates ordered deterministically to build the bitstring
    const certificates = await prisma.certificate.findMany({
      orderBy: [
        { issueDate: "asc" },
        { gicId: "asc" }
      ]
    });

    const listSize = Math.max(1, Math.ceil(certificates.length / 8));
    const buffer = Buffer.alloc(listSize);

    certificates.forEach((cert: any, index: number) => {
      if (cert.status === "REVOKED") {
        const byteIndex = Math.floor(index / 8);
        const bitIndex = index % 8;
        buffer[byteIndex] |= (1 << bitIndex);
      }
    });

    const compressed = gzipSync(buffer);
    const encodedList = compressed.toString("base64");

    const statusListVC = {
      "@context": [
        "https://www.w3.org/2018/credentials/v1",
        "https://w3id.org/vc/status-list/2021/v1"
      ],
      id: `${GIC_BASE_URL}/status-list/certificates`,
      type: ["VerifiableCredential", "StatusList2021Credential"],
      issuer: "did:cupi:india:verifier:greenpe",
      issuanceDate: new Date().toISOString(),
      credentialSubject: {
        id: `${GIC_BASE_URL}/status-list/certificates#list`,
        type: "StatusList2021",
        statusPurpose: "revocation",
        encodedList
      }
    };

    res.status(200).json(statusListVC);
  } catch (err: any) {
    next(err);
  }
});

/** POST /v1/webhooks/subscribe */
v1Router.post("/webhooks/subscribe", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const adminKey = process.env.REGISTRY_ADMIN_KEY ?? "deep_test_admin_key";
    if (req.headers["x-api-key"] !== adminKey) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { url, events } = req.body;
    if (!url || !events || !Array.isArray(events)) {
      res.status(400).json({ error: "Missing url or events array" });
      return;
    }

    const secret = crypto.randomBytes(16).toString("hex");

    const sub = await prisma.webhookSubscription.upsert({
      where: { url },
      update: {
        events: events.join(","),
        secret
      },
      create: {
        url,
        events: events.join(","),
        secret
      }
    });

    res.status(200).json({
      subscriptionId: sub.id,
      secret: sub.secret,
      url: sub.url,
      events: events
    });
  } catch (err: any) {
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Beckn Callback Receivers  (BAP endpoints — for integration testing)
// ──────────────────────────────────────────────────────────────────────────────

v1Router.post("/on_search", (req: Request, res: Response) => {
  if (LOG_LEVEL === "debug") console.log("[on_search received]", JSON.stringify(req.body, null, 2));
  res.status(200).json({ message: { ack: { status: "ACK" } } });
});

v1Router.post("/on_select", (req: Request, res: Response) => {
  if (LOG_LEVEL === "debug") console.log("[on_select received]", JSON.stringify(req.body, null, 2));
  res.status(200).json({ message: { ack: { status: "ACK" } } });
});

v1Router.post("/on_init", (req: Request, res: Response) => {
  if (LOG_LEVEL === "debug") console.log("[on_init received]", JSON.stringify(req.body, null, 2));
  res.status(200).json({ message: { ack: { status: "ACK" } } });
});

v1Router.post("/on_confirm", (req: Request, res: Response) => {
  if (LOG_LEVEL === "debug") console.log("[on_confirm received]", JSON.stringify(req.body, null, 2));
  res.status(200).json({ message: { ack: { status: "ACK" } } });
});

v1Router.post("/on_cancel", (req: Request, res: Response) => {
  res.status(200).json({ message: { ack: { status: "ACK" } } });
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

app.get("/status", async (req: Request, res: Response) => {
  const activeTransactions = await prisma.transaction.count();
  res.status(200).json({
    node: "Carbon DPI Reference Node",
    subscriber_id: SUBSCRIBER_ID,
    domain: "deg:climate-verification",
    activeTransactions,
    registeredMethodologies: METHODOLOGIES.map((m) => m.id),
    uptimeSeconds: process.uptime(),
    version: "1.1.0",
  });
});

app.get("/gic/:id", (req: Request, res: Response) => {
  res.redirect(`/v1/gic/${req.params.id}?format=${req.query.format ?? "json"}`);
});

// ──────────────────────────────────────────────────────────────────────────────
// Transaction TTL Cleanup
// ──────────────────────────────────────────────────────────────────────────────

setInterval(async () => {
  try {
    const cutoff = new Date(Date.now() - TRANSACTION_TTL_MS);
    const deleted = await prisma.transaction.deleteMany({
      where: {
        status: { notIn: ["CONFIRMED", "CANCELLED"] },
        createdAt: { lt: cutoff },
      },
    });
    if (deleted.count > 0) {
      logger.info(`[Cleanup] Purged ${deleted.count} stale transaction(s) older than ${TRANSACTION_TTL_MS / 60000}min`);
    }
  } catch (err) {
    logger.error({ err }, "[Cleanup] Error purging stale transactions");
  }
}, CLEANUP_INTERVAL_MS);

// ──────────────────────────────────────────────────────────────────────────────
// Start
// ──────────────────────────────────────────────────────────────────────────────

async function loadMethodologiesFromRegistry() {
  try {
    const registryUrl = process.env.REGISTRY_URL ?? "http://localhost:3003";
    const res = await fetch(`${registryUrl}/v1/registry/methodologies`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) {
        const mappedData = data.map((item: any) => {
          if (item.id && item.emissionFactors) {
            return item;
          }
          
          const id = item.id || item.methodology_id || item.methodologyId || "UNKNOWN";
          const baselineFormula = item.baseline_formula || {};
          const variables = baselineFormula.variables || {};
          
          let primaryVal = 1.0;
          let primaryUnit = "unit";
          if (id.includes("001") || id.includes("solar")) {
            primaryVal = 0.716;
            primaryUnit = "kgCO2_per_kWh";
          } else if (id.includes("002") || id.includes("soil")) {
            primaryVal = 3.67;
            primaryUnit = "tCO2_per_tC";
          } else if (id.includes("003") || id.includes("biogas")) {
            primaryVal = 27.9;
            primaryUnit = "CO2e_per_tCH4";
          } else if (id.includes("004") || id.includes("ev")) {
            primaryVal = 0.192;
            primaryUnit = "kgCO2_per_km_petrol";
          } else if (id.includes("005") || id.includes("wind")) {
            primaryVal = 0.716;
            primaryUnit = "kgCO2_per_kWh";
          }

          const primaryValFromJSON = variables.grid_ef?.values?.["India-National"] || 
                                     variables.primary_factor?.values?.["India-National"] || 
                                     variables.ch4_gwp?.values?.["India-National"];
          
          return {
            id,
            name: item.name || "Unnamed Methodology",
            version: item.version || "1.0.0",
            sector: item.sector || "Energy",
            formula: item.formula || baselineFormula.final_formula || "tCO2e = value * EF",
            sourceAuthority: item.sourceAuthority || item.external_reference?.standard || "Carbon DPI",
            applicableAssetTypes: item.applicableAssetTypes || item.applicable_activity_types || ["FACILITY"],
            emissionFactors: item.emissionFactors || {
              primary: primaryValFromJSON || primaryVal,
              primaryUnit: variables.grid_ef?.unit || variables.ch4_gwp?.unit || primaryUnit
            },
            impactType: item.impactType || item.impact_type || "AVOIDED",
            outputUnit: item.outputUnit || item.output_unit || "tCO2e"
          };
        });
        updateMethodologies(mappedData);
        logger.info(`Loaded ${mappedData.length} methodologies from Registry`);
      } else {
        logger.warn("Registry returned invalid methodology format, using hardcoded default");
      }
    } else {
      logger.warn(`Failed to fetch methodologies from Registry, status ${res.status}. Using hardcoded default.`);
    }
  } catch (err: any) {
    logger.warn(`Failed to fetch methodologies from Registry: ${err.message}. Using hardcoded default.`);
  }
}

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

async function processOutboxEvents() {
  try {
    const events = await prisma.outboxEvent.findMany({
      where: {
        status: "PENDING",
        nextAttemptAt: { lte: new Date() }
      },
      take: 10
    });

    for (const event of events) {
      try {
        const subscriptions = await prisma.webhookSubscription.findMany();
        const matchingSubs = subscriptions.filter((sub: any) => 
          sub.events.split(",").includes(event.eventType)
        );

        let allSucceeded = true;
        for (const sub of matchingSubs) {
          try {
            const hmac = crypto.createHmac("sha256", sub.secret);
            hmac.update(event.payload);
            const signature = hmac.digest("hex");

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000);

            let res;
            try {
              res = await fetch(sub.url, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "x-hub-signature-256": `sha256=${signature}`,
                  "x-tenant-id": JSON.parse(event.payload).tenantId || "default"
                },
                body: event.payload,
                signal: controller.signal
              });
            } finally {
              clearTimeout(timeoutId);
            }

            if (!res.ok) {
              allSucceeded = false;
              logger.error(`Webhook target ${sub.url} returned status ${res.status}`);
            }
          } catch (e: any) {
            allSucceeded = false;
            if (e.name === 'AbortError') {
              logger.error(`Webhook timeout (3s) for ${sub.url}`);
            } else {
              logger.error(`Failed to call webhook target ${sub.url}: ${e.message}`);
            }
          }
        }

        if (allSucceeded) {
          await prisma.outboxEvent.update({
            where: { id: event.id },
            data: { status: "COMPLETED" }
          });
        } else {
          const nextRetry = event.retryCount + 1;
          const status = nextRetry >= 5 ? "FAILED" : "PENDING";
          const delaySec = 30 * nextRetry;
          await prisma.outboxEvent.update({
            where: { id: event.id },
            data: {
              status,
              retryCount: nextRetry,
              nextAttemptAt: new Date(Date.now() + delaySec * 1000)
            }
          });
        }
      } catch (err: any) {
        logger.error(`Error processing outbox event ${event.id}: ${err.message}`);
      }
    }
  } catch (err: any) {
    logger.error(`Outbox processor error: ${err.message}`);
  }
}

export { app };

if (require.main === module) {
  app.listen(PORT, async () => {
    logger.info(`🌍 Carbon DPI Reference Verification Node listening on port ${PORT}`);
    await loadMethodologiesFromRegistry();
    // Start outbox dispatcher
    setInterval(processOutboxEvents, 5000);
  });
}
