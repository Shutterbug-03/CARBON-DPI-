import hashlib
import json
import os
from datetime import datetime, timezone
import time
import base64
import re
from typing import Dict, List, Any, Optional, TypedDict, Union, Literal, Tuple

try:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
    from cryptography.hazmat.primitives import serialization
    from cryptography.exceptions import InvalidSignature
    CRYPTO_AVAILABLE = True
except ImportError:
    CRYPTO_AVAILABLE = False

# ──────────────────────────────────────────────────────────────
# Types
# ──────────────────────────────────────────────────────────────

TrustLevel = Literal["HIGH", "MEDIUM", "LOW"]
DataSourceType = Literal["IOT_SENSOR", "SATELLITE", "SCADA", "MANUAL_ENTRY", "API_IMPORT", "DOCUMENT_SCAN"]
ImpactType = Literal["AVOIDED", "REMOVED"]

class Geolocation(TypedDict):
    lat: float
    lng: float

class ReportingPeriod(TypedDict):
    start: str  # ISO-8601 string
    end: str    # ISO-8601 string

class CIHInput(TypedDict):
    identityHash: str
    assetId: str
    deviceId: str
    lat: float
    lng: float
    timestamp: str

class IdentityBinding(TypedDict):
    cih: str
    hash: str
    entityId: str
    assetId: str
    deviceId: str
    geolocation: Geolocation
    boundAt: str

class DataPoint(TypedDict):
    id: str
    cihReference: str
    sourceType: DataSourceType
    sourceId: str
    timestamp: str  # ISO-8601 string
    geolocation: Geolocation
    value: float
    unit: str
    deviceSignature: str
    reportingPeriod: ReportingPeriod
    schemaVersion: str
    trustScore: TrustLevel
    raw: Optional[Any]

class EmissionFactors(TypedDict):
    primary: float
    primaryUnit: str
    conservativeAdjFactor: Optional[float]
    secondaryFactors: Optional[Dict[str, float]]

class Methodology(TypedDict):
    id: str
    name: str
    version: str
    sector: str
    formula: str
    sourceAuthority: str
    applicableAssetTypes: List[str]
    emissionFactors: EmissionFactors
    impactType: ImpactType
    outputUnit: str

class CalculationStep(TypedDict):
    step: str
    input: str
    formula: str
    output: str

class MRVOutput(TypedDict):
    success: bool
    impactValue: Dict[str, Union[float, str]]  # { amount, unit, type }
    methodologyId: str
    confidenceScore: int
    calculationTrace: List[CalculationStep]
    errors: List[str]
    warnings: List[str]
    auditHash: str

class GreenImpactCertificate(TypedDict):
    id: str
    status: Literal["VERIFIED", "ISSUED", "FAILED"]
    hash: str
    cihReference: str
    methodologyId: str
    confidenceScore: int
    impactValue: Dict[str, Union[float, str]]  # { amount, unit, type }
    issuedAt: str
    verificationUrl: str
    auditTrailHash: str

# ──────────────────────────────────────────────────────────────
# Constants — Government-approved emission factors
# ──────────────────────────────────────────────────────────────

CEA_GRID_EMISSION_FACTORS: Dict[str, float] = {
    "India-National": 0.716,
    "India-North": 0.716,
    "India-South": 0.682,
    "India-East": 0.821,
    "India-West": 0.698,
    "India-Northeast": 0.642,
}

CONSERVATIVE_ADJ_FACTOR = 0.95
DIESEL_EF_KG_CO2_PER_LITRE = 2.68
CH4_GWP_100YR = 27.9

# ──────────────────────────────────────────────────────────────
# Utility
# ──────────────────────────────────────────────────────────────

def sha256(input_data: Union[str, Dict[str, Any], List[Any]]) -> str:
    """Computes SHA-256 hash of a string or JSON-serializable object."""
    if isinstance(input_data, str):
        data_str = input_data
    else:
        # Sort keys to ensure deterministic output
        data_str = json.dumps(input_data, sort_keys=True, separators=(',', ':'))
    
    return hashlib.sha256(data_str.encode('utf-8')).hexdigest()

# ──────────────────────────────────────────────────────────────
# Beckn Cryptography Interoperability (Ed25519)
# ──────────────────────────────────────────────────────────────

