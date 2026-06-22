# 🗄️ Carbon DPI Trust Registry (Layer 2)

<p align="center">
  <strong>The identity directory, subscriber lookup, and DID resolution service for Carbon DPI.</strong>
</p>

---

## 🔍 Overview

The **Trust Registry** acts as the Layer 2 Identity Directory for the Carbon DPI network. Its primary responsibilities are:
1. **Climate DID Resolution**: Resolves decentralized identifiers (`did:cupi`) for verifier nodes and individual climate assets (such as solar inverters or EV fleets).
2. **Beckn Subscriber Directory**: Functions as a Beckn Registry (`/v1/lookup`) allowing gateways and event buses to find active Verifier Nodes (BPPs) and fetch their public keys for header signature verification.
3. **Device Registry**: Stores the public keys and geo-locations of verified physical sensors, mapping them to their corresponding Composite Identity Hashes (CIH).
4. **Methodology Directory**: Serves the standardized JSON-encoded carbon methodologies (avoidance/reduction schemas) for nodes to download and execute.
5. **W3C Revocation Lists**: Generates and serves dynamic W3C Status List 2021 credentials that track verifier node status.

---

## 🗃️ Database Schema (Prisma)

The registry uses SQLite for local development and PostgreSQL for production:

* **`Device`**: Records telemetry source parameters, mapping `cihReference` (ID) to public keys (`publicKeyBase64`) for edge signature validation.
* **`Verifier`**: Records active verifier nodes, their DIDs, accreditation bodies, and Beckn endpoints.
* **`Subscriber`**: Implements the standard Beckn Registry format to track subscribers (BAPs/BPPs), their URLs, signing public keys, validity periods, and statuses.

---

## 🚀 API Endpoints

### 1. Identity & DID Resolution (`/1.0/identifiers/:did`)
Resolves a W3C-compliant Climate DID:
* **Verifier DID** (`did:cupi:india:verifier:{name}`): Returns DID metadata containing the verifier's Beckn endpoint.
* **Asset DID** (`did:cupi:india:asset:{cihReference}`): Returns the public key multibase mapped to the physical device.

### 2. Beckn Subscriber Lookup (`POST /v1/lookup`)
Queries the directory of active network participants. Gateways use this to retrieve signing public keys.

### 3. Methodology Registry
* `GET /v1/registry/methodologies`: Returns all loaded carbon offset methodologies.
* `GET /v1/registry/methodologies/:id`: Returns a specific methodology definition.

### 4. Device Management (Admin Auth Required)
* `POST /v1/registry/devices`: Register or update an IoT sensor's public keys and geolocation.
* `GET /v1/registry/devices`: Retrieve all registered devices.
* `GET /v1/registry/devices/:cih`: Retrieve device specifications by CIH.

### 5. Verifier Management
* `GET /v1/registry/verifiers`: Retrieve all active verifiers.
* `POST /v1/registry/verifiers/:did/revoke`: Marks a verifier DID as revoked.
* `GET /v1/status-list/verifiers`: Compiles a Gzip-compressed, Base64-encoded W3C Status List bitstring tracking revoked verifiers.

---

## ⚙️ Configuration & Environment

To configure the Trust Registry, create a local `.env` file inside this directory:

```env
PORT=3003
DATABASE_URL="file:./dev.db" # SQLite local path (or postgres:// connection url)
LOG_LEVEL="debug"
REGISTRY_ADMIN_KEY="dev-admin-key" # API Key for registering devices/verifiers
CORS_ALLOWED_ORIGINS="http://localhost:3000,http://localhost:3001"
```

---

## 🛠️ Launch & Setup

### Direct Local Execution
Make sure you are in the registry package folder:
```bash
# 1. Run migrations
npx prisma db push

# 2. Start the service
npm run dev
```

### Docker
The service is automatically built and launched by the root `docker-compose.yml` file. It listens on port `3003`.
