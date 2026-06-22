<p align="center">
  <img src="https://img.shields.io/badge/Carbon_UPI-Beckn_Adapter-7C4DFF?style=for-the-badge" alt="Beckn Adapter"/>
</p>

<h1 align="center">Carbon DPI Beckn Adapter</h1>

<p align="center">
  <strong>Beckn protocol adapter for climate verification — makes Carbon DPI an ONCM-compatible BPP</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Beckn-1.1.0-purple?style=flat-square" alt="Beckn"/>
  <img src="https://img.shields.io/badge/domain-climate--verification-green?style=flat-square" alt="Domain"/>
  <img src="https://img.shields.io/badge/license-Apache--2.0-green?style=flat-square" alt="License"/>
</p>

---

## Overview

This is the **Beckn Protocol Adapter** for Carbon DPI — a standalone service that enables Carbon DPI to participate in India's open commerce networks (ONCM) as a **Beckn Provider Platform (BPP)** in the `climate-verification` domain.

Just as Namma Yatri integrated with Beckn to provide mobility services, Carbon DPI integrates with Beckn to provide climate verification services.

## Architecture

```
Beckn Network (BAP)                    Carbon DPI Core
    │                                       │
    │  POST /search                         │
    ├──────────────────►┌──────────────┐    │
    │                   │ Beckn Adapter │    │
    │  POST /select     │              │    │
    ├──────────────────►│ • Validate   │    │
    │                   │ • Translate   ├───►│ CIH → CDIF → MRV → GIC
    │  POST /init       │ • Route      │    │
    ├──────────────────►│ • Sign       │◄───│
    │                   │              │    │
    │  POST /confirm    │ Response:    │    │
    ├──────────────────►│ GIC as W3C VC│    │
    │                   └──────────────┘    │
    │◄──────────────────────────────────────┤
```

## Endpoints

| Endpoint | Direction | Description |
|---|---|---|
| `POST /search` | BAP → BPP | Discover verification services, filter by sector/asset type |
| `POST /select` | BAP → BPP | Select a methodology, submit CDIF data for assessment |
| `POST /init` | BAP → BPP | Initiate MRV calculation |
| `POST /confirm` | BAP → BPP | Receive completed GIC as W3C Verifiable Credential |
| `POST /on_search` | BPP → BAP | Async callback with catalog |
| `POST /on_select` | BPP → BAP | Async callback with data quality assessment |
| `POST /on_init` | BPP → BAP | Async callback with calculation progress |
| `POST /on_confirm` | BPP → BAP | Async callback with completed GIC |
| `GET /status` | Any | Check verification job status |
| `GET /heartbeat` | Registry | Liveness check (< 100ms response) |

## Beckn Context

```json
{
  "domain": "climate-verification",
  "action": "search",
  "country": "IND",
  "core_version": "1.1.0",
  "bpp_id": "carbon-dpi.greenpe.in",
  "bpp_uri": "https://carbon-dpi.greenpe.in/beckn"
}
```

## Quick Start

```bash
git clone https://github.com/carbon-dpi/carbon-dpi-beckn-adapter.git
cd carbon-dpi-beckn-adapter
npm install
cp .env.example .env  # Configure your keys
npm run dev
```

## Configuration

| Variable | Description | Required |
|---|---|---|
| `BECKN_SUBSCRIBER_ID` | Your Beckn subscriber ID | Yes |
| `BECKN_SUBSCRIBER_URL` | Your public Beckn endpoint URL | Yes |
| `BECKN_SIGNING_KEY` | Ed25519 private key for signing | Yes |
| `CARBON_UPI_CORE_URL` | URL of the Carbon DPI core API | Yes |
| `PORT` | Service port (default: 3001) | No |

## Related

- [carbon-dpi-spec](https://github.com/carbon-dpi/carbon-dpi-spec) — Protocol specification
- [carbon-dpi-api](https://github.com/carbon-dpi/carbon-dpi-api) — OpenAPI definitions
- [Beckn Core Spec](https://github.com/beckn/protocol-specifications) — Beckn protocol

## License

Apache License 2.0