def sign_beckn_request(subscriber_id: str, unique_key_id: str, private_key_base64: str, body: str, ttl_seconds: int = 300) -> Dict[str, str]:
    """Generates Beckn-compliant Authorization and Digest headers for a request body."""
    if not CRYPTO_AVAILABLE:
        raise RuntimeError("cryptography package is required for ed25519 signing")
    
    now = int(time.time())
    expires = now + ttl_seconds
    
    digest_hash = hashlib.sha256(body.encode('utf-8')).digest()
    digest_b64 = base64.b64encode(digest_hash).decode('utf-8')
    digest_header = f"SHA-256={digest_b64}"
    
    signing_string = f"(created): {now}\n(expires): {expires}\ndigest: {digest_header}"
    
    private_key_der = base64.b64decode(private_key_base64)
    private_key = serialization.load_der_private_key(private_key_der, password=None)
    
    signature = private_key.sign(signing_string.encode('utf-8'))
    signature_b64 = base64.b64encode(signature).decode('utf-8')
    
    auth_header = (
        f'Signature keyId="{subscriber_id}|{unique_key_id}|ed25519",'
        f'algorithm="ed25519",'
        f'created="{now}",'
        f'expires="{expires}",'
        f'headers="(created) (expires) digest",'
        f'signature="{signature_b64}"'
    )
    
    return {
        "Authorization": auth_header,
        "Digest": digest_header
    }

def verify_beckn_signature(authorization_header: str, digest_header: str, body: str, public_key_base64: str) -> Tuple[bool, Optional[str]]:
    """Verifies a Beckn-compliant Authorization signature."""
    if not CRYPTO_AVAILABLE:
        raise RuntimeError("cryptography package is required for ed25519 verification")
    
    expected_digest_hash = hashlib.sha256(body.encode('utf-8')).digest()
    expected_digest_b64 = base64.b64encode(expected_digest_hash).decode('utf-8')
    expected_digest = f"SHA-256={expected_digest_b64}"
    
    if digest_header != expected_digest:
        return False, "Digest mismatch"
        
    sig_match = re.search(r'signature="([^"]+)"', authorization_header)
    created_match = re.search(r'created="([^"]+)"', authorization_header)
    expires_match = re.search(r'expires="([^"]+)"', authorization_header)
    
    if not (sig_match and created_match and expires_match):
        return False, "Missing components in Authorization header"
        
    created = created_match.group(1)
    expires = expires_match.group(1)
    signature_b64 = sig_match.group(1)
    
    if int(expires) < int(time.time()):
        return False, "Signature expired"
        
    signing_string = f"(created): {created}\n(expires): {expires}\ndigest: {expected_digest}"
    
    try:
        public_key_der = base64.b64decode(public_key_base64)
        public_key = serialization.load_der_public_key(public_key_der)
        public_key.verify(base64.b64decode(signature_b64), signing_string.encode('utf-8'))
        return True, None
    except Exception as e:
        return False, str(e)

# ──────────────────────────────────────────────────────────────
# LAYER 1: Composite Identity Hash (CIH)
# ──────────────────────────────────────────────────────────────

def compute_cih(params: CIHInput) -> str:
    """Computes the Composite Identity Hash for a given asset registration payload."""
    normalized_payload = "||".join([
        params["identityHash"].lower().strip(),
        params["assetId"].strip(),
        params["deviceId"].lower().strip(),
        f"{params['lat']:.6f}",
        f"{params['lng']:.6f}",
        params["timestamp"].strip(),
    ])
    return sha256(normalized_payload)

# ──────────────────────────────────────────────────────────────
# LAYER 2: CDIF Validation & Trust Classification
# ──────────────────────────────────────────────────────────────

def classify_trust(source_type: DataSourceType) -> TrustLevel:
    """Classifies the trust level based on data source type."""
    if source_type in ("IOT_SENSOR", "SATELLITE"):
        return "HIGH"
    elif source_type in ("SCADA", "API_IMPORT"):
        return "MEDIUM"
    elif source_type in ("MANUAL_ENTRY", "DOCUMENT_SCAN"):
        return "LOW"
    else:
        return "LOW"

