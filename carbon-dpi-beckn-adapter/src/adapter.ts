/**
 * Carbon DPI — Beckn Protocol Adapter (Standalone)
 *
 * This is the standalone version of the Beckn adapter, extracted from
 * the GreenPe reference implementation for use as an independent service.
 *
 * Architecture:
 *   Carbon DPI Core API
 *         ↓
 *   Beckn Adapter Layer   ← THIS MODULE
 *         ↓
 *   ONCM / Energy Beckn / Climate Networks
 *
 * RULE: Wraps Carbon DPI v1 APIs as Beckn-compatible objects.
 */

import * as crypto from "node:crypto";
import { signBecknRequest } from "./signing";

// ──────────────────────────────────────────────────────────────
// Beckn Types (Energy Beckn / Climate domain)
// ──────────────────────────────────────────────────────────────

export interface BecknContext {
  domain: string;
  action: string;
  version: string;
  bap_id: string;
  bap_uri: string;
  bpp_id: string;
  bpp_uri: string;
  transaction_id: string;
  message_id: string;
  city: string;
  country: string;
  core_version: string;
  timestamp: string;
}

export interface BecknDescriptor {
  name: string;
  short_desc?: string;
  long_desc?: string;
  code?: string;
}

export interface BecknCatalogItem {
  id: string;
  descriptor: BecknDescriptor;
  category_id: string;
  price: { currency: string; value: string };
  tags?: Record<string, string>[];
  time?: { label: string; duration: string };
  matched?: boolean;
}

export interface BecknProvider {
  id: string;
  descriptor: BecknDescriptor;
  categories: { id: string; descriptor: BecknDescriptor }[];
  items: BecknCatalogItem[];
  tags?: Record<string, string>[];
}

export interface BecknCatalog {
  descriptor: BecknDescriptor;
  providers: BecknProvider[];
}

export interface BecknOrder {
  id: string;
  status: string;
  provider: { id: string };
  items: { id: string; quantity?: { count: number } }[];
  quote?: { price: { currency: string; value: string } };
  fulfillment?: BecknFulfillment;
  documents?: BecknDocument[];
  xinput?: Record<string, unknown>;
}

export interface BecknFulfillment {
  id: string;
  type: string;
  state: { descriptor: { code: string; name: string } };
  tags?: Record<string, string>[];
}

export interface BecknDocument {
  id: string;
  descriptor: { name: string; short_desc?: string };
  url: string;
  mime_type?: string;
}

export interface BecknSearchIntent {
  sector?: string;
  assetType?: string;
  methodologyId?: string;
}

// ──────────────────────────────────────────────────────────────
// Methodology type (from Carbon DPI Spec)
// ──────────────────────────────────────────────────────────────

export interface Methodology {
  id: string;
  name: string;
  sector: string;
  formula: string;
  outputUnit: string;
  impactType: "AVOIDED" | "REMOVED";
  sourceAuthority: string;
  applicableAssetTypes: string[];
  emissionFactors: {
    primary: number;
    primaryUnit: string;
  };
}

export interface GreenImpactCertificate {
  id: string;
  status: string;
  hash: string;
  cihReference?: string;
  methodologyId: string;
  methodologyTitle?: string;
  confidenceScore: number;
  impactValue: {
    amount: number;
    unit: string;
    type: string;
  };
}

// ──────────────────────────────────────────────────────────────
// Grid Emission Factors — CEA India v19.0
// ──────────────────────────────────────────────────────────────

export const CEA_GRID_EMISSION_FACTORS: Record<string, number> = {
  "India-National": 0.716,
  "India-North": 0.716,
  "India-South": 0.682,
  "India-East": 0.821,
  "India-West": 0.698,
  "India-Northeast": 0.642,
};

// ──────────────────────────────────────────────────────────────
// Provider Identity
// ──────────────────────────────────────────────────────────────

const BASE_URL = process.env.CARBON_UPI_BASE_URL ?? process.env.GIC_BASE_URL ?? "http://localhost:3001";

export const PROVIDER = {
  id: "carbon-dpi-bpp",
  domain: "deg:climate-verification",
  uri: `${BASE_URL}/api/beckn`,
  descriptor: {
    name: "Carbon DPI Verification Node",
    short_desc: "Identity-bound MRV + GIC issuance for India climate assets",
    long_desc: "Carbon DPI open protocol — deterministic MRV using CEA India emission factors, " +
      "issues Green Impact Certificates (GICs) as W3C Verifiable Credentials.",
    code: "CARBON-DPI-BPP-001",
  },
};

