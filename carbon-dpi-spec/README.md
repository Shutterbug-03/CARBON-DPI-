<p align="center">
  <img src="https://img.shields.io/badge/Carbon_UPI-Protocol_Specification-00C853?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJ3aGl0ZSI+PHBhdGggZD0iTTEyIDJMMyA3djEwbDkgNSA5LTVWN2wtOS01eiIvPjwvc3ZnPg==" alt="Carbon DPI Spec"/>
</p>

<h1 align="center">Carbon DPI Protocol Specification</h1>

<p align="center">
  <strong>The open standard for verifiable climate action in India</strong>
</p>

<p align="center">
  <a href="#overview">Overview</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#schemas">Schemas</a> •
  <a href="#climate-did">Climate DID</a> •
  <a href="#contributing">Contributing</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0--draft-blue?style=flat-square" alt="Version"/>
  <img src="https://img.shields.io/badge/license-Apache--2.0-green?style=flat-square" alt="License"/>
  <img src="https://img.shields.io/badge/status-Draft-orange?style=flat-square" alt="Status"/>
  <img src="https://img.shields.io/badge/Beckn-Compatible-purple?style=flat-square" alt="Beckn"/>
  <img src="https://img.shields.io/badge/W3C_VC-Compliant-blue?style=flat-square" alt="W3C VC"/>
</p>

---

## Overview

**Carbon DPI** is an open protocol specification for measuring, reporting, verifying, and certifying climate actions across India. It provides standardised data formats, cryptographic identity binding, deterministic MRV calculations, and W3C Verifiable Credential-based certificates.

> Carbon DPI is to climate verification what UPI is to payments — an open standard that any participant can implement.

### Design Principles

| Principle | Implementation |
|---|---|
| **Deterministic** | Same inputs → same outputs. No black-box AI decisions in emission calculations |
| **Auditable** | Every step is hash-chained. Full calculation trace is preserved |
| **Open** | Specification is public. Any developer can implement it |
| **Privacy-Preserving** | No PII stored. Identity is bound via cryptographic hashes |
| **Interoperable** | Beckn-native. W3C VC-compliant. Climate DID-compatible |

## Architecture

Carbon DPI defines a 5-layer protocol stack:

```
┌─────────────────────────────────────────────────────────┐
│  LAYER 5 │ Green Impact Certificate (GIC)               │
│          │ W3C Verifiable Credential with Ed25519 proof  │
├──────────┼──────────────────────────────────────────────┤
│  LAYER 4 │ Evidence & Audit Trail                       │
│          │ SHA-256 hash-chained audit log                │
├──────────┼──────────────────────────────────────────────┤
│  LAYER 3 │ MRV Engine                                   │
│          │ Deterministic calculation with approved EFs   │
├──────────┼──────────────────────────────────────────────┤
│  LAYER 2 │ Climate Data Interchange Format (CDIF)       │
│          │ Standardised ingestion with trust scoring     │
├──────────┼──────────────────────────────────────────────┤
│  LAYER 1 │ Composite Identity Hash (CIH)                │
│          │ SHA-256(identity ‖ asset ‖ device ‖ GPS ‖ ts) │
└──────────┴──────────────────────────────────────────────┘
```

### Data Flow

```
Entity (GSTIN/Aadhaar hash)
    │
    ▼
Layer 1: CIH ← cryptographic identity-asset-device binding
    │
    ▼
Layer 2: CDIF ← IoT/satellite/SCADA data ingested, validated, trust-scored
    │
    ▼
Layer 3: MRV ← deterministic tCO₂e calculation using approved methodology
    │
    ▼
Layer 4: Audit ← hash-chained evidence trail (each entry → previous)
    │
    ▼
Layer 5: GIC ← W3C Verifiable Credential issued, publicly verifiable
```

## Schemas

