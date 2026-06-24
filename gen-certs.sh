#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# Carbon DPI — Internal mTLS Certificate Generator
#
# Generates a private CA + per-service client/server certificate pairs for
# mutual TLS between Carbon DPI services (Registry, Reference Node, Gateway,
# Event Bus). These are used when INTERNAL_TLS=true in docker-compose.
#
# Usage:
#   chmod +x gen-certs.sh
#   ./gen-certs.sh
#
# Output: ./certs/internal/
#   ca.crt            — Shared CA certificate (trusted by all services)
#   ca.key            — CA private key (keep secret, not mounted to containers)
#   {service}.crt     — Per-service TLS certificate
#   {service}.key     — Per-service TLS private key
#
# IMPORTANT: For production, replace these with certificates from a proper PKI
# (Vault, AWS ACM PCA, or your organization's CA).
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

CERTS_DIR="$(dirname "$0")/certs/internal"
mkdir -p "$CERTS_DIR"

SERVICES=("registry" "node" "gateway" "event-bus")
VALIDITY_DAYS=365

echo "🔐 Generating Carbon DPI internal mTLS certificates..."
echo "   Output: $CERTS_DIR"
echo ""

# ── Step 1: Generate CA key + self-signed certificate ─────────────────────────
if [ ! -f "$CERTS_DIR/ca.key" ]; then
  echo "  [1/3] Generating CA key..."
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 \
    -out "$CERTS_DIR/ca.key" 2>/dev/null

  echo "  [2/3] Generating CA certificate..."
  openssl req -new -x509 -key "$CERTS_DIR/ca.key" \
    -out "$CERTS_DIR/ca.crt" \
    -days $VALIDITY_DAYS \
    -subj "/C=IN/O=Carbon DPI/CN=Carbon DPI Internal CA" \
    -extensions v3_ca 2>/dev/null

  echo "  ✅ CA certificate created (valid ${VALIDITY_DAYS} days)"
else
  echo "  ℹ️  CA key already exists, skipping CA generation"
fi

echo ""

# ── Step 2: Generate per-service certificates ─────────────────────────────────
for SERVICE in "${SERVICES[@]}"; do
  CERT_FILE="$CERTS_DIR/${SERVICE}.crt"
  KEY_FILE="$CERTS_DIR/${SERVICE}.key"
  CSR_FILE="$CERTS_DIR/${SERVICE}.csr"

  if [ -f "$CERT_FILE" ]; then
    echo "  ⏭️  ${SERVICE}: certificate already exists, skipping"
    continue
  fi

  echo "  [3/3] Generating ${SERVICE} certificate..."

  # Generate private key
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 \
    -out "$KEY_FILE" 2>/dev/null

  # Create CSR with SAN for both service name and localhost
  openssl req -new -key "$KEY_FILE" \
    -out "$CSR_FILE" \
    -subj "/C=IN/O=Carbon DPI/CN=cdpi-${SERVICE}" 2>/dev/null

  # Sign with our CA, adding SANs
  openssl x509 -req -in "$CSR_FILE" \
    -CA "$CERTS_DIR/ca.crt" \
    -CAkey "$CERTS_DIR/ca.key" \
    -CAcreateserial \
    -out "$CERT_FILE" \
    -days $VALIDITY_DAYS \
    -extfile <(printf "subjectAltName=DNS:cdpi-%s,DNS:%s,DNS:localhost,IP:127.0.0.1\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth,clientAuth" "$SERVICE" "$SERVICE") \
    2>/dev/null

  rm -f "$CSR_FILE"
  echo "  ✅ ${SERVICE}: certificate created"
done

# ── Step 3: Set secure permissions ────────────────────────────────────────────
chmod 600 "$CERTS_DIR"/*.key
chmod 644 "$CERTS_DIR"/*.crt
echo ""
echo "🔒 Permissions set (keys: 600, certs: 644)"
echo ""
echo "To enable internal mTLS, add to your .env:"
echo "  INTERNAL_TLS=true"
echo ""
echo "Certificates in: $CERTS_DIR"
echo ""
echo "⚠️  Remember:"
echo "  - Keep ca.key SECRET — it is not mounted into containers"
echo "  - Rotate certificates before expiry (${VALIDITY_DAYS} days)"
echo "  - For production, use a proper PKI (HashiCorp Vault, AWS ACM PCA, etc.)"
