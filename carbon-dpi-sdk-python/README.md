<h1 align="center">carbon-dpi-sdk-python</h1>

<p align="center">
  <strong>Python SDK for the Carbon DPI protocol</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/PyPI-carbon--upi-blue?style=flat-square" alt="PyPI"/>
  <img src="https://img.shields.io/badge/Python-3.9+-yellow?style=flat-square" alt="Python"/>
  <img src="https://img.shields.io/badge/license-Apache--2.0-green?style=flat-square" alt="License"/>
</p>

---

## Installation

```bash
pip install carbon-dpi
```

## Quick Start

```python
from carbon_dpi import compute_cih, calculate_mrv, generate_gic

# Layer 1: Composite Identity Hash
cih = compute_cih(
    identity_hash="sha256-of-gstin",
    asset_id="SOLAR-GJ-0442",
    device_id="SUN2000-50KTL",
    lat=23.0225,
    lng=72.5714,
    timestamp="2024-10-01T00:00:00Z"
)

# Layer 3: MRV calculation
result = calculate_mrv(
    cih=cih,
    data_points=[...],  # CDIF data
    methodology="CUPI-METH-001",
    time_window=("2024-10-01", "2024-12-31")
)

# Layer 5: Generate GIC
gic = generate_gic(result)
print(f"Verified: {gic.impact_value} tCO₂e")
```

## API

| Function | Layer | Description |
|---|---|---|
| `compute_cih(...)` | L1 | Compute Composite Identity Hash |
| `validate_cdif(data_points)` | L2 | Validate against CDIF schema |
| `calculate_mrv(...)` | L3 | Deterministic MRV calculation |
| `generate_gic(mrv_output)` | L5 | Generate Green Impact Certificate |
| `to_w3c_vc(gic)` | L5 | Convert to W3C Verifiable Credential |

## Related

- [carbon-dpi-spec](https://github.com/carbon-dpi/carbon-dpi-spec) — Protocol specification
- [carbon-dpi-sdk-js](https://github.com/carbon-dpi/carbon-dpi-sdk-js) — JavaScript SDK

## License

Apache License 2.0
