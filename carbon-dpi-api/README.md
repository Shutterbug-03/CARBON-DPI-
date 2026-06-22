<p align="center">
  <img src="https://img.shields.io/badge/Carbon_UPI-OpenAPI-0288D1?style=for-the-badge" alt="Carbon DPI API"/>
</p>

<h1 align="center">Carbon DPI API</h1>

<p align="center">
  <strong>OpenAPI 3.0 definitions for the Carbon DPI protocol endpoints</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/OpenAPI-3.0-green?style=flat-square" alt="OpenAPI"/>
  <img src="https://img.shields.io/badge/endpoints-5-blue?style=flat-square" alt="Endpoints"/>
  <img src="https://img.shields.io/badge/license-Apache--2.0-green?style=flat-square" alt="License"/>
</p>

---

## Overview

OpenAPI 3.0 specification for all Carbon DPI protocol endpoints. Use this to auto-generate client SDKs, documentation (Swagger UI / Redoc), and mock servers.

## Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/asset/register` | Register a climate asset and generate CIH |
| `POST` | `/v1/cdif/submit` | Submit climate data in CDIF format |
| `POST` | `/v1/mrv/verify` | Run deterministic MRV calculation |
| `POST` | `/v1/gic/generate` | Generate a Green Impact Certificate |
| `GET` | `/v1/gic/{id}` | Retrieve and verify a GIC |
| `POST` | `/v1/methodology/validate` | Validate a methodology against the registry |

## Documentation

View the interactive API documentation:

- **Swagger UI:** Coming soon at `developers.carbon-dpi.org`
- **Redoc:** Coming soon

## Usage

```bash
# Validate the spec
npx @redocly/cli lint openapi.yaml

# Generate TypeScript client
npx openapi-typescript openapi.yaml -o ./generated/api-types.ts

# Launch Swagger UI locally
npx swagger-ui-watcher openapi.yaml
```

## Related

- [carbon-dpi-spec](https://github.com/carbon-dpi/carbon-dpi-spec) — Protocol specification
- [carbon-dpi-sdk-js](https://github.com/carbon-dpi/carbon-dpi-sdk-js) — JavaScript SDK
- [carbon-dpi-sdk-python](https://github.com/carbon-dpi/carbon-dpi-sdk-python) — Python SDK

## License

Apache License 2.0
