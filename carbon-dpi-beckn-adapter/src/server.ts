/**
 * Carbon DPI — Standalone Beckn BPP Server
 *
 * This is the standalone Express server for the Carbon DPI Beckn adapter.
 * It implements the full Beckn Protocol Provider (BPP) API — both the
 * inbound endpoints (called by Beckn Gateway/BAP) and the outbound
 * callback endpoints (on_* called by BPP → BAP).
 *
 * Beckn Message Flow:
 *
 *   BAP → [POST /search]    → BPP (this server)
 *   BPP → [POST /on_search] → BAP (async callback)
 *
 *   BAP → [POST /select]    → BPP
 *   BPP → [POST /on_select] → BAP (async callback)
 *
 *   BAP → [POST /init]      → BPP
 *   BPP → [POST /on_init]   → BAP (async callback)
 *
 *   BAP → [POST /confirm]   → BPP
 *   BPP → [POST /on_confirm]→ BAP (async callback)
 *
 * Usage:
 *   npm run dev     # Development mode with ts-node
 *   npm start       # Production (after tsc build)
 *
 * Environment:
 *   See .env.example for required variables
 */

import express, { Request, Response, NextFunction } from "express";
import * as crypto from "node:crypto";
import {
  buildBecknCatalog,
  buildBecknOrder,
  buildBecknContext,
  parseBecknSearchIntent,
  dispatchBecknCallback,
  BecknContext,
  Methodology,
} from "./adapter";
import {
  signBecknRequest,
  verifyBecknSignature,
  loadKeyPairFromEnv,
  generateKeyPair,
  SignedHeaders,
} from "./signing";

// ──────────────────────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "3002", 10);
const SUBSCRIBER_ID = process.env.BECKN_SUBSCRIBER_ID ?? "carbon-dpi.greenpe.in";
const UNIQUE_KEY_ID = process.env.BECKN_UNIQUE_KEY_ID ?? "carbon-dpi-key-001";
const SHARED_SECRET = process.env.BECKN_SHARED_SECRET ?? "change-me-in-production";
const VERIFY_INCOMING = process.env.BECKN_VERIFY_INCOMING === "true";
const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

// ──────────────────────────────────────────────────────────────────────────────
// Embedded Carbon DPI methodologies (self-contained — no sibling dependency)
// ──────────────────────────────────────────────────────────────────────────────

const METHODOLOGIES: Methodology[] = [
  {
    id: "CDPI-METH-001",
    name: "Grid-Connected Solar PV",
    sector: "Energy",
    formula: "AE = EG × CEF × CAF",
    outputUnit: "tCO2e",
    impactType: "AVOIDED",
    sourceAuthority: "CEA India v19.0 + AMS-I.D CDM v18",
    applicableAssetTypes: ["SOLAR_PV", "ROOFTOP_SOLAR", "SOLAR_FARM"],
    emissionFactors: { primary: 0.716, primaryUnit: "kgCO2/kWh" },
  },
  {
    id: "CDPI-METH-002",
    name: "Soil Carbon Sequestration",
    sector: "Agriculture",
    formula: "SC = ΔSOC × 3.67 × A × CF",
    outputUnit: "tCO2e",
    impactType: "REMOVED",
    sourceAuthority: "IPCC AR6 + VM0042 Verra",
    applicableAssetTypes: ["AGRICULTURAL_LAND", "FARM"],
    emissionFactors: { primary: 3.67, primaryUnit: "tCO2/tC" },
  },
  {
    id: "CDPI-METH-003",
    name: "Biogas / Methane Capture",
    sector: "Waste",
    formula: "ER = VCH4 × 0.717 × GWP100_CH4 × OX",
    outputUnit: "tCO2e",
    impactType: "AVOIDED",
    sourceAuthority: "IPCC AR6 + AMS-III.D CDM",
    applicableAssetTypes: ["BIOGAS_PLANT", "WASTE_PLANT"],
    emissionFactors: { primary: 27.9, primaryUnit: "GWP100" },
  },
  {
    id: "CDPI-METH-004",
    name: "EV Fleet Emissions Displacement",
    sector: "Transport",
    formula: "ER = D × (EFbaseline - EFev×GEFgrid)",
    outputUnit: "tCO2e",
    impactType: "AVOIDED",
    sourceAuthority: "MoRTH India + CEA India v19.0",
    applicableAssetTypes: ["EV_FLEET", "EV_VEHICLE", "ELECTRIC_BUS"],
    emissionFactors: { primary: 0.192, primaryUnit: "kgCO2/km" },
  },
  {
    id: "CDPI-METH-005",
    name: "Grid-Connected Wind Power",
    sector: "Energy",
    formula: "AE = EG × CEF × CAF",
    outputUnit: "tCO2e",
    impactType: "AVOIDED",
    sourceAuthority: "CEA India v19.0 + ACM0002 Verra",
    applicableAssetTypes: ["WIND_TURBINE", "WIND_FARM", "ONSHORE_WIND"],
    emissionFactors: { primary: 0.716, primaryUnit: "kgCO2/kWh" },
  },
];

