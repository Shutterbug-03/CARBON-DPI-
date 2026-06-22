<p align="center">
  <img src="https://img.shields.io/badge/Carbon_UPI-Methodologies-00C853?style=for-the-badge" alt="Carbon DPI Methodologies"/>
</p>

<h1 align="center">Carbon DPI Methodology Library</h1>

<p align="center">
  <strong>Machine-readable MRV methodology encodings for the Carbon DPI protocol</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/methodologies-5-blue?style=flat-square" alt="Count"/>
  <img src="https://img.shields.io/badge/license-Apache--2.0-green?style=flat-square" alt="License"/>
  <img src="https://img.shields.io/badge/format-JSON-orange?style=flat-square" alt="Format"/>
</p>

---

## Overview

This repository contains the machine-readable methodology library for the Carbon DPI protocol. Each methodology is encoded as a JSON document with its baseline formula, emission factors, adjustment factors, confidence scoring rules, and a sample calculation trace.

These methodologies are used by Carbon DPI's MRV engine to perform deterministic emission calculations. All emission factors are sourced from government and international authorities — no proprietary or estimated values.

## Methodologies

| ID | Name | Authority | Primary EF | Status |
|---|---|---|---|---|
| [`CUPI-METH-001`](./methodologies/CUPI-METH-001-solar-pv.json) | Grid-Connected Solar PV | CEA India v19.0 + AMS-I.D CDM v18 | 0.716 kgCO₂/kWh | ✅ Validated |
| [`CUPI-METH-002`](./methodologies/CUPI-METH-002-soil-carbon.json) | Soil Carbon Sequestration | IPCC AR6 + VM0042 Verra | 3.67 tCO₂/tC | ✅ Validated |
| [`CUPI-METH-003`](./methodologies/CUPI-METH-003-biogas.json) | Biogas / Methane Capture | IPCC AR6 + AMS-III.D CDM | 27.9 GWP₁₀₀ | ✅ Validated |
| [`CUPI-METH-004`](./methodologies/CUPI-METH-004-ev-fleet.json) | EV Fleet Emissions | MoRTH India + CEA India | 0.192 kgCO₂/km | ✅ Validated |
| [`CUPI-METH-005`](./methodologies/CUPI-METH-005-wind.json) | Grid-Connected Wind | CEA India v19.0 + ACM0002 Verra | 0.716 kgCO₂/kWh | ✅ Validated |

## Methodology JSON Format

Each methodology file follows this structure:

```json
{
  "methodology_id": "CUPI-METH-001",
  "name": "...",
  "external_reference": { "standard": "...", "code": "...", "version": "..." },
  "baseline_formula": { "formula": "...", "variables": { ... } },
  "adjustment_factors": [ ... ],
  "confidence_score_rules": { ... },
  "sample_calculation": { "input": { ... }, "trace": [ ... ], "output": { ... } }
}
```

Full schema: [`carbon-dpi-spec/schemas/methodology-registry.schema.json`](https://github.com/carbon-dpi/carbon-dpi-spec)

## Contributing a New Methodology

1. Fork this repository
2. Create a new JSON file: `methodologies/CUPI-METH-{NNN}-{name}.json`
3. Follow the existing format (see Solar PV as the reference)
4. Include real emission factors with authority citations
5. Include a sample calculation trace
6. Submit a pull request

## License

Apache License 2.0