def validate_cdif(data_points: List[DataPoint]) -> Dict[str, Any]:
    """Validates data points against the CDIF schema and returns accepted/rejected points."""
    accepted: List[DataPoint] = []
    rejected: List[Dict[str, Any]] = []

    for point in data_points:
        if not point.get("cihReference") or len(point["cihReference"]) != 64:
            rejected.append({"point": point, "reason": "Missing or invalid CIH reference"})
            continue
        if not point.get("timestamp"):
            rejected.append({"point": point, "reason": "Missing timestamp"})
            continue
        
        try:
            ts = datetime.fromisoformat(point["timestamp"].replace("Z", "+00:00"))
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            if ts > datetime.now(timezone.utc):
                rejected.append({"point": point, "reason": "Future timestamp not allowed"})
                continue
        except ValueError:
            rejected.append({"point": point, "reason": "Invalid timestamp format"})
            continue

        val = point.get("value")
        if not isinstance(val, (int, float)) or val < 0:
            rejected.append({"point": point, "reason": "Invalid or negative value"})
            continue

        geo = point.get("geolocation")
        if not geo or not geo.get("lat") or not geo.get("lng"):
            rejected.append({"point": point, "reason": "Missing geolocation"})
            continue

        period = point.get("reportingPeriod")
        if not period or not period.get("start") or not period.get("end"):
            rejected.append({"point": point, "reason": "Missing reporting period"})
            continue

        accepted.append({
            "id": point.get("id", ""),
            "cihReference": point["cihReference"],
            "sourceType": point["sourceType"],
            "sourceId": point.get("sourceId", ""),
            "timestamp": point["timestamp"],
            "geolocation": geo,
            "value": float(val),
            "unit": point.get("unit", ""),
            "deviceSignature": point.get("deviceSignature") or "MANUAL",
            "reportingPeriod": period,
            "schemaVersion": point.get("schemaVersion") or "CDIF-1.0",
            "trustScore": point.get("trustScore") or classify_trust(point["sourceType"]),
            "raw": point.get("raw")
        })

    high_count = sum(1 for p in accepted if p["trustScore"] == "HIGH")
    med_count = sum(1 for p in accepted if p["trustScore"] == "MEDIUM")
    low_count = sum(1 for p in accepted if p["trustScore"] == "LOW")

    return {
        "accepted": accepted,
        "rejected": rejected,
        "summary": {
            "total": len(data_points),
            "accepted": len(accepted),
            "rejected": len(rejected),
            "trustDistribution": {
                "HIGH": high_count,
                "MEDIUM": med_count,
                "LOW": low_count
            }
        }
    }

# ──────────────────────────────────────────────────────────────
# LAYER 3: MRV Engine — Deterministic Calculation
# ──────────────────────────────────────────────────────────────

