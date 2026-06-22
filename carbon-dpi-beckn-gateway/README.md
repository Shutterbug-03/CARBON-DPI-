# 🛣️ Carbon DPI Beckn Gateway

<p align="center">
  <strong>The open networking routing, signature validation, and multicast gateway for Carbon DPI.</strong>
</p>

---

## 🔍 Overview

The **Beckn Gateway** is the networking backbone of the Carbon DPI protocol. It implements the standard Beckn interface, enabling discovery and request distribution across the decentralized network:
1. **Multicast Routing**: Intercepts inbound calls from active Application Platforms (BAPs) and routes them to all active Verifier Nodes (BPPs).
2. **Registry Integration**: Periodically polls the Trust Registry to update its directory of online verifiers.
3. **Cryptographic Validation**: Validates signature headers of incoming requests to ensure only accredited BAPs can query the network, and appends the Gateway's own signatures for downstream verification.
4. **Certificate Proxy**: Exposes a public proxy `/v1/gic/:id` to sequentially fetch certificates from active verifiers, acting as a global verification gateway.

---

## ⚙️ Architecture

```
                    ┌────────────────────────┐
                    │  Application (BAP)     │
                    └───────────┬────────────┘
                                │ POST /v1/search
                                ▼
                    ┌────────────────────────┐
                    │      Beckn Gateway     │◄───── (Polls active BPP URLs)
                    └───────────┬────────────┘           │
                                │                        ▼
                 ┌──────────────┴──────────────┐   ┌───────────┐
                 │  Multicast forward          │   │  Trust    │
                 ▼                             ▼   │  Registry │
         ┌──────────────┐              ┌───────────┐└───────────┘
         │Verifier Node │              │Verifier   │
         │   (BPP 1)    │              │ (BPP 2)   │
         └──────────────┘              └───────────┘
```

---

## 🚀 API Endpoints

### 1. Beckn Action Routes
Accepts incoming Beckn transactions, validates headers, and forwards them to active BPP verifiers:
* `POST /v1/search`
* `POST /v1/select`
* `POST /v1/init`
* `POST /v1/confirm`
* `POST /v1/cancel`

On receipt, the gateway immediately returns an acknowledgment payload (`ACK` status) and processes the multicast asynchronously.

### 2. GIC Lookup Proxy (`GET /v1/gic/:id`)
Enables verification entities to query the gateway for a specific Green Impact Certificate. The gateway queries each online BPP sequentially and proxies the certificate payload once found.

---

## 🔐 Cryptography & Signature Middleware

The gateway enforces the standard Beckn cryptographic security profile using the `@carbon-dpi/beckn-adapter` library:
* **Inbound (BAP -> Gateway)**: Incoming payloads must contain valid `Authorization` and `Digest` headers signed by the BAP's private key. The gateway resolves the BAP's public key via environmental variables (`BECKN_BAP_PUBLIC_KEY`) to confirm payload integrity.
* **Outbound (Gateway -> BPP)**: When multicasting, the gateway signs the outgoing payloads with its own keypair (`BECKN_GATEWAY_PRIVATE_KEY`), ensuring verifiers can verify the gateway as the authentic proxy.

---

## ⚙️ Configuration & Environment

Create a `.env` file in the gateway root:

```env
PORT=3005
LOG_LEVEL="debug"
TRUST_REGISTRY_URL="http://localhost:3003"
REFERENCE_NODE_URL="http://localhost:3099" # Default fallback node URL
BECKN_GATEWAY_SUBSCRIBER_ID="gateway.carbon-dpi.in"
BECKN_GATEWAY_KEY_ID="gateway-key-1"
BECKN_GATEWAY_PRIVATE_KEY="..."  # Hex-encoded gateway private key
BECKN_BAP_PUBLIC_KEY="..."        # Public key of authorized BAP
CORS_ALLOWED_ORIGINS="http://localhost:3000,http://localhost:3001"
```

---

## 🛠️ Launch & Setup

### Direct Local Execution
Make sure you are in the gateway package folder:
```bash
npm run dev
```

### Docker
The service is automatically built and launched by the root `docker-compose.yml` file. It listens on port `3005`.
