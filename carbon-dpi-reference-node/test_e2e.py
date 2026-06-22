#!/usr/bin/env python3
"""
Carbon DPI — End-to-End Beckn Flow Test
Simulates a complete BAP→BPP transaction: search → select → init → confirm
then verifies transaction state and tests cancel/edge-cases.
"""
import json
import uuid
import urllib.request
import urllib.error
import sys
import hashlib
from datetime import datetime, timezone

BASE = "http://localhost:3099"
TX_ID = f"e2e-{uuid.uuid4().hex[:12]}"
CIH   = hashlib.sha256(b"did:cdpi:india:solar:SURYA-GJ-001-test").hexdigest()

PASS = "\033[92m✅\033[0m"
FAIL = "\033[91m❌\033[0m"
INFO = "\033[94mℹ\033[0m"

results = {}


def ts():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def post(path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())


def get(path):
    try:
        with urllib.request.urlopen(f"{BASE}{path}", timeout=10) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())


def ctx(action, msg_id=""):
    return {
        "domain": "deg:climate-verification",
        "action": action,
        "version": "1.1.0",
        "bap_id": "test-bap",
        "bap_uri": BASE,
        "bpp_id": "carbon-dpi-bpp",
        "bpp_uri": BASE,
        "transaction_id": TX_ID,
        "message_id": msg_id or str(uuid.uuid4()),
        "city": "std:080",
        "country": "IND",
        "core_version": "1.1.0",
        "timestamp": ts(),
    }


def check(label, response, expected_status="ACK"):
    status = response.get("message", {}).get("ack", {}).get("status", "")
    ok = status == expected_status
    icon = PASS if ok else FAIL
    print(f"  {icon} {label}: {status or json.dumps(response)[:120]}")
    results[label] = ok
    return ok


# ─────────────────────────────────────────────────────────────────────────────
print("═" * 65)
print(f"  Carbon DPI — End-to-End Beckn Flow Test")
print(f"  TX ID : {TX_ID}")
print(f"  Base  : {BASE}")
print("═" * 65)

# 1. Heartbeat
print(f"\n{INFO} Infrastructure")
hb = get("/heartbeat")
print(f"  {PASS if hb.get('status')=='UP' else FAIL} GET /heartbeat  → {hb.get('status')}")
results["heartbeat"] = hb.get("status") == "UP"

st = get("/status")
methods = st.get("registeredMethodologies", [])
print(f"  {PASS if len(methods) >= 5 else FAIL} GET /status     → {len(methods)} methodologies: {', '.join(methods)}")
results["status"] = len(methods) >= 5

# 2. Search
print(f"\n{INFO} Beckn Flow: TX={TX_ID[:20]}...")
resp = post("/search", {
    "context": ctx("search"),
    "message": {
        "intent": {
            "category": {"descriptor": {"name": "Energy"}}
        }
    }
})
check("POST /search", resp)

# 3. Select with CDIF data
CDIF_DATA = [
    {
        "id": "dp-001",
        "cihReference": CIH,
        "sourceType": "IOT_SENSOR",
        "sourceId": "INV-GJ-001",
        "timestamp": "2026-01-01T23:59:59Z",
        "geolocation": {"lat": 22.3039, "lng": 70.8022},
        "value": 1850.5,
        "unit": "kWh",
        "deviceSignature": "ECDSA-SIG-abc123",
        "reportingPeriod": {
            "start": "2026-01-01T00:00:00Z",
            "end": "2026-01-01T23:59:59Z",
        },
        "schemaVersion": "CDIF-1.0",
        "trustScore": "HIGH",
    },
    {
        "id": "dp-002",
        "cihReference": CIH,
        "sourceType": "IOT_SENSOR",
        "sourceId": "INV-GJ-001",
        "timestamp": "2026-01-02T23:59:59Z",
        "geolocation": {"lat": 22.3039, "lng": 70.8022},
        "value": 1910.2,
        "unit": "kWh",
        "deviceSignature": "ECDSA-SIG-def456",
        "reportingPeriod": {
            "start": "2026-01-02T00:00:00Z",
            "end": "2026-01-02T23:59:59Z",
        },
        "schemaVersion": "CDIF-1.0",
        "trustScore": "HIGH",
    },
    {
        "id": "dp-003",
        "cihReference": CIH,
        "sourceType": "SATELLITE",
        "sourceId": "NASA-POWER",
        "timestamp": "2026-01-03T23:59:59Z",
        "geolocation": {"lat": 22.3039, "lng": 70.8022},
        "value": 1780.3,
        "unit": "kWh",
        "deviceSignature": "NASA-SIG-xyz789",
        "reportingPeriod": {
            "start": "2026-01-03T00:00:00Z",
            "end": "2026-01-03T23:59:59Z",
        },
        "schemaVersion": "CDIF-1.0",
        "trustScore": "MEDIUM",
    },
]

