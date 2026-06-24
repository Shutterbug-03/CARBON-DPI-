# Carbon DPI — Third Autopsy Report
**Date**: 2026-06-25 | **Scope**: ALL repos, line-by-line, post P0/P1/P2 fixes

> This is the definitive autopsy. The first two passes caught the ghost server, signature bypasses, hardcoded values, and missing P2 infrastructure. **This pass goes after everything still hiding — the subtle architecture problems that will break you when a real user clones the repo.**

---

## 🧬 Autopsy Grade: STABLE but NOT Open Protocol-Ready

The protocol is **cryptographically sound** now. The MRV math is correct. The W3C VC structure is right. The Beckn flow works. **But an outsider cloning this repo hits 9 silent failure modes before they see their first GIC.** This is the checklist to fix that.

---

## 🔴 CRITICAL — Still Hiding (New Findings)

---

### FINDING #1 — CIH Is Non-Deterministic by Design
**File**: [`carbon-dpi-sdk-js/src/index.ts:67`](file:///Users/dharanshsingh/CARBON%20DPI/carbon-dpi-sdk-js/src/index.ts), [`carbon-dpi-reference-solar/src/demo.ts:70`](file:///Users/dharanshsingh/CARBON%20DPI/carbon-dpi-reference-solar/src/demo.ts), [`carbon-dpi-reference-ev/src/demo.ts:67`](file:///Users/dharanshsingh/CARBON%20DPI/carbon-dpi-reference-ev/src/demo.ts), [`carbon-dpi-reference-msme/src/demo.ts:67`](file:///Users/dharanshsingh/CARBON%20DPI/carbon-dpi-reference-msme/src/demo.ts)

**Root Cause**: All 3 reference simulators compute the CIH using `new Date().toISOString()` as the `timestamp` field:
```ts
// ALL THREE REFERENCE DEMOS
const cih = computeCIH({
    identityHash: "...",
    assetId: "...",
    deviceId: DEVICE_DID,
    lat: ...,
    lng: ...,
    timestamp: new Date().toISOString()  // ← NEW TIMESTAMP EVERY BOOT
});
```
The CIH is then registered in the Trust Registry and used as the key for device signature lookup. **On every restart, a new CIH is generated** — which means:
1. The device registers a new CIH every time it boots
2. Telemetry signed with the old key is orphaned (device not found)
3. The device accumulates CIH registrations in the registry indefinitely
4. The connection between `identityHash` (GSTIN/PAN) and the device is broken on every restart

**Why it matters for an open protocol**: A real hardware device has a fixed identity. The CIH is supposed to be a permanent cryptographic anchor. If someone installs this and restarts their solar inverter client, all their previous telemetry is orphaned.

**Fix required**: CIH timestamp should be the device's commission date (fixed), not the boot time. Store it on first run.

---

### FINDING #2 — SDK Signing Protocol Mismatch with Registry Verifier
**File**: [`carbon-dpi-sdk-js/src/index.ts:76-78`](file:///Users/dharanshsingh/CARBON%20DPI/carbon-dpi-sdk-js/src/index.ts), [`carbon-dpi-reference-node/src/index.ts:468`](file:///Users/dharanshsingh/CARBON%20DPI/carbon-dpi-reference-node/src/index.ts)

**SDK signs**:
```ts
// SDK: signTelemetry — sorts top-level keys only (shallow sort)
const payloadStr = JSON.stringify(payload, Object.keys(payload).sort());
```

**Reference Node verifies**:
```ts
// Node: reconstructs base payload with sorted keys for verification
const basePayload = { id, cihReference, sourceType, sourceId, timestamp, geolocation, value, unit };
const payloadStr = JSON.stringify(basePayload, Object.keys(basePayload).sort());
```

**The Mismatch**: `geolocation` is a nested object `{lat, lng}`. `JSON.stringify` with a key-sort replacer only sorts **top-level keys**. The inner `{lat, lng}` key order inside `geolocation` is **not guaranteed** across JS engines/environments. On Node.js v24, V8 preserves insertion order, but the SDK constructs `geolocation` as `{ lat, lng }` while the verifier reconstructs it from the incoming payload's property order.

**In practice**: This works today because both sides use Node.js and V8 produces consistent output. But the Python SDK ([`carbon-dpi-sdk-python`](file:///Users/dharanshsingh/CARBON%20DPI/carbon-dpi-sdk-python)) will have a different `json.dumps()` output for nested objects unless explicitly sorted recursively.

**Fix required**: Use the recursive `JSON.stringify` sort (already in `toW3CVC`) consistently in both SDK `signTelemetry()` and the Node's verification path.

---

### FINDING #3 — Evidence Package ID Is Non-Deterministic
**File**: [`carbon-dpi-reference-node/src/sdk.ts:655-658`](file:///Users/dharanshsingh/CARBON%20DPI/carbon-dpi-reference-node/src/sdk.ts)

```ts
// GENERATES RANDOM IDs EVERY CALL — NOT REPRODUCIBLE
const deviceIdPart = Math.floor(1000 + Math.random() * 9000);
const seqPart = Math.floor(100 + Math.random() * 900);
return `EVD-${year}-IN-${sector}-${deviceIdPart}-${quarter}-${seqPart}`;
```

The Evidence ID is supposed to be a reproducible identifier for the evidence package (used in audit trails). Using `Math.random()` means:
1. If you re-run the same transaction's confirm, you get a different evidence ID
2. Two nodes issuing a GIC for the same data produce different evidence IDs (breaks multi-party verification)
3. The ID cannot be independently verified from the inputs

**Fix required**: Derive the evidence ID deterministically from `sha256(transactionId + methodologyId + year + quarter)`.

---

### FINDING #4 — Evidence Signature Falls Back to a Hardcoded Fake
**File**: [`carbon-dpi-reference-node/src/sdk.ts:623`](file:///Users/dharanshsingh/CARBON%20DPI/carbon-dpi-reference-node/src/sdk.ts)

```ts
// HARDCODED FAKE SIGNATURE — the most subtle bomb
let evidenceSignature = `ed25519:abcdef0123456789abcdef0123456789`;
if (privateKeyBase64) {
  // real signing...
}
```

If `BECKN_ED25519_PRIVATE_KEY` is not set (which it isn't in `npm run dev` mode), every Evidence Package is signed with the fake string `ed25519:abcdef0123456789...`. Unlike the W3C VC path (which at least logs a loud error), this one is **completely silent**. No warning, no log, no error.

**Fix required**: Add an identical loud warning here as in `toW3CVC`. In production, throw.

---

### FINDING #5 — Prisma Schema Uses SQLite in Production Path
**File**: [`carbon-dpi-reference-node/prisma/schema.prisma:6-8`](file:///Users/dharanshsingh/CARBON%20DPI/carbon-dpi-reference-node/prisma/schema.prisma)

```prisma
datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}
```

The docker-compose sets `DATABASE_URL=postgresql://...` but the Prisma schema provider is still `sqlite`. **Prisma ignores the provider at runtime when using a pre-generated client** — the generated client is baked to SQLite at `prisma generate` time. If someone sets a Postgres `DATABASE_URL`, the SQLite client will silently try to open it as a file path and fail with a cryptic error.

**Fix required**: Either (a) add a separate `schema.postgres.prisma` for production, or (b) use `provider = env("DATABASE_PROVIDER")` to allow switching.

---

## 🟠 HIGH — Protocol Integrity Issues

---

### FINDING #6 — `getMethodology()` in Event Bus Is a Fragile Heuristic
**File**: [`carbon-dpi-event-bus/src/index.ts:265-286`](file:///Users/dharanshsingh/CARBON%20DPI/carbon-dpi-event-bus/src/index.ts)

```ts
const getMethodology = (sourceType: string, unit: string) => {
  if (u === "kwh") return "CUPI-METH-001"; // Solar (but also METH-005 for wind)
  if (u === "km") return "CUPI-METH-004";  // EV
  if (u === "m3") return "CUPI-METH-003";  // Biogas
  if (u === "tc") return "CUPI-METH-002";  // Soil
  return "CUPI-METH-001"; // Default fallback
};
```

This is the logic that decides **which carbon calculation formula to use** based on the telemetry unit. Problems:
1. `kWh` maps to `CUPI-METH-001` (solar) by default, but wind (`CUPI-METH-005`) also uses `kWh`. The `sourceType === "WIND_TURBINE"` branch IS handled but only if explicitly set.
2. `"m3"` maps to biogas, but `m3` is also used for water volume, natural gas, and compressed air — none of which are carbon-negative assets.
3. There is no validation that the device's registered `sourceType` matches the chosen methodology.
4. A bad actor can register as `SOLAR_INVERTER` but send `unit: "m3"` to get biogas methane GWP (27.9x) applied to their solar data.

**Fix required**: Methodology selection must be locked to the **device's registered sourceType from the Trust Registry**, not the unit sent in the telemetry payload.

---

### FINDING #7 — Registry Seed Exposes `dummy_pub_key` in Subscriber Table
**File**: [`carbon-dpi-registry/src/index.ts:482`](file:///Users/dharanshsingh/CARBON%20DPI/carbon-dpi-registry/src/index.ts)

```ts
signing_public_key: process.env.BECKN_ED25519_PUBLIC_KEY ?? "dummy_pub_key",
```

On first startup without `BECKN_ED25519_PUBLIC_KEY` set, the registry seeds itself with `signing_public_key = "dummy_pub_key"`. Any service doing a `/v1/lookup` for `carbon-dpi.greenpe.in` gets this string back and will try to use it as a real Ed25519 public key. The signature verification will then fail with a cryptic crypto error rather than a useful message.

**Fix required**: If `BECKN_ED25519_PUBLIC_KEY` is not set, skip seeding the subscriber row or seed with `null`. Log a startup warning that the key is unconfigured.

---

### FINDING #8 — DID Resolution Returns `publicKeyMultibase` with Raw DER
**File**: [`carbon-dpi-registry/src/index.ts:340`](file:///Users/dharanshsingh/CARBON%20DPI/carbon-dpi-registry/src/index.ts)

```ts
verificationMethod: [{
  id: `${did}#key-1`,
  type: "Ed25519VerificationKey2020",
  controller: did,
  publicKeyMultibase: device.publicKeyBase64  // ← WRONG FORMAT
}]
```

`publicKeyMultibase` in W3C DID specification requires the key to be [Multibase](https://w3c-ccg.github.io/multibase/) encoded (prefix `z` + base58btc encoded raw public key bytes). The device's public key is stored as Base64-encoded SPKI DER — a completely different format. Any compliant W3C DID resolver will reject this document.

**Fix required**: Convert to proper multibase: `z` + base58btc(raw Ed25519 public key bytes from SPKI). Or use `publicKeyJwk` format which is more straightforward.

---

### FINDING #9 — W3C VC Context URL Is Fictional
**File**: [`carbon-dpi-reference-node/src/sdk.ts:462`](file:///Users/dharanshsingh/CARBON%20DPI/carbon-dpi-reference-node/src/sdk.ts)

```ts
"@context": [
  "https://www.w3.org/2018/credentials/v1",
  "https://spec.carbon-dpi.org/contexts/gic/v1",  // ← THIS URL DOES NOT EXIST
],
```

The second context URL is not resolvable. Any W3C VC verifier that performs JSON-LD context expansion will fail with a network error or context not found. The README verification checklist says "Schema Check: Ensure compliance with the `gic-w3c-vc.schema.json` specification" — but there's no hosted schema, no context document.

**Fix required**: Either (a) host the context document at that URL, or (b) replace it with an inline `@vocab` or the W3C VC v2 context URL until the custom context is published.

---

## 🟡 MEDIUM — Open Protocol First-Run Experience

---

### FINDING #10 — README Install Flow Has Wrong Key Format in Step 1
**File**: [`README.md:132-133`](file:///Users/dharanshsingh/CARBON%20DPI/README.md)

```bash
# README tells you to provide:
BECKN_ED25519_PRIVATE_KEY=385c98d6cbf...  # Hex-encoded
BECKN_ED25519_PUBLIC_KEY=8a93a8d6fbc...   # Hex-encoded
```

But the code at [`signing.ts:113`](file:///Users/dharanshsingh/CARBON%20DPI/carbon-dpi-beckn-adapter/src/signing.ts) expects **Base64-encoded DER**:
```ts
const privateKeyDer = Buffer.from(params.privateKeyBase64, "base64");  // Base64, not hex!
const privateKey = crypto.createPrivateKey({ key: privateKeyDer, format: "der", type: "pkcs8" });
```

If someone follows the README and provides hex-encoded keys, every signature will fail with a malformed key error. The README says "Hex-encoded" but the implementation needs "Base64-encoded DER (PKCS8/SPKI)".

**Fix required**: Update README to remove "Hex-encoded" and instead say "Run `npm run keygen` in `carbon-dpi-reference-node` to generate correctly formatted keys."

---

### FINDING #11 — `npm run dev` Has No Init Script for DB Push
**File**: [`README.md:162-175`](file:///Users/dharanshsingh/CARBON%20DPI/README.md), [`package.json` at root]

The README says run `npx prisma db push` separately in each package folder. If someone just runs `npm install && npm run dev` from the root (the natural open source experience), both services start without migrated databases and immediately crash with `no such table: Transaction`. There's no `predev` script that runs migrations first.

**Fix required**: Add `"predev": "npm run db:setup"` to root package.json, and a `db:setup` script that runs `prisma db push` in both service packages.

---

### FINDING #12 — Reference Node `v1Router` Mounted on `/v1` But Heartbeat Is Also Mounted Without `/v1`
**File**: [`carbon-dpi-reference-node/src/index.ts`]

The reference node has two heartbeat registrations:
- `v1Router.get("/heartbeat")` → accessible at `/v1/heartbeat`  
- Presumably also `app.get("/heartbeat")` for Beckn registry checks

The docker-compose health check probes `http://localhost:3001/heartbeat` (without `/v1`), but the Caddy reverse proxy routes to the node and the node may respond to either. This is fragile.

**Minor risk**: If the root `/heartbeat` doesn't exist or crashes, docker health checks fail even if the service is functionally up.

---

### FINDING #13 — `EventBusClient` in SDK Has Hardcoded Default API Key
**File**: [`carbon-dpi-sdk-js/src/index.ts:109`](file:///Users/dharanshsingh/CARBON%20DPI/carbon-dpi-sdk-js/src/index.ts)

```ts
constructor(eventBusUrl: string, cihReference: string, privateKeyPem: string, 
            apiKey: string = "default-ingest-key") {
```

The event bus validates `x-api-key` against `process.env.EVENT_BUS_API_KEY || "default-ingest-key"`. The SDK hardcodes the same default. This means any device that doesn't explicitly set an `apiKey` will work against any node that hasn't changed its default — including production nodes that forgot to rotate the key. **It's a shared secret disguised as a default.**

**Fix required**: The SDK constructor should require `apiKey` explicitly (no default). The event bus should fail startup if `EVENT_BUS_API_KEY` is not set in production.

---

## 🟢 OBSERVATIONS — Architecture Strengths (What IS Working)

These are genuine strengths that should be highlighted in the protocol documentation:

| What | Why It's Good |
|---|---|
| **Ed25519 device signing** | Per-device keys, SPKI/PKCS8 DER, correct crypto |
| **Deterministic MRV hash** | `auditHash` excludes timestamp → same inputs = same hash |
| **Per-tenant rate limiting** | Independent quotas, no cross-tenant starvation |
| **Idempotency via Redis SETNX** | Duplicate telemetry rejected at event bus |
| **W3C StatusList2021** | Revocation without leaking privacy (bitstring) |
| **Transactional outbox** | GIC_MINTED/REVOKED events survive crashes |
| **Beckn dynamic key lookup** | Trust Registry authorizes subscribers dynamically |
| **validateCDIF** | Rejects future timestamps, negatives, bad geo |
| **`"unsigned"` rejection at event bus** | Stops unsigned telemetry before it enters the pipeline |
| **Cross-tenant isolation in Prisma** | `tenantId` on all rows, enforced at query level |
| **26/26 integration tests** | Full pipeline test coverage with mocked infra |

---

## 📋 Summary: Ranked Fix Priority

| # | Finding | Severity | Lines to Fix |
|---|---|---|---|
| 1 | CIH non-deterministic (boot timestamp) | 🔴 Critical | All 3 reference demos |
| 2 | SDK signing ≠ Node verification (shallow sort) | 🔴 Critical | `sdk-js/index.ts:77`, `sdk-python` |
| 3 | Evidence ID uses `Math.random()` | 🔴 Critical | `sdk.ts:655-658` |
| 4 | Evidence signature fake fallback (silent) | 🔴 Critical | `sdk.ts:623` |
| 5 | Prisma schema provider mismatch (sqlite vs postgres) | 🔴 Critical | `schema.prisma:6` |
| 6 | Methodology chosen by unit (spoofable) | 🟠 High | `event-bus/index.ts:265` |
| 7 | Registry seeds `dummy_pub_key` | 🟠 High | `registry/index.ts:482` |
| 8 | DID `publicKeyMultibase` wrong format | 🟠 High | `registry/index.ts:340` |
| 9 | W3C VC context URL fictional | 🟠 High | `sdk.ts:462` |
| 10 | README key format wrong (hex vs base64) | 🟡 Medium | `README.md:132` |
| 11 | No `predev` DB migration script | 🟡 Medium | Root `package.json` |
| 12 | Heartbeat route confusion | 🟡 Medium | `index.ts` health check |
| 13 | SDK hardcoded API key default | 🟡 Medium | `sdk-js/index.ts:109` |

---

## 🔬 Deep Dive: The Open Protocol First-Run Experience

Here is what actually happens when someone clones this repo for the first time:

```
git clone https://github.com/...carbon-dpi
npm install          # Works
npm run dev          # 💥 Crashes: "no such table: Transaction"
# → Fix: cd carbon-dpi-registry && npx prisma db push (not in README clearly)

# After DB push:
npm run dev          # Starts but...
cd carbon-dpi-reference-solar && npm run dev
# → Generates new CIH every boot (Finding #1)
# → Registers with key "dev-admin-key" (OK for dev)
# → Sends telemetry signed with Ed25519 (correct)
# → Event bus accepts it (correct)
# → Batch processor triggers after 5 seconds
# → Sends to gateway → reference node → MRV → GIC
# → GIC issued with FAKE evidence signature (Finding #4)
# → W3C VC has fictional @context URL (Finding #9)
# → If BECKN_ED25519_PRIVATE_KEY not set → GIC VC proof is a content hash, not real signature
# → GIC verification endpoint returns 200 but signatureVerified: false
```

**The outsider sees a GIC appear but it's not cryptographically real.** They won't know until they try to verify it with an independent W3C VC verifier.

---

## 🎯 The One Thing That Makes This a Real Open Protocol

**The missing piece** is a working keygen + register flow that someone can run in 5 minutes and get a **real, externally verifiable GIC**. Currently:

```bash
# This should be the ONE command to become a verifier:
npm run setup          # (does not exist)
# Should: generate keys, db push, seed registry, start services
# Output: "Your node is live at http://localhost:3001 — first GIC issued!"
```

The protocol logic is solid. The crypto is correct. The Beckn flow works. What's needed is the **setup story** — a single script that walks a new operator from zero to their first real, externally verifiable GIC in under 5 minutes.