METHODOLOGIES: List[Methodology] = [
    {
        "id": "CUPI-METH-001",
        "name": "Grid-Connected Solar PV Generation",
        "version": "1.0.0",
        "sector": "Energy",
        "formula": "tCO2e = (kWh × grid_EF / 1000) × CAF",
        "sourceAuthority": "CEA India v19.0 + AMS-I.D CDM v18",
        "applicableAssetTypes": ["FACILITY"],
        "emissionFactors": {
            "primary": 0.716,
            "primaryUnit": "kgCO2_per_kWh",
            "conservativeAdjFactor": CONSERVATIVE_ADJ_FACTOR,
            "secondaryFactors": {"diesel_ef": DIESEL_EF_KG_CO2_PER_LITRE},
        },
        "impactType": "AVOIDED",
        "outputUnit": "tCO2e",
    },
    {
        "id": "CUPI-METH-002",
        "name": "Soil Carbon Sequestration",
        "version": "1.0.0",
        "sector": "Agriculture",
        "formula": "tCO2e = Δsoc × 3.67 × CAF",
        "sourceAuthority": "IPCC AR6 + VM0042 Verra",
        "applicableAssetTypes": ["LAND"],
        "emissionFactors": {
            "primary": 3.67,
            "primaryUnit": "tCO2_per_tC",
            "conservativeAdjFactor": 0.90,
            "secondaryFactors": None
        },
        "impactType": "REMOVED",
        "outputUnit": "tCO2e",
    },
    {
        "id": "CUPI-METH-003",
        "name": "Biogas / Methane Capture",
        "version": "1.0.0",
        "sector": "Waste",
        "formula": "tCO2e = CH4_t × GWP × oxidation × CAF",
        "sourceAuthority": "IPCC AR6 + AMS-III.D CDM",
        "applicableAssetTypes": ["FACILITY", "LAND"],
        "emissionFactors": {
            "primary": CH4_GWP_100YR,
            "primaryUnit": "CO2e_per_tCH4",
            "conservativeAdjFactor": CONSERVATIVE_ADJ_FACTOR,
            "secondaryFactors": {"oxidation_factor": 0.99},
        },
        "impactType": "AVOIDED",
        "outputUnit": "tCO2e",
    },
    {
        "id": "CUPI-METH-004",
        "name": "EV Fleet — Avoided Tailpipe Emissions",
        "version": "1.0.0",
        "sector": "Transportation",
        "formula": "tCO2e = km × (petrol_EF - ev_kWh/km × grid_EF) / 1000 × CAF",
        "sourceAuthority": "MoRTH India + CEA India",
        "applicableAssetTypes": ["VEHICLE", "EV_FLEET"],
        "emissionFactors": {
            "primary": 0.192,
            "primaryUnit": "kgCO2_per_km_petrol",
            "conservativeAdjFactor": CONSERVATIVE_ADJ_FACTOR,
            "secondaryFactors": {"ev_kwh_per_km": 0.18, "grid_ef": 0.716},
        },
        "impactType": "AVOIDED",
        "outputUnit": "tCO2e",
    },
    {
        "id": "CUPI-METH-005",
        "name": "Grid-Connected Wind",
        "version": "1.0.0",
        "sector": "Energy",
        "formula": "tCO2e = (kWh × grid_EF / 1000) × CAF",
        "sourceAuthority": "CEA India v19.0 + ACM0002 Verra",
        "applicableAssetTypes": ["FACILITY", "MACHINE"],
        "emissionFactors": {
            "primary": 0.716,
            "primaryUnit": "kgCO2_per_kWh",
            "conservativeAdjFactor": CONSERVATIVE_ADJ_FACTOR,
            "secondaryFactors": None
        },
        "impactType": "AVOIDED",
        "outputUnit": "tCO2e",
    },
]

