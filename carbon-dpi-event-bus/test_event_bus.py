#!/usr/bin/env python3
import json
import urllib.request
import urllib.error
import time
import hashlib
from datetime import datetime, timezone

REGISTRY_BASE = "http://localhost:3003"
NODE_BASE = "http://localhost:3099"
EVBUS_BASE = "http://localhost:3004"

CIH = hashlib.sha256(b"did:cdpi:india:solar:TEST-DEVICE-001").hexdigest()

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
print("  Carbon DPI — Event Bus Integration Test")
print("═" * 65)

# 1. Register Device in Trust Registry
print("\n▶ 1. Registering Device in Trust Registry (if not exists)")
resp, status = post(REGISTRY_BASE, "/registry/devices", {
    "cihReference": CIH,
    "sourceType": "IOT_SENSOR",
    "sourceId": "TEST-INV-001",
    "publicKeyBase64": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE+...",
    "geolocation": {"lat": 28.7041, "lng": 77.1025}
})
if status == 201:
    print(f"  {PASS} Device registered/ready: CIH={CIH[:16]}...")

# 2. Ingest telemetry bursts
print("\n▶ 2. Simulating High-Throughput IoT Burst (5 data points rapidly)")
success_count = 0
for i in range(5):
    resp, status = post(EVBUS_BASE, "/ingest", {
        "cihReference": CIH,
        "sourceType": "IOT_SENSOR",
        "sourceId": "TEST-INV-001",
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "geolocation": {"lat": 28.7041, "lng": 77.1025},
        "value": 25.5 + i,  # slight variation
        "unit": "kWh",
        "deviceSignature": f"sig-burst-{i}"
    })
    if status == 202:
        success_count += 1

print(f"  {PASS if success_count == 5 else FAIL} Successfully queued {success_count}/5 data points to the Event Bus.")

# 3. Wait for Event Bus to flush the batch
print("\n▶ 3. Waiting 6 seconds for Event Bus to batch and orchestrate Beckn flow...")
for i in range(6):
    time.sleep(1)
    print(f"  ... {6-i}s remaining", end="\r")
print("  ... Done waiting.       ")

# 4. Check Event Bus Heartbeat to ensure buffer is empty (flushed)
resp, status = get(EVBUS_BASE, "/heartbeat")
buf_size = resp.get("bufferSize", -1)
if buf_size == 0:
    print(f"  {PASS} Event Bus buffer is empty (flushed successfully).")
else:
    print(f"  {FAIL} Event Bus buffer not empty! size={buf_size}")

print("\n(Check the Event Bus console logs to verify the Beckn API calls were successful.)")
print("═" * 65)
