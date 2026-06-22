# 💨 Carbon DPI Event Bus & Telemetry Ingestion Layer

<p align="center">
  <strong>The high-speed telemetry ingestion, Redis-buffered queue, and Beckn BAP orchestrator for Carbon DPI.</strong>
</p>

---

## 🔍 Overview

The **Event Bus** acts as the high-throughput gateway for raw climate telemetry. It bridges IoT sensors (solar, EV, MSME monitors) with the core verification engine:
1. **Multi-Protocol Ingestion**: Exposes a secure HTTP POST `/v1/ingest` route and hosts an embedded MQTT Broker (port `1883`) subscribing to the `carbon-dpi/telemetry` topic.
2. **Idempotency Safeguard**: Employs a Redis `SETNX` lock to drop duplicate telemetry packets, ensuring database and calculations remain exact.
3. **Stateless Buffering**: Buffers telemetry packets into a Redis queue. A background polling loop consumes batches of up to 100 points atomically using Lua scripting.
4. **Beckn Orchestrator**: Acts as the Beckn Application Platform (BAP) initiator, driving the `/search` -> `/select` -> `/init` -> `/confirm` callback sequence dynamically until verification succeeds.
5. **Observed Dead Letter Queue (DLQ)**: Automatically sweeps stale transactions older than 1 hour into a DLQ to prevent memory leaks and support error analysis.

---

## ⚙️ Ingestion & Beckn Orchestration Flow

```
Edge Inverters / SDKs
    │  (HTTP /v1/ingest  OR  MQTT carbon-dpi/telemetry)
    ▼
┌──────────────────────────────────────────────┐
│             Event Bus Service                │
└──────────────────────┬───────────────────────┘
                       │ Check Idempotency Key
                       ▼
┌──────────────────────────────────────────────┐
│           Redis Queue Buffer                 │
└──────────────────────┬───────────────────────┘
                       │ Lua script pop (Batch)
                       ▼
┌──────────────────────────────────────────────┐
│           Beckn Client Orchestrator          │
└──────────────────────┬───────────────────────┘
                       │ Post /search
                       ▼
            [ Beckn Gateway Route ]
```

---

## 🚀 API Endpoints

### 1. Ingestion Endpoint
* `POST /v1/ingest`: Submits raw telemetry payload in Carbon Data Ingestion Format (CDIF). Requires `x-api-key` in production header.

### 2. Beckn Callback Webhooks (from Gateway/Node)
Triggers successive steps in the verification lifecycle:
* `POST /v1/on_search`: Initiates item selection based on methodology compatibility.
* `POST /v1/on_select`: Prepares order initiation.
* `POST /v1/on_init`: Collects provider terms and logs initialization.
* `POST /v1/on_confirm`: Prints the minted Green Impact Certificate (GIC) from the payload, deletes the active transaction index, and dispatches the callback to subscribers.

### 3. Infrastructure & Observability
* `GET /v1/heartbeat`: Checks connection to Redis and fetches the current queue size.
* `GET /metrics`: Serves Prometheus counters monitoring total HTTP requests, MQTT packets, and ingested telemetry count.

---

## ⚙️ Configuration & Environment

Create a `.env` file in the event-bus directory:

```env
PORT=3004
LOG_LEVEL="info"
REDIS_URL="redis://localhost:6379"
BECKN_GATEWAY_URL="http://localhost:3005"
BAP_URI="http://localhost:3004"
BATCH_INTERVAL_MS=5000
EVENT_BUS_API_KEY="default-ingest-key" # Ingestion api key
BECKN_SUBSCRIBER_ID="carbon-dpi.greenpe.in"
BECKN_UNIQUE_KEY_ID="carbon-dpi-key-001"
BECKN_ED25519_PRIVATE_KEY="..." # Hex private key of BAP
BECKN_BPP_PUBLIC_KEY="..."       # Public key of BPP Verifier Node
CORS_ALLOWED_ORIGINS="http://localhost:3000,http://localhost:3001"
```

---

## 🛠️ Launch & Setup

### Direct Local Execution
Make sure you have a running Redis server (`redis-server`), then run:
```bash
npm run dev
```

### Docker
The service is automatically built and launched by the root `docker-compose.yml` file. It listens on port `3004` (HTTP) and `1883` (MQTT).
