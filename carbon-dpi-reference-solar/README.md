<h1 align="center">Carbon DPI — Solar PV Reference Implementation</h1>

<p align="center">
  <strong>End-to-end reference for grid-connected solar PV verification using Carbon DPI</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/methodology-AMS--I.D_v18-green?style=flat-square" alt="Methodology"/>
  <img src="https://img.shields.io/badge/emission_factor-CEA_v19.0-blue?style=flat-square" alt="EF"/>
  <img src="https://img.shields.io/badge/license-Apache--2.0-green?style=flat-square" alt="License"/>
</p>

---

## Overview

Complete working example of the Carbon DPI protocol for **grid-connected solar PV** generation. Demonstrates the full 5-layer pipeline from identity binding through GIC issuance.

### What This Shows

1. **Layer 1:** Register a solar asset and compute CIH
2. **Layer 2:** Ingest inverter generation data in CDIF format
3. **Layer 3:** Calculate avoided emissions using CEA India v19.0 grid emission factors
4. **Layer 4:** Generate hash-chained audit trail
5. **Layer 5:** Issue GIC as W3C Verifiable Credential

### Methodology

- **Standard:** UNFCCC CDM AMS-I.D v18
- **Grid EF:** 0.716 kgCO₂/kWh (CEA India national average, FY2023-24)
- **CAF:** 0.95 (5% conservative adjustment, CDM EB55 Annex II)
- **Formula:** `tCO₂e = (kWh × grid_EF / 1000) × CAF`

## Quick Start

```bash
git clone https://github.com/carbon-dpi/carbon-dpi-reference-solar.git
cd carbon-dpi-reference-solar
npm install
npm run demo
```

## Related

- [carbon-dpi-spec](https://github.com/carbon-dpi/carbon-dpi-spec) — Protocol specification
- [carbon-dpi-methodologies](https://github.com/carbon-dpi/carbon-dpi-methodologies) — Methodology library

## License

Apache License 2.0
