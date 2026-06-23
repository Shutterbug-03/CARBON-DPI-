/**
 * Carbon DPI — Beckn Adapter (Cryptography & Protocol Library)
 *
 * ⚠️  THIS FILE IS NOT A RUNNABLE SERVER ⚠️
 *
 * This package (@carbon-dpi/beckn-adapter) is a SHARED LIBRARY providing:
 *   - Ed25519 signing/verification for Beckn protocol messages
 *   - Beckn catalog building (methodology → BecknCatalogItem)
 *   - Beckn callback dispatching with retry
 *   - GIC → Beckn fulfillment/document conversion
 *
 * The actual Beckn BPP server is the `carbon-dpi-reference-node`, which:
 *   - Runs the real MRV engine
 *   - Persists data via Prisma + SQLite/PostgreSQL
 *   - Issues cryptographically signed W3C Verifiable Credentials
 *   - Manages the full search → select → init → confirm Beckn lifecycle
 *
 * ───────────────────────────────────────────────────────────────────────────
 * To run the BPP server:
 *   cd ../carbon-dpi-reference-node && npm run dev
 *
 * To run the Beckn Gateway (multicast router):
 *   cd ../carbon-dpi-beckn-gateway && npm run dev
 *
 * To integrate this library as a BPP in your own service:
 *   import { signBecknRequest, verifyBecknSignature, buildBecknCatalog } from '@carbon-dpi/beckn-adapter';
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Architecture:
 *
 *   IoT Device (SDK)
 *       ↓  (Ed25519 signed telemetry)
 *   Event Bus (:3004)
 *       ↓  (Beckn search, signed by this library)
 *   Beckn Gateway (:3005)
 *       ↓  (multicast to registered BPPs)
 *   Reference Node (:3001)   ← THE REAL BPP (uses this library)
 *       ↓
 *   Trust Registry (:3003)   ← Device DID & subscriber lookup
 *
 * @see https://github.com/carbon-dpi/carbon-dpi-reference-node
 */

// Re-export all library functions for package consumers
export * from "./adapter";
export * from "./signing";
