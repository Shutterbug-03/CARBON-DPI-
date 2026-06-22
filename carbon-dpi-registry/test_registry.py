#!/usr/bin/env python3
import json
import uuid
import urllib.request
import urllib.error
import sys
import hashlib
from datetime import datetime, timezone

REGISTRY_BASE = "http://localhost:3003"
NODE_BASE = "http://localhost:3099"

CIH = hashlib.sha256(b"did:cdpi:india:solar:TEST-DEVICE-001").hexdigest()
TX_ID = f"e2e-reg-{uuid.uuid4().hex[:8]}"

PASS = "\033[92m✅\033[0m"
FAIL = "\033[91m❌\033[0m"

def post(base, path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{base}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read()), r.status
    except urllib.error.HTTPError as e:
        return json.loads(e.read()), e.code
    except Exception as e:
        return {"error": str(e)}, 500

def get(base, path):
    try:
        with urllib.request.urlopen(f"{base}{path}", timeout=10) as r:
            return json.loads(r.read()), r.status
    except urllib.error.HTTPError as e:
        return json.loads(e.read()), e.code
    except Exception as e:
        return {"error": str(e)}, 500

print("═" * 65)
print("  Carbon DPI — Trust Registry Integration Test")
print("═" * 65)

# 1. Register Device
print("\n▶ 1. Register Device in Trust Registry")
resp, status = post(REGISTRY_BASE, "/registry/devices", {
    "cihReference": CIH,
    "sourceType": "IOT_SENSOR",
    "sourceId": "TEST-INV-001",
    "publicKeyBase64": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE+...",
    "geolocation": {"lat": 28.7041, "lng": 77.1025}
})
if status == 201:
    print(f"  {PASS} Device registered: CIH={CIH[:16]}...")
else:
    print(f"  {FAIL} Failed to register device: {resp}")

# 2. Check Device
print("\n▶ 2. Verify Device exists in Registry")
resp, status = get(REGISTRY_BASE, f"/registry/devices/{CIH}")
if status == 200 and resp.get("cihReference") == CIH:
    print(f"  {PASS} Device retrieved successfully")
else:
    print(f"  {FAIL} Failed to retrieve device: {resp}")

# 3. Test BPP /select with the registered CIH
print("\n▶ 3. POST /select to Reference Node (should pass)")
resp, status = post(NODE_BASE, "/select", {
    "context": {
        "domain": "deg:climate-verification",
        "action": "select",
        "version": "1.1.0",
        "bap_id": "test-bap",
        "bap_uri": "http://localhost",
        "bpp_id": "carbon-dpi-bpp",
        "bpp_uri": "http://localhost",
        "transaction_id": TX_ID,
        "message_id": "msg-1",
        "city": "std:080",
        "country": "IND",
        "core_version": "1.1.0",
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    },
    "message": {
        "order": {
            "items": [{"id": "CUPI-METH-001"}],
            "xinput": {
                "dataPoints": [
                    {
                        "id": "dp-1",
                        "cihReference": CIH,
                        "sourceType": "IOT_SENSOR",
                        "sourceId": "TEST-INV-001",
                        "timestamp": "2026-01-01T12:00:00Z",
                        "geolocation": {"lat": 28.7, "lng": 77.1},
                        "value": 100,
                        "unit": "kWh",
                        "deviceSignature": "sig-123",
                        "reportingPeriod": {"start": "2026-01-01T00:00:00Z", "end": "2026-01-01T23:59:59Z"}
                    }
                ]
            }
        }
    }
})

ack = resp.get("message", {}).get("ack", {}).get("status")
if ack == "ACK":
    print(f"  {PASS} /select succeeded! Reference Node verified device in Trust Registry.")
else:
    print(f"  {FAIL} /select failed: {resp}")

# 4. Test BPP /select with UNREGISTERED CIH
print("\n▶ 4. POST /select to Reference Node with Unregistered CIH (should fail)")
FAKE_CIH = hashlib.sha256(b"fake").hexdigest()
resp, status = post(NODE_BASE, "/select", {
    "context": {
        "domain": "deg:climate-verification",
        "action": "select",
        "version": "1.1.0",
        "bap_id": "test-bap",
        "bap_uri": "http://localhost",
        "bpp_id": "carbon-dpi-bpp",
        "bpp_uri": "http://localhost",
        "transaction_id": TX_ID,
        "message_id": "msg-2",
        "city": "std:080",
        "country": "IND",
        "core_version": "1.1.0",
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    },
    "message": {
        "order": {
            "items": [{"id": "CUPI-METH-001"}],
            "xinput": {
                "dataPoints": [
                    {
                        "id": "dp-2",
                        "cihReference": FAKE_CIH,
                        "sourceType": "IOT_SENSOR",
                        "sourceId": "TEST-INV-001",
                        "timestamp": "2026-01-01T12:00:00Z",
                        "geolocation": {"lat": 28.7, "lng": 77.1},
                        "value": 100,
                        "unit": "kWh",
                        "deviceSignature": "sig-123",
                        "reportingPeriod": {"start": "2026-01-01T00:00:00Z", "end": "2026-01-01T23:59:59Z"}
                    }
                ]
            }
        }
    }
})

ack = resp.get("message", {}).get("ack", {}).get("status")
if ack == "NACK":
    error_msg = resp.get("message", {}).get("ack", {}).get("error", {}).get("message", "")
    print(f"  {PASS} /select rejected properly: {error_msg}")
else:
    print(f"  {FAIL} /select should have failed but got: {resp}")

print("═" * 65)