resp = post("/select", {
    "context": ctx("select"),
    "message": {
        "order": {
            "items": [{"id": "CUPI-METH-001"}],
            "xinput": {"dataPoints": CDIF_DATA},
        }
    },
})
check("POST /select (3 CDIF pts)", resp)

# 4. Init
resp = post("/init", {
    "context": ctx("init"),
    "message": {
        "order": {
            "items": [{"id": "CUPI-METH-001"}],
            "provider": {"id": "carbon-dpi-bpp"},
        }
    },
})
check("POST /init", resp)

# 5. Confirm — MRV + GIC
resp = post("/confirm", {
    "context": ctx("confirm"),
    "message": {
        "order": {
            "items": [{"id": "CUPI-METH-001"}],
            "provider": {"id": "carbon-dpi-bpp"},
        }
    },
})
check("POST /confirm (MRV+GIC)", resp)

# 6. Transaction state
tx_state = get(f"/transaction/{TX_ID}")
gic_issued = tx_state.get("status") == "CONFIRMED"
print(f"  {PASS if gic_issued else FAIL} GET /transaction/{TX_ID[:16]}... → status={tx_state.get('status')}")
results["transaction_state"] = gic_issued

# 7. Callback receivers (on_* endpoints)
print(f"\n{INFO} Callback Receivers (on_* endpoints)")
for action in ["on_search", "on_select", "on_init", "on_confirm", "on_cancel"]:
    r = post(f"/{action}", {"context": ctx(action), "message": {"catalog": {}}})
    ack = r.get("message", {}).get("ack", {}).get("status", "")
    print(f"  {PASS if ack=='ACK' else FAIL} POST /{action} → {ack}")
    results[action] = ack == "ACK"

# 8. Cancel a fresh transaction (can't cancel CONFIRMED)
print(f"\n{INFO} Edge Cases")
TX2 = f"cancel-test-{uuid.uuid4().hex[:8]}"
ctx2 = lambda a: {**ctx(a), "transaction_id": TX2}

# First do a search to create the transaction
post("/search", {"context": ctx2("search"), "message": {}})
resp = post("/cancel", {"context": ctx2("cancel")})
check("POST /cancel (fresh tx)", resp)

# Try to cancel already-confirmed
resp = post("/cancel", {"context": ctx("cancel")})
check("POST /cancel (CONFIRMED = NACK)", resp, expected_status="NACK")

# 404 on unknown tx
tx_404 = get("/transaction/nonexistent-tx-id-xyz")
print(f"  {PASS if 'error' in tx_404 else FAIL} GET /transaction/nonexistent → {tx_404.get('error','?')}")
results["tx_404"] = "error" in tx_404

# ─────────────────────────────────────────────────────────────────────────────
print("\n" + "═" * 65)
passed = sum(1 for v in results.values() if v)
total  = len(results)
pct    = int(passed / total * 100)

print(f"  Results: {passed}/{total} passed ({pct}%)")
for name, ok in results.items():
    print(f"    {'✅' if ok else '❌'}  {name}")

if passed == total:
    print("\n  🎉  ALL TESTS PASSED — Carbon DPI Beckn BPP is FUNCTIONAL")
else:
    print(f"\n  ⚠️   {total-passed} test(s) failed")
print("═" * 65)

sys.exit(0 if passed == total else 1)
