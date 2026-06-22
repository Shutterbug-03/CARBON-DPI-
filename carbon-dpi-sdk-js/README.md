<h1 align="center">@carbon-dpi/sdk</h1>

<p align="center">
  <strong>JavaScript/TypeScript SDK for the Carbon DPI protocol</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/npm-@carbon--upi/sdk-red?style=flat-square" alt="npm"/>
  <img src="https://img.shields.io/badge/TypeScript-5.0+-blue?style=flat-square" alt="TypeScript"/>
  <img src="https://img.shields.io/badge/license-Apache--2.0-green?style=flat-square" alt="License"/>
</p>

---

## Installation

```bash
npm install @carbon-dpi/sdk
```

## Quick Start

```typescript
import { computeCIH, calculateMRV, generateGIC } from '@carbon-dpi/sdk';

// Layer 1: Compute Composite Identity Hash
const cih = computeCIH({
  identityHash: 'sha256-of-gstin',
  assetId: 'SOLAR-GJ-0442',
  deviceId: 'SUN2000-50KTL',
  lat: 23.0225,
  lng: 72.5714,
  timestamp: '2024-10-01T00:00:00Z',
});

// Layer 3: Run MRV calculation
const mrv = calculateMRV({
  identityBinding: { cih, /* ... */ },
  dataPoints: [ /* CDIF data points */ ],
  methodology: 'CUPI-METH-001', // Solar PV
  timeWindow: { start: '2024-10-01', end: '2024-12-31' },
});

// Layer 5: Generate GIC
const gic = generateGIC(mrv);
console.log(`Verified: ${gic.impactValue.amount} tCO₂e`);
```

## API

| Function | Layer | Description |
|---|---|---|
| `computeCIH(params)` | L1 | Compute Composite Identity Hash |
| `validateCDIF(dataPoints)` | L2 | Validate data against CDIF schema |
| `calculateMRV(input)` | L3 | Run deterministic MRV calculation |
| `createAuditTrail(entries)` | L4 | Create hash-chained audit log |
| `generateGIC(mrvOutput)` | L5 | Generate Green Impact Certificate |
| `toW3CVC(gic)` | L5 | Convert GIC to W3C Verifiable Credential |

## Related

- [carbon-dpi-spec](https://github.com/carbon-dpi/carbon-dpi-spec) — Protocol specification
- [carbon-dpi-api](https://github.com/carbon-dpi/carbon-dpi-api) — OpenAPI definitions

## License

Apache License 2.0
