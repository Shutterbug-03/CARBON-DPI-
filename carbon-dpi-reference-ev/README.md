<h1 align="center">Carbon DPI — EV Fleet Reference Implementation</h1>

<p align="center">
  <strong>Reference for EV fleet emissions verification using Carbon DPI</strong>
</p>

---

## Overview

Demonstrates Carbon DPI protocol for **EV fleet commercial** verification — calculating avoided tailpipe emissions by displacing petrol/diesel vehicles.

### Methodology

- **Baseline:** 0.192 kgCO₂/km (MoRTH India, avg passenger vehicle)
- **EV consumption:** 0.18 kWh/km
- **Grid EF:** 0.716 kgCO₂/kWh (CEA India v19.0)
- **Formula:** `tCO₂e = km × (petrol_EF − kWh_per_km × grid_EF) / 1000 × CAF`

## Related

- [carbon-dpi-spec](https://github.com/carbon-dpi/carbon-dpi-spec) — Protocol specification
- [carbon-dpi-methodologies](https://github.com/carbon-dpi/carbon-dpi-methodologies) — Methodology library

## License

Apache License 2.0