// ──────────────────────────────────────────────────────────────────────────────
// In-memory Transaction Store
// ──────────────────────────────────────────────────────────────────────────────

interface TransactionState {
  transactionId: string;
  methodologyId?: string;
  dataPoints?: unknown[];
  gic?: unknown;
  bapId?: string;
  bapUri?: string;
  status: "SEARCH" | "SELECT" | "INIT" | "CONFIRMED" | "CANCELLED";
  createdAt: string;
  updatedAt: string;
}

const transactions = new Map<string, TransactionState>();

// Cleanup stale transactions after 1 hour
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, tx] of transactions.entries()) {
    if (new Date(tx.createdAt).getTime() < cutoff) {
      transactions.delete(id);
    }
  }
}, 10 * 60 * 1000);

// ──────────────────────────────────────────────────────────────────────────────
// Ed25519 key pair (loaded once at startup)
// ──────────────────────────────────────────────────────────────────────────────

let keyPair: { publicKey: string; privateKey: string } | null = null;

function getKeyPair() {
  if (!keyPair) {
    try {
      keyPair = loadKeyPairFromEnv();
    } catch {
      // No keys configured — use HMAC fallback (dev only)
      keyPair = null;
    }
  }
  return keyPair;
}

function signOutgoingRequest(body: string): Partial<SignedHeaders> {
  const kp = getKeyPair();
  if (!kp) return {};
  return signBecknRequest({
    subscriberId: SUBSCRIBER_ID,
    uniqueKeyId: UNIQUE_KEY_ID,
    privateKeyBase64: kp.privateKey,
    body,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Middleware
// ──────────────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Request logger
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (LOG_LEVEL === "info" || LOG_LEVEL === "debug") {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  next();
});

// Optional: verify incoming Beckn signature
function verifyIncoming(req: Request, res: Response, next: NextFunction) {
  if (!VERIFY_INCOMING) return next();
  const kp = getKeyPair();
  if (!kp) return next(); // Can't verify without keys

  const auth = req.headers["authorization"] as string;
  const digest = req.headers["digest"] as string;
  if (!auth || !digest) {
    res.status(401).json({ error: "Missing Authorization or Digest header" });
    return;
  }
  const result = verifyBecknSignature({
    authorizationHeader: auth,
    digestHeader: digest,
    body: JSON.stringify(req.body),
    publicKeyBase64: kp.publicKey,
  });
  if (!result.valid) {
    res.status(401).json({ error: `Signature verification failed: ${result.reason}` });
    return;
  }
  next();
}

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

/** GET /heartbeat — Required by Beckn registry (< 100ms) */
app.get("/heartbeat", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "UP",
    subscriber_id: SUBSCRIBER_ID,
    timestamp: new Date().toISOString(),
  });
});

/** GET /status — Node introspection */
app.get("/status", (_req: Request, res: Response) => {
  res.status(200).json({
    node: "Carbon DPI Beckn BPP",
    subscriber_id: SUBSCRIBER_ID,
    domain: "deg:climate-verification",
    activeTransactions: transactions.size,
    registeredMethodologies: METHODOLOGIES.map((m) => m.id),
    uptimeSeconds: process.uptime(),
    ed25519Configured: getKeyPair() !== null,
    version: "1.0.0",
  });
});