// ──────────────────────────────────────────────────────────────
// Core Functions
// ──────────────────────────────────────────────────────────────

export function stableStringify(obj: unknown): string {
  return JSON.stringify(obj, Object.keys(obj as Record<string, unknown>).sort());
}



export function buildBecknContext(input: {
  action: string;
  bapId: string;
  bapUri: string;
  bppId?: string;
  bppUri?: string;
  transactionId: string;
  messageId: string;
  domain?: string;
  city?: string;
  country?: string;
}): BecknContext {
  return {
    domain: input.domain ?? "deg:climate-verification",
    action: input.action,
    version: "1.1.0",
    bap_id: input.bapId,
    bap_uri: input.bapUri,
    bpp_id: input.bppId ?? PROVIDER.id,
    bpp_uri: input.bppUri ?? PROVIDER.uri,
    transaction_id: input.transactionId,
    message_id: input.messageId,
    city: input.city ?? "std:080",
    country: input.country ?? "IND",
    core_version: "1.1.0",
    timestamp: new Date().toISOString(),
  };
}



// ──────────────────────────────────────────────────────────────
// Catalog Builder
// ──────────────────────────────────────────────────────────────

function methodologyToBecknItem(m: Methodology): BecknCatalogItem {
  const gridEF = m.id.includes("SOLAR") || m.id.includes("WIND") || m.id.includes("EV")
    ? CEA_GRID_EMISSION_FACTORS["India-National"]
    : null;

  return {
    id: `carbon-dpi-${m.id.toLowerCase()}`,
    descriptor: {
      name: m.name,
      short_desc: m.formula,
      long_desc: `${m.name} — verified using ${m.sourceAuthority}. ` +
        `Primary EF: ${m.emissionFactors.primary} ${m.emissionFactors.primaryUnit}. ` +
        `Output: ${m.outputUnit}. Impact: ${m.impactType}.`,
      code: m.id,
    },
    category_id: `climate-${m.sector.toLowerCase()}`,
    price: { currency: "INR", value: "0.00" },
    tags: [
      { "carbon-dpi:methodology_id": m.id },
      { "carbon-dpi:sector": m.sector },
      { "carbon-dpi:authority": m.sourceAuthority },
      { "carbon-dpi:output_unit": m.outputUnit },
      { "carbon-dpi:impact_type": m.impactType },
      ...(gridEF ? [{ "carbon-dpi:grid_ef_kg_co2_kwh": gridEF.toString() }] : []),
      { "carbon-dpi:applicable_assets": m.applicableAssetTypes.join(",") },
    ],
    time: { label: "Verification SLA", duration: "PT5M" },
  };
}

export function buildBecknCatalog(
  methodologies: Methodology[],
  options?: { filterSector?: string; filterAssetType?: string }
): BecknCatalog {
  let filtered = methodologies;

  if (options?.filterSector) {
    filtered = filtered.filter(
      (m) => m.sector.toLowerCase() === options.filterSector!.toLowerCase()
    );
  }

  if (options?.filterAssetType) {
    filtered = filtered.filter(
      (m) => m.applicableAssetTypes.some(
        (t) => t.toLowerCase() === options.filterAssetType!.toLowerCase()
      )
    );
  }

  const sectors = [...new Set(filtered.map((m) => m.sector))];
  const categories = sectors.map((sector) => ({
    id: `climate-${sector.toLowerCase()}`,
    descriptor: {
      name: `${sector} Climate Verification`,
      short_desc: `Verified MRV and GIC issuance for ${sector.toLowerCase()} climate assets`,
    },
  }));

  return {
    descriptor: {
      name: "Carbon DPI Verification Catalog",
      short_desc: "Carbon DPI open protocol — deterministic MRV + GIC issuance",
      code: "CARBON-DPI-V1",
    },
    providers: [
      {
        ...PROVIDER,
        categories,
        items: filtered.map(methodologyToBecknItem),
        tags: [
          { "carbon-dpi:version": "1.0.0" },
          { "carbon-dpi:protocol": "Carbon DPI" },
          { "carbon-dpi:hash_algorithm": "SHA-256" },
          { "carbon-dpi:beckn_role": "BPP" },
          { "carbon-dpi:oncm_compatible": "true" },
        ],
      },
    ],
  };
}

// ──────────────────────────────────────────────────────────────
// GIC → Beckn Fulfillment
// ──────────────────────────────────────────────────────────────

