# Implementation Plan — Carbon DPI Protocol Roadmap (Phases 6, 7 & 8)

This plan divides the remaining 17 open gaps from the codebase autopsy into three subsequent development phases to transition Carbon DPI into a production-grade, secure, and fully compliant open protocol.

---

## Phase 6: Protocol Core Completeness (Layer 4 & Spec Alignment)

**Goal:** Achieve 100% compliance with the Carbon DPI layered specification and standard Beckn error-reporting.

### Proposed Changes

#### 1. Implement Layer 4: Evidence & Audit Trail
- **Component:** `carbon-dpi-reference-node` & `carbon-dpi-event-bus`
- **Changes:**
  - Create a Prisma model for `EvidencePackage` representing the `ClimateEvidenceObject` schema.
  - During `/select` or telemetry ingestion batches, calculate and store `raw_data_hash`, `data_completeness` (fraction of expected points), and sign the package using the device's public key controller context.
  - Link issued Certificates to their respective Layer 4 `EvidencePackage` via the `activity_id` and audit trail.

#### 2. Unify Express Error Handling to Beckn NACKs
- **Component:** `carbon-dpi-reference-node`, `carbon-dpi-registry`, `carbon-dpi-event-bus`
- **Changes:**
  - Implement a global Express error-handling middleware that catches all unhandled routing exceptions.
  - Transform raw error strings into structured Beckn NACK payloads:
    ```json
    {
      "context": { ... },
      "message": { "ack": { "status": "NACK" } },
      "error": { "type": "SYSTEM-ERROR", "code": "50000", "message": "Reason details" }
    }
    ```

#### 3. Strict Ed25519 Verification Node Assertion
- **Component:** `carbon-dpi-reference-node`
- **Changes:**
  - Restrict W3C VC generation to fail hard if `BECKN_ED25519_PRIVATE_KEY` is missing in production environments (disallow fallback to fake content hashes unless `NODE_ENV === "development"`).

---

## Phase 7: Production-Grade Hardening (Monorepo, CI/CD & Operations)

**Goal:** Standardize package dependencies, secure configurations, and introduce automated QA gates.

### Proposed Changes

#### 1. Monorepo Migration & Tooling
- **Component:** Project Root [package.json](file:///Users/dharanshsingh/CARBON%20DPI/package.json)
- **Changes:**
  - Create a central monorepo structure utilizing npm workspaces.
  - Consolidate common tooling, config files (`tsconfig.json`, eslint, jest settings), and prune duplicated dependencies.

#### 2. CI/CD Workflows
- **Component:** Root [workflows](file:///Users/dharanshsingh/CARBON%20DPI/.github/workflows/)
- **Changes:**
  - Add GitHub Actions workflows to run Jest test suites across the packages and Python SDK tests (`pytest`) automatically on PRs.

#### 3. Operational Tweaks
- **Component:** `carbon-dpi-event-bus` & configs
- **Changes:**
  - Migrate Redis polling pop logic from loop `rpop` to atomic transactions or a Redis Lua script.
  - Constrain CORS middleware from wildcard `*` to whitelist origin domains configured via env vars.
  - Purge committed `dev.db` SQLite files from Git history and update `.gitignore`.

---

## Phase 8: Enterprise Open Protocol Architecture (Ecosystem Scale)

**Goal:** Scale the protocol to support multiple verifier nodes, third-party integrations, and professional observability.

### Proposed Changes

#### 1. GIC Revocation System (W3C VC Spec)
- **Component:** `carbon-dpi-reference-node` & `carbon-dpi-registry`
- **Changes:**
  - Implement W3C Status List 2021/2023 endpoints allowing verifier nodes to declare a GIC as revoked (e.g., due to downstream device tampering or audit failures).

#### 2. Outbox Webhook System
- **Component:** `carbon-dpi-reference-node`
- **Changes:**
  - Build a transactional outbox webhook system that notifies external subscribers (e.g. buyers, registry databases) immediately when a GIC is successfully minted or status changes.

#### 3. Connector & IoT Bridge Framework
- **Component:** Ingestion layer
- **Changes:**
  - Build an MQTT broker bridge or a generalized webhook plugin system so that third-party inverter portals (Huawei FusionSolar, SolarEdge, Growatt) or EV telematics APIs can push CDIF data without custom adapters.

#### 4. Multi-Tenancy & Observability
- **Component:** All services
- **Changes:**
  - Enable multi-tenant profiles in the Reference Node (processing and database isolation per asset owner).
  - Add Prometheus metric endpoints and OpenTelemetry tracers for cross-service logging.
  - Auto-generate and serve OpenAPI/Swagger specs on `/docs` routes.

---

## Verification Plan

### Automated Tests
- Run full regression tests on Jest and pytest.
- Create a test suite verifying Layer 4 `ClimateEvidenceObject` schemas.

### Manual Verification
- Deploy reference solar, EV, and MSME simulators and trace the correct mapping and trust classification visually.