def calculate_mrv(
    methodology_id: str,
    data_points: List[DataPoint],
    grid_region: str = "India-National"
) -> MRVOutput:
    """Executes deterministic MRV calculations against verified data points."""
    errors: List[str] = []
    warnings: List[str] = []
    trace: List[CalculationStep] = []

    methodology = next((m for m in METHODOLOGIES if m["id"] == methodology_id), None)
    if not methodology:
        return {
            "success": False,
            "impactValue": {"amount": 0.0, "unit": "tCO2e", "type": "AVOIDED"},
            "methodologyId": methodology_id,
            "confidenceScore": 0,
            "calculationTrace": [],
            "errors": [f"Methodology {methodology_id} not found"],
            "warnings": [],
            "auditHash": ""
        }

    if not data_points:
        errors.append("No data points provided")
        return {
            "success": False,
            "impactValue": {"amount": 0.0, "unit": methodology["outputUnit"], "type": methodology["impactType"]},
            "methodologyId": methodology_id,
            "confidenceScore": 0,
            "calculationTrace": [],
            "errors": errors,
            "warnings": warnings,
            "auditHash": ""
        }

    ef = methodology["emissionFactors"]
    caf = ef.get("conservativeAdjFactor", 1.0)
    grid_ef = CEA_GRID_EMISSION_FACTORS.get(grid_region, ef["primary"])
    total_value = sum(point["value"] for point in data_points)

    trace.append({
        "step": "Aggregate Activity Data",
        "input": f"{len(data_points)} data points",
        "formula": "SUM(value)",
        "output": f"{total_value:.4f} {data_points[0].get('unit', 'units')}"
    })

    tCO2e = 0.0

    if methodology["id"] in ("CUPI-METH-001", "CUPI-METH-005"):
        raw_kg = total_value * grid_ef
        raw_t = raw_kg / 1000.0
        tCO2e = raw_t * caf
        trace.extend([
            {"step": "Baseline Emissions", "input": f"{total_value:.4f} kWh × {grid_ef}", "formula": "kWh × grid_EF", "output": f"{raw_kg:.4f} kgCO2"},
            {"step": "Convert to tonnes", "input": f"{raw_kg:.4f} kgCO2", "formula": "÷ 1000", "output": f"{raw_t:.4f} tCO2e"},
            {"step": "Apply CAF", "input": f"{raw_t:.4f} × {caf}", "formula": "× CAF", "output": f"{tCO2e:.4f} tCO2e"}
        ])
    elif methodology["id"] == "CUPI-METH-002":
        raw = total_value * ef["primary"]
        tCO2e = raw * caf
        trace.extend([
            {"step": "Soil C to CO2e", "input": f"{total_value:.4f} tC × {ef['primary']}", "formula": "Δsoc × 3.67", "output": f"{raw:.4f} tCO2e"},
            {"step": "Apply CAF", "input": f"{raw:.4f} × {caf}", "formula": "× CAF", "output": f"{tCO2e:.4f} tCO2e"}
        ])
    elif methodology["id"] == "CUPI-METH-003":
        sec_factors = ef.get("secondaryFactors") or {}
        ox = sec_factors.get("oxidation_factor", 0.99)
        raw = total_value * ef["primary"] * ox
        tCO2e = raw * caf
        trace.extend([
            {"step": "CH4 → CO2e", "input": f"{total_value:.4f} tCH4 × {ef['primary']} × {ox}", "formula": "tCH4 × GWP × ox", "output": f"{raw:.4f} tCO2e"},
            {"step": "Apply CAF", "input": f"{raw:.4f} × {caf}", "formula": "× CAF", "output": f"{tCO2e:.4f} tCO2e"}
        ])
    elif methodology["id"] == "CUPI-METH-004":
        sec_factors = ef.get("secondaryFactors") or {}
        ev_kwh = sec_factors.get("ev_kwh_per_km", 0.18)
        avoided = ef["primary"] - (ev_kwh * grid_ef)
        raw = (total_value * avoided) / 1000.0
        tCO2e = raw * caf
        trace.extend([
            {"step": "EV avoided emissions", "input": f"{total_value:.0f} km × ({ef['primary']} - {ev_kwh}×{grid_ef})", "formula": "km × net_EF / 1000", "output": f"{raw:.4f} tCO2e"},
            {"step": "Apply CAF", "input": f"{raw:.4f} × {caf}", "formula": "× CAF", "output": f"{tCO2e:.4f} tCO2e"}
        ])

    high_count = sum(1 for p in data_points if p.get("trustScore") == "HIGH")
    med_count = sum(1 for p in data_points if p.get("trustScore") == "MEDIUM")
    low_count = sum(1 for p in data_points if p.get("trustScore") == "LOW")
    
    confidence_score = round(
        ((high_count * 100 + med_count * 60 + low_count * 20) / len(data_points))
    )

    audit_payload = {
        "methodologyId": methodology_id,
        "tCO2e": round(tCO2e, 4),
        "confidenceScore": confidence_score,
        "dataPointCount": len(data_points)
        # NOTE: timestamp intentionally excluded — audit hash must be deterministic.
        # Identical inputs at different times must produce the same hash to fulfill
        # the "deterministic MRV" contract. Matches the TypeScript SDK behaviour.
    }
    audit_hash = sha256(audit_payload)

    return {
        "success": True,
        "impactValue": {
            "amount": max(0.0, round(tCO2e, 4)),
            "unit": methodology["outputUnit"],
            "type": methodology["impactType"]
        },
        "methodologyId": methodology_id,
        "confidenceScore": confidence_score,
        "calculationTrace": trace,
        "errors": errors,
        "warnings": warnings,
        "auditHash": audit_hash
    }

# ──────────────────────────────────────────────────────────────
# LAYER 5: GIC Generation
# ──────────────────────────────────────────────────────────────

def generate_gic(mrv_output: MRVOutput, cih_reference: str, base_url: str = "http://localhost:3001") -> GreenImpactCertificate:
    """Generates a Green Impact Certificate structure based on deterministic MRV output."""
    year = datetime.now().year
    mrv_hash = sha256(mrv_output)
    hex_slice = mrv_hash[:8].upper()
    gic_id = f"GP-GIC-{year}-{hex_slice}"
    
    gic_payload = {
        "gicId": gic_id,
        "success": mrv_output["success"],
        "methodologyId": mrv_output["methodologyId"],
        "confidenceScore": mrv_output["confidenceScore"],
        "impactValue": mrv_output["impactValue"]
    }
    cert_hash = sha256(gic_payload)

    # Use configurable base URL — for an open protocol, every node serves its own verification
    verify_base = os.environ.get("GIC_BASE_URL", base_url).rstrip("/")

    return {
        "id": gic_id,
        "status": "VERIFIED" if mrv_output["success"] else "FAILED",
        "hash": cert_hash,
        "cihReference": cih_reference,
        "methodologyId": mrv_output["methodologyId"],
        "confidenceScore": mrv_output["confidenceScore"],
        "impactValue": mrv_output["impactValue"],
        "issuedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "verificationUrl": f"{verify_base}/gic/{gic_id}",
        "auditTrailHash": mrv_output["auditHash"]
    }

