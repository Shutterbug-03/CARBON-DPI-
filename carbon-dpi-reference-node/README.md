<h1 align="center">Carbon DPI — Reference Node</h1>

<p align="center">
  <strong>Reference implementation for a Carbon DPI verification node</strong>
</p>

---

## Overview

A Carbon DPI **verification node** is a participant in the Carbon DPI network that runs the MRV engine, issues GICs, and communicates with other nodes via the Beckn protocol.

This repository provides a reference implementation that can be cloned, configured, and deployed by any organisation wanting to operate a node — banks, government agencies, carbon registries, or accredited verifiers.

### Node Types

| Type | Operator | Function |
|---|---|---|
| **Verifier Node** | GreenPe, VVBs | Runs MRV engine, issues GICs |
| **Government Node** | BEE, MNRE | Receives GICs for CCTS/NDC tracking |
| **Registry Node** | Verra, Gold Standard | Issues credits against GICs |
| **Bank Node** | HDFC, SBI, SIDBI | Monitors SLL compliance via GICs |
| **Enterprise Node** | Corporates | Aggregates GICs for BRSR reporting |

### Requirements

Every node implements:
- Beckn participant API (search/select/init/confirm)
- Carbon DPI event bus subscription
- Trust Registry lookup
- GIC verification endpoint
- Heartbeat endpoint (< 100ms)

## Related

- [carbon-dpi-spec](https://github.com/carbon-dpi/carbon-dpi-spec) — Protocol specification
- [carbon-dpi-beckn-adapter](https://github.com/carbon-dpi/carbon-dpi-beckn-adapter) — Beckn adapter

## License

Apache License 2.0