export function gicToBecknFulfillment(gic: GreenImpactCertificate, orderId: string): BecknFulfillment {
  return {
    id: `fulfillment-${orderId}`,
    type: "CLIMATE_VERIFICATION",
    state: {
      descriptor: {
        code: gic.status === "VERIFIED" || gic.status === "ISSUED" ? "VERIFIED" : "FAILED",
        name: gic.status === "VERIFIED" || gic.status === "ISSUED"
          ? "GIC Issued — Verification Complete"
          : "Verification Failed",
      },
    },
    tags: [
      { "carbon-dpi:gic_id": gic.id },
      { "carbon-dpi:gic_hash": gic.hash },
      { "carbon-dpi:tco2e": gic.impactValue.amount.toString() },
      { "carbon-dpi:confidence_score": gic.confidenceScore.toString() },
      { "carbon-dpi:methodology_id": gic.methodologyId },
      { "carbon-dpi:verification_url": `${BASE_URL}/gic/${gic.id}` },
    ],
  };
}

export function gicToBecknDocument(gic: GreenImpactCertificate): BecknDocument {
  return {
    id: gic.id,
    descriptor: {
      name: "Green Impact Certificate (GIC)",
      short_desc: `${gic.impactValue.amount} ${gic.impactValue.unit} ${gic.impactValue.type}`,
    },
    url: `${BASE_URL}/gic/${gic.id}`,
    mime_type: "application/json",
  };
}

// ──────────────────────────────────────────────────────────────
// Search Intent Parser
// ──────────────────────────────────────────────────────────────

export function parseBecknSearchIntent(
  message: Record<string, unknown>
): BecknSearchIntent {
  const intent = (message?.intent ?? {}) as Record<string, unknown>;
  const category = (intent?.category ?? {}) as Record<string, unknown>;
  const item = (intent?.item ?? {}) as Record<string, unknown>;
  const descriptor = (item?.descriptor ?? {}) as Record<string, unknown>;
  const tags = (descriptor?.tags ?? []) as Record<string, string>[];

  const tagMap: Record<string, string> = {};
  tags.forEach((t) => Object.assign(tagMap, t));

  return {
    sector: (category as Record<string, Record<string, string>>)?.descriptor?.name?.split(" ")[0] ?? tagMap["carbon-dpi:sector"],
    assetType: tagMap["carbon-dpi:asset_type"],
    methodologyId: (descriptor?.code as string) ?? tagMap["carbon-dpi:methodology_id"],
  };
}

// ──────────────────────────────────────────────────────────────
// Order Builder
// ──────────────────────────────────────────────────────────────

export function buildBecknOrder(params: {
  orderId: string;
  status: string;
  methodologyId: string;
  gic?: GreenImpactCertificate;
}): BecknOrder {
  const order: BecknOrder = {
    id: params.orderId,
    status: params.status,
    provider: { id: PROVIDER.id },
    items: [{ id: `carbon-dpi-${params.methodologyId.toLowerCase()}` }],
    quote: { price: { currency: "INR", value: "0.00" } },
  };

  if (params.gic) {
    order.fulfillment = gicToBecknFulfillment(params.gic, params.orderId);
    order.documents = [gicToBecknDocument(params.gic)];
  }

  return order;
}

// ──────────────────────────────────────────────────────────────
// Transport — Dispatch callback to BAP (with retry)
// ──────────────────────────────────────────────────────────────

export async function dispatchBecknCallback(params: {
  action: string;
  context: BecknContext;
  callbackUrl?: string;
  message: Record<string, unknown>;
  privateKeyBase64: string;
  subscriberId: string;
  uniqueKeyId: string;
}): Promise<void> {
  const callbackContext: BecknContext = {
    ...params.context,
    action: params.action,
    message_id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  };

  const bodyObj = { context: callbackContext, message: params.message };
  const bodyStr = JSON.stringify(bodyObj);

  const signed = signBecknRequest({
    subscriberId: params.subscriberId,
    uniqueKeyId: params.uniqueKeyId,
    privateKeyBase64: params.privateKeyBase64,
    body: bodyStr
  });

  if (!params.callbackUrl) return;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(params.callbackUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": signed.Authorization,
          "Digest": signed.Digest
        },
        body: bodyStr,
      });
      if (response.ok) return;
    } catch {
      // Retry
    }
    await new Promise((r) => setTimeout(r, attempt * 200));
  }
}

export * from "./signing";