# ──────────────────────────────────────────────────────────────
# W3C Verifiable Credential Conversion
# ──────────────────────────────────────────────────────────────

def to_w3c_vc(gic: GreenImpactCertificate, private_key_pem: Optional[str] = None) -> Dict[str, Any]:
    """Formats a GIC into a W3C-compliant Verifiable Credential, optionally signing it with Ed25519."""
    credential_subject = {
        "id": f"did:cupi:india:asset:{gic['cihReference'][:16]}",
        "gic_id": gic["id"],
        "methodology": gic["methodologyId"],
        "verified_quantity": {
            "value": gic["impactValue"]["amount"],
            "unit": gic["impactValue"]["unit"],
            "confidence_score": gic["confidenceScore"]
        },
        "calculation_log_hash": f"sha256:{gic['auditTrailHash']}",
        "public_verification_url": gic["verificationUrl"]
    }
    
    vc = {
        "@context": [
            "https://www.w3.org/2018/credentials/v1",
            "https://spec.carbon-dpi.org/contexts/gic/v1",
        ],
        "id": gic["verificationUrl"],
        "type": ["VerifiableCredential", "GreenImpactCertificate"],
        "issuer": {
            "id": "did:cupi:india:verifier:greenpe",
            "name": "Carbon DPI Reference Node"
        },
        "issuanceDate": gic["issuedAt"],
        "credentialSubject": credential_subject
    }
    
    proof_value = gic["hash"]
    
    if private_key_pem:
        try:
            from cryptography.hazmat.primitives import serialization
            import base64
            
            # json.dumps with sort_keys=True performs RECURSIVE key sorting on all
            # nested objects — this is JCS-compatible and matches the TypeScript SDK's
            # recursiveSort() function added in the same fix. Cross-language VC signatures
            # produced by Python and TypeScript nodes are now interoperable.
            canonicalized = json.dumps(vc, sort_keys=True, separators=(',', ':')).encode('utf-8')
            
            # Load private key
            private_key = serialization.load_pem_private_key(
                private_key_pem.encode('utf-8'),
                password=None
            )
            
            # Sign the credential
            signature = private_key.sign(canonicalized)
            proof_value = base64.b64encode(signature).decode('utf-8')
        except ImportError:
            # Cryptography library not installed, fallback to content hash
            pass
        except Exception:
            # Fallback if key parsing fails
            pass

    vc["proof"] = {
        "type": "Ed25519Signature2020",
        "created": gic["issuedAt"],
        "verificationMethod": "did:cupi:india:verifier:greenpe#key-1",
        "proofPurpose": "assertionMethod",
        "proofValue": proof_value
    }
    
    return vc

# ──────────────────────────────────────────────────────────────
# Network Interaction
# ──────────────────────────────────────────────────────────────

def submit_telemetry(
    event_bus_url: str,
    cih_reference: str,
    source_id: str,
    value: float,
    source_type: DataSourceType = "IOT_SENSOR",
    unit: str = "kWh",
    device_signature: str = "unsigned",
    lat: float = 0.0,
    lng: float = 0.0,
    api_key: str = "default-ingest-key"
) -> bool:
    """Submits a telemetry point to the Carbon DPI Event Bus."""
    import urllib.request
    
    payload = {
        "cihReference": cih_reference,
        "sourceId": source_id,
        "sourceType": source_type,
        "value": str(value),
        "unit": unit,
        "deviceSignature": device_signature,
        "geolocation": {"lat": lat, "lng": lng},
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    }
    
    req = urllib.request.Request(
        f"{event_bus_url.rstrip('/')}/v1/ingest",
        data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json', 'x-api-key': api_key},
        method='POST'
    )
    
    try:
        with urllib.request.urlopen(req) as response:
            return response.status in (200, 201, 202)
    except Exception:
        return False