All schemas are defined in [JSON Schema Draft-07](https://json-schema.org/specification-links.html#draft-7) format.

| Schema | File | Description |
|---|---|---|
| Climate Action Object | [`schemas/climate-action-object.schema.json`](./schemas/climate-action-object.schema.json) | Foundational data structure for any climate activity |
| Climate Evidence Object | [`schemas/climate-evidence-object.schema.json`](./schemas/climate-evidence-object.schema.json) | Evidence chain with cross-validation and integrity proofs |
| GIC (W3C VC) | [`schemas/gic-w3c-vc.schema.json`](./schemas/gic-w3c-vc.schema.json) | Green Impact Certificate as W3C Verifiable Credential |
| CDIF Data Packet | [`schemas/cdif.schema.json`](./schemas/cdif.schema.json) | Climate Data Interchange Format — 8 mandatory fields |
| CIH Binding | [`schemas/cih.schema.json`](./schemas/cih.schema.json) | Composite Identity Hash input/output structure |

## Climate DID

Carbon DPI introduces **Climate Decentralised Identifiers** — W3C DID-compatible identifiers for climate actors and assets.

**Method:** `did:cupi`

**Format:** `did:cupi:{country}:{asset_type}:{local_identifier}`

**Examples:**

```
did:cupi:india:solar:GP-IND-2024-GJ-044821-SOL          # Solar asset
did:cupi:india:enterprise:GSTIN-24AADCS7412M1Z8         # Enterprise
did:cupi:india:ev_fleet:TATA-FLEET-BLR-2024-0221        # EV fleet
did:cupi:india:forest:MH-JFMC-NASIK-2024-0033           # Forest project
did:cupi:india:farmer:PMKUSUM-RAJ-BARMER-2024-1122      # Farmer
```

Full specification: [`spec/climate-did-method.md`](./spec/climate-did-method.md)

## Methodology Registry

Methodologies are encoded as machine-readable JSON in the [`carbon-dpi-methodologies`](https://github.com/carbon-dpi/carbon-dpi-methodologies) repository.

Currently encoded:

| ID | Name | Authority | Status |
|---|---|---|---|
| `CUPI-METH-001` | Grid-Connected Solar PV | CEA India v19.0 + AMS-I.D CDM v18 | ✅ Validated |
| `CUPI-METH-002` | Soil Carbon Sequestration | IPCC AR6 + VM0042 Verra | ✅ Validated |
| `CUPI-METH-003` | Biogas/Methane Capture | IPCC AR6 + AMS-III.D CDM | ✅ Validated |
| `CUPI-METH-004` | EV Fleet Emissions | MoRTH India + CEA India | ✅ Validated |
| `CUPI-METH-005` | Grid-Connected Wind | CEA India v19.0 + ACM0002 Verra | ✅ Validated |

## Emission Factor Sources

All emission factors used in Carbon DPI are sourced from government and international authorities:

| Factor | Value | Source |
|---|---|---|
| Grid EF (National) | 0.716 kgCO₂/kWh | CEA CO₂ Baseline Database v19.0, FY2023-24 |
| Grid EF (North) | 0.716 kgCO₂/kWh | CEA v19.0 |
| Grid EF (South) | 0.682 kgCO₂/kWh | CEA v19.0 |
| Grid EF (East) | 0.821 kgCO₂/kWh | CEA v19.0 |
| Grid EF (West) | 0.698 kgCO₂/kWh | CEA v19.0 |
| Grid EF (Northeast) | 0.642 kgCO₂/kWh | CEA v19.0 |
| Conservative Adj Factor | 0.95 (5% discount) | UNFCCC CDM EB55 Annex II |
| Diesel EF | 2.68 kgCO₂/litre | IPCC AR6 |
| CH₄ GWP (100yr) | 27.9 | IPCC AR6 |
| C-to-CO₂ ratio | 3.67 | Molecular weight (44/12) |
| Petrol tailpipe EF | 0.192 kgCO₂/km | MoRTH India (avg passenger vehicle) |
| EV consumption | 0.18 kWh/km | Industry average |

## Related Repositories

| Repository | Description |
|---|---|
| [`carbon-dpi-api`](https://github.com/carbon-dpi/carbon-dpi-api) | OpenAPI 3.0 definitions |
| [`carbon-dpi-beckn-adapter`](https://github.com/carbon-dpi/carbon-dpi-beckn-adapter) | Beckn protocol adapter for ONCM |
| [`carbon-dpi-methodologies`](https://github.com/carbon-dpi/carbon-dpi-methodologies) | MRV methodology library |
| [`carbon-dpi-sdk-js`](https://github.com/carbon-dpi/carbon-dpi-sdk-js) | JavaScript/TypeScript SDK |
| [`carbon-dpi-sdk-python`](https://github.com/carbon-dpi/carbon-dpi-sdk-python) | Python SDK |
| [`carbon-dpi-reference-solar`](https://github.com/carbon-dpi/carbon-dpi-reference-solar) | Solar PV reference implementation |
| [`carbon-dpi-reference-ev`](https://github.com/carbon-dpi/carbon-dpi-reference-ev) | EV fleet reference implementation |
| [`carbon-dpi-reference-msme`](https://github.com/carbon-dpi/carbon-dpi-reference-msme) | MSME CBAM reference implementation |
| [`carbon-dpi-reference-node`](https://github.com/carbon-dpi/carbon-dpi-reference-node) | Reference node implementation |

## Contributing

Carbon DPI is an open protocol. Contributions are welcome.

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for guidelines.

## License

This specification is licensed under [Apache License 2.0](./LICENSE).

---

<p align="center">
  <strong>Carbon DPI</strong> — Open protocol for verifiable climate action<br/>
  <a href="https://greeenpe.com">greeenpe.com</a> • Reference implementation by GreenPe Technologies
</p>