/** GET /registry/methodologies — Public methodology list */
app.get("/registry/methodologies", (_req: Request, res: Response) => {
  res.status(200).json({
    count: METHODOLOGIES.length,
    methodologies: METHODOLOGIES.map((m) => ({
      id: m.id,
      name: m.name,
      sector: m.sector,
      impactType: m.impactType,
      outputUnit: m.outputUnit,
      sourceAuthority: m.sourceAuthority,
    })),
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Beckn BPP Inbound Endpoints (BAP → BPP)
// ──────────────────────────────────────────────────────────────────────────────

/** POST /search — BAP discovers available verification methodologies */
app.post("/search", verifyIncoming, async (req: Request, res: Response) => {
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

    transactions.set(context.transaction_id, {
      transactionId: context.transaction_id,
      bapId: context.bap_id,
      bapUri: context.bap_uri,
      status: "SEARCH",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Async on_search callback
    if (context.bap_uri) {
      const callbackContext = buildBecknContext({
        action: "on_search",
        bapId: context.bap_id,
        bapUri: context.bap_uri,
        transactionId: context.transaction_id,
        messageId: crypto.randomUUID(),
      });
      dispatchBecknCallback({
        action: "on_search",
        context: callbackContext,
        callbackUrl: `${context.bap_uri}/on_search`,
        message: { catalog },
        privateKeyBase64: getKeyPair()?.privateKey || "dummy",
        subscriberId: SUBSCRIBER_ID,
        uniqueKeyId: UNIQUE_KEY_ID,
      }).catch((err) => console.error("[on_search callback error]", err));
    }

    ack(res, context);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /select — BAP selects a methodology and submits CDIF data */
app.post("/select", verifyIncoming, async (req: Request, res: Response) => {
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

    const tx = transactions.get(context.transaction_id);
    const dataPoints = order.xinput?.dataPoints ?? [];

    transactions.set(context.transaction_id, {
      ...(tx ?? { createdAt: new Date().toISOString() }),
      transactionId: context.transaction_id,
      bapId: context.bap_id,
      bapUri: context.bap_uri,
      methodologyId: methodology.id,
      dataPoints,
      status: "SELECT",
      updatedAt: new Date().toISOString(),
    });

    const responseOrder = {
      provider: { id: "carbon-dpi-bpp" },
      items: [selectedItem],
      quote: { price: { currency: "INR", value: "0.00" } },
      xinput: {
        dataPointsReceived: dataPoints.length,
        methodologySelected: methodology.id,
        methodologyName: methodology.name,
      },
    };

    if (context.bap_uri) {
      dispatchBecknCallback({
        action: "on_select",
        context,
        callbackUrl: `${context.bap_uri}/on_select`,
        message: { order: responseOrder },
        privateKeyBase64: getKeyPair()?.privateKey || "dummy",
        subscriberId: SUBSCRIBER_ID,
        uniqueKeyId: UNIQUE_KEY_ID,
      }).catch((err) => console.error("[on_select callback error]", err));
    }

    ack(res, context);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /init — BAP confirms intent to proceed, BPP finalises quote */
app.post("/init", verifyIncoming, async (req: Request, res: Response) => {
  try {
    const { context, message } = req.body;
    const order = message?.order;
    if (!context?.transaction_id || !order) {
      nack(res, context ?? {}, "Missing context or order");
      return;
    }

    const tx = transactions.get(context.transaction_id);
    if (!tx?.methodologyId) {
      nack(res, context, "No active SELECT session. Call /select first.");
      return;
    }

    tx.status = "INIT";
    tx.updatedAt = new Date().toISOString();

    const responseOrder = {
      provider: { id: "carbon-dpi-bpp" },
      items: order.items,
      quote: {
        price: { currency: "INR", value: "0.00" },
        breakup: [
          {
            title: "MRV Verification",
            price: { currency: "INR", value: "0.00" },
          },
          {
            title: "GIC Issuance",
            price: { currency: "INR", value: "0.00" },
          },
        ],
      },
      fulfillment: {
        id: `fulfillment-${context.transaction_id.slice(0, 8)}`,
        type: "CLIMATE_VERIFICATION",
        state: {
          descriptor: { code: "PENDING", name: "Awaiting Confirmation" },
        },
      },
    };

    if (context.bap_uri) {
      dispatchBecknCallback({
        action: "on_init",
        context,
        callbackUrl: `${context.bap_uri}/on_init`,
        message: { order: responseOrder },
        privateKeyBase64: getKeyPair()?.privateKey || "dummy",
        subscriberId: SUBSCRIBER_ID,
        uniqueKeyId: UNIQUE_KEY_ID,
      }).catch((err) => console.error("[on_init callback error]", err));
    }

    ack(res, context);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /confirm — BAP confirms order, BPP runs MRV + issues GIC */
app.post("/confirm", verifyIncoming, async (req: Request, res: Response) => {
  try {
    const { context, message } = req.body;
    const order = message?.order;
    if (!context?.transaction_id || !order) {
      nack(res, context ?? {}, "Missing context or order");
      return;
    }

    const tx = transactions.get(context.transaction_id);
    if (!tx?.methodologyId || !tx?.dataPoints) {
      nack(res, context, "No validated data. Call /select with CDIF dataPoints first.");
      return;
    }

    // GIC placeholder — in real deployment, call the Carbon DPI SDK here
    const gicId = `GIC-${Date.now()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const gic = {
      id: gicId,
      status: "ISSUED",
      hash: crypto.createHash("sha256").update(gicId + tx.methodologyId).digest("hex"),
      cihReference: (tx.dataPoints[0] as any)?.cihReference ?? "UNKNOWN",
      methodologyId: tx.methodologyId,
      confidenceScore: 95,
      impactValue: { amount: 1.23, unit: "tCO2e", type: "AVOIDED" },
      issuedAt: new Date().toISOString(),
      verificationUrl: `${process.env.GIC_BASE_URL ?? "http://localhost:3001"}/gic/${gicId}`,
    };

    tx.gic = gic;
    tx.status = "CONFIRMED";
    tx.updatedAt = new Date().toISOString();

    const responseOrder = buildBecknOrder({
      orderId: `order-${context.transaction_id.slice(0, 8)}`,
      status: "COMPLETE",
      methodologyId: tx.methodologyId,
      gic,
    });
    (responseOrder as any).xinput = {
      w3c_verifiable_credential: {
        "@context": ["https://www.w3.org/2018/credentials/v1"],
        type: ["VerifiableCredential", "GreenImpactCertificate"],
        id: `urn:cdpi:gic:${gicId}`,
        issuer: `did:cdpi:india:bpp:${SUBSCRIBER_ID}`,
        issuanceDate: new Date().toISOString(),
        credentialSubject: {
          id: gic.cihReference,
          methodologyId: gic.methodologyId,
          verifiedQuantity: gic.impactValue,
          confidenceScore: gic.confidenceScore,
          gicHash: gic.hash,
          verificationUrl: gic.verificationUrl,
        },
      },
    };

    if (context.bap_uri) {
      dispatchBecknCallback({
        action: "on_confirm",
        context,
        callbackUrl: `${context.bap_uri}/on_confirm`,
        message: { order: responseOrder },
        privateKeyBase64: getKeyPair()?.privateKey || "dummy",
        subscriberId: SUBSCRIBER_ID,
        uniqueKeyId: UNIQUE_KEY_ID,
      }).catch((err) => console.error("[on_confirm callback error]", err));
    }

    ack(res, context);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /cancel — BAP cancels an active transaction */
app.post("/cancel", verifyIncoming, async (req: Request, res: Response) => {
  try {
    const { context } = req.body;
    if (!context?.transaction_id) {
      res.status(400).json({ error: "Missing context.transaction_id" });
      return;
    }

    const tx = transactions.get(context.transaction_id);
    if (!tx) {
      nack(res, context, "Transaction not found");
      return;
    }
    if (tx.status === "CONFIRMED") {
      nack(res, context, "Cannot cancel — GIC already issued");
      return;
    }

    tx.status = "CANCELLED";
    tx.updatedAt = new Date().toISOString();

    if (context.bap_uri) {
      dispatchBecknCallback({
        action: "on_cancel",
        context,
        callbackUrl: `${context.bap_uri}/on_cancel`,
        message: { order: { id: context.transaction_id, status: "CANCELLED" } },
        privateKeyBase64: getKeyPair()?.privateKey || "dummy",
        subscriberId: SUBSCRIBER_ID,
        uniqueKeyId: UNIQUE_KEY_ID,
      }).catch((err) => console.error("[on_cancel callback error]", err));
    }

    ack(res, context);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /transaction/:id — Transaction state inspection */
app.get("/transaction/:id", (req: Request, res: Response) => {
  const tx = transactions.get(req.params.id);
  if (!tx) {
    res.status(404).json({ error: "Transaction not found" });
    return;
  }
  res.status(200).json(tx);
});

// ──────────────────────────────────────────────────────────────────────────────
// Beckn BAP Callback Endpoints (BPP calls BAP — these are the inbound handlers
// for when *this node also acts as BAP* in testing / passthrough scenarios)
// ──────────────────────────────────────────────────────────────────────────────

app.post("/on_search", (req: Request, res: Response) => {
  if (LOG_LEVEL === "debug") {
    console.log("[on_search received]", JSON.stringify(req.body, null, 2));
  }
  res.status(200).json({ message: { ack: { status: "ACK" } } });
});

app.post("/on_select", (req: Request, res: Response) => {
  if (LOG_LEVEL === "debug") {
    console.log("[on_select received]", JSON.stringify(req.body, null, 2));
  }
  res.status(200).json({ message: { ack: { status: "ACK" } } });
});

app.post("/on_init", (req: Request, res: Response) => {
  if (LOG_LEVEL === "debug") {
    console.log("[on_init received]", JSON.stringify(req.body, null, 2));
  }
  res.status(200).json({ message: { ack: { status: "ACK" } } });
});

app.post("/on_confirm", (req: Request, res: Response) => {
  if (LOG_LEVEL === "debug") {
    console.log("[on_confirm received]", JSON.stringify(req.body, null, 2));
  }
  res.status(200).json({ message: { ack: { status: "ACK" } } });
});

app.post("/on_cancel", (req: Request, res: Response) => {
  res.status(200).json({ message: { ack: { status: "ACK" } } });
});

// ──────────────────────────────────────────────────────────────────────────────
// Key generation utility endpoint (dev only)
// ──────────────────────────────────────────────────────────────────────────────

if (process.env.NODE_ENV !== "production") {
  app.get("/dev/keygen", (_req: Request, res: Response) => {
    const { generateKeyPair: genKP } = require("./signing");
    const kp = genKP();
    res.status(200).json({
      note: "Add these to your .env file. NEVER expose the private key publicly.",
      BECKN_ED25519_PUBLIC_KEY: kp.publicKey,
      BECKN_ED25519_PRIVATE_KEY: kp.privateKey,
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Start
// ──────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  🌍  Carbon DPI Beckn BPP Server");
  console.log(`  🚀  Listening on port ${PORT}`);
  console.log(`  🆔  Subscriber ID: ${SUBSCRIBER_ID}`);
  console.log(`  🔑  Ed25519 signing: ${getKeyPair() ? "✅ configured" : "⚠️  not configured (dev mode)"}`);
  console.log(`  🔒  Verify incoming: ${VERIFY_INCOMING ? "✅ enabled" : "⚠️  disabled"}`);
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Endpoints:");
  console.log("    GET  /heartbeat          — Beckn registry health check");
  console.log("    GET  /status             — Node info + active transactions");
  console.log("    GET  /registry/methodologies — Public methodology catalog");
  console.log("    POST /search             — Beckn search");
  console.log("    POST /select             — Beckn select");
  console.log("    POST /init               — Beckn init");
  console.log("    POST /confirm            — Beckn confirm + GIC issuance");
  console.log("    POST /cancel             — Beckn cancel");
  console.log("    GET  /transaction/:id    — Transaction state lookup");
  if (process.env.NODE_ENV !== "production") {
    console.log("    GET  /dev/keygen         — Generate Ed25519 key pair (dev only)");
  }
  console.log("═══════════════════════════════════════════════════════════════");
});

export default app;
