# Climate DID Method Specification

**Method Name:** `cupi`  
**Version:** 1.0.0-draft  
**Status:** Draft  
**Authors:** GreenPe Technologies  
**Specification:** W3C DID Core v1.0 compliant  

---

## 1. Introduction

The `did:cupi` method defines how Decentralised Identifiers are created, resolved, and managed for climate actors and assets within the Carbon DPI protocol. Every climate actor — enterprises, farmers, assets, projects, verifiers — is assigned a globally unique, self-sovereign identifier that does not depend on any centralised registry.

## 2. Method Syntax

```
did:cupi:<country>:<asset_type>:<local_identifier>
```

### Components

| Component | Description | Examples |
|---|---|---|
| `country` | ISO 3166-1 alpha-3 lowercase | `india`, `usa`, `bra` |
| `asset_type` | Climate actor/asset category | `solar`, `enterprise`, `ev_fleet`, `farmer`, `forest`, `verifier`, `biogas`, `wind` |
| `local_identifier` | Locally unique ID | GSTIN, registration number, or generated hash |

### Examples

```
did:cupi:india:solar:GP-IND-2024-GJ-044821-SOL
did:cupi:india:enterprise:GSTIN-24AADCS7412M1Z8
did:cupi:india:ev_fleet:TATA-FLEET-BLR-2024-0221
did:cupi:india:forest:MH-JFMC-NASIK-2024-0033
did:cupi:india:farmer:PMKUSUM-RAJ-BARMER-2024-1122
did:cupi:india:verifier:greenpe
did:cupi:india:biogas:CBG-MH-PUNE-2024-0088
```

## 3. DID Document

A `did:cupi` DID Document follows the W3C DID Core data model:

```json
{
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://spec.carbon-dpi.org/contexts/did/v1"
  ],
  "id": "did:cupi:india:solar:GP-IND-2024-GJ-044821-SOL",
  "controller": "did:cupi:india:enterprise:GSTIN-24AADCS7412M1Z8",
  "verificationMethod": [
    {
      "id": "did:cupi:india:solar:GP-IND-2024-GJ-044821-SOL#key-1",
      "type": "Ed25519VerificationKey2020",
      "controller": "did:cupi:india:solar:GP-IND-2024-GJ-044821-SOL",
      "publicKeyMultibase": "z6Mkf5rGMoatrSj1f..."
    }
  ],
  "authentication": [
    "did:cupi:india:solar:GP-IND-2024-GJ-044821-SOL#key-1"
  ],
  "assertionMethod": [
    "did:cupi:india:solar:GP-IND-2024-GJ-044821-SOL#key-1"
  ],
  "service": [
    {
      "id": "did:cupi:india:solar:GP-IND-2024-GJ-044821-SOL#verification",
      "type": "ClimateVerificationService",
      "serviceEndpoint": "https://verify.greenpe.in/did/did:cupi:india:solar:GP-IND-2024-GJ-044821-SOL"
    },
    {
      "id": "did:cupi:india:solar:GP-IND-2024-GJ-044821-SOL#events",
      "type": "ClimateEventStream",
      "serviceEndpoint": "https://carbon-dpi.greenpe.in/events/did:cupi:india:solar:GP-IND-2024-GJ-044821-SOL"
    }
  ],
  "carbonUPI": {
    "cih": "a7f3c9d2e1b4...",
    "assetType": "solar_pv_rooftop",
    "registeredAt": "2024-09-15T10:00:00Z",
    "trustRegistryEntry": "https://registry.carbon-dpi.org/devices/CUPI-DEV-HW-SUN2000-50KTL-2024-0442",
    "methodology": "CUPI-METH-001",
    "location": {
      "country": "IND",
      "state": "GJ",
      "gps": "23.0225,72.5714"
    }
  }
}
```

## 4. Operations

### 4.1 Create

A Climate DID is created when an entity or asset is registered in the Carbon DPI protocol:

1. Entity provides identity credential (GSTIN, Aadhaar hash, PAN, UDYAM)
2. Identity is verified against government APIs
3. Composite Identity Hash (CIH) is computed: `SHA-256(identity ‖ assetId ‖ deviceId ‖ GPS ‖ timestamp)`
4. Ed25519 key pair is generated for the DID
5. DID Document is created and stored
6. DID is published to the Carbon DPI Trust Registry

### 4.2 Resolve

Resolution of a `did:cupi` identifier returns the DID Document:

```
GET https://resolver.carbon-dpi.org/1.0/identifiers/did:cupi:india:solar:GP-IND-2024-GJ-044821-SOL
```

Resolution can also be performed by any Carbon DPI node that maintains a copy of the Trust Registry.

### 4.3 Update

DID Documents can be updated by the controller:
- Rotate verification keys
- Update service endpoints
- Add or remove verification methods

All updates must be signed by the current controller key.

### 4.4 Deactivate

Deactivation sets the DID Document status to `deactivated`. The DID remains resolvable but no longer valid for new assertions. Deactivation is irreversible.

## 5. Security Considerations

- **Key Management:** Ed25519 keys must be stored securely. Key rotation is recommended annually.
- **Privacy:** No personally identifiable information (PII) is stored in the DID Document. Identity is bound via the CIH (a one-way SHA-256 hash).
- **Integrity:** All DID operations are logged in the hash-chained audit trail.
- **Replay Protection:** Each operation includes a nonce and timestamp.

## 6. Privacy Considerations

- The `carbonUPI.cih` field is a SHA-256 hash — it cannot be reversed to reveal the original identity credential.
- GPS coordinates in the DID Document represent the asset location, not the owner's personal address.
- The DID Document does not contain names, email addresses, or phone numbers.

## 7. References

- [W3C DID Core Specification](https://www.w3.org/TR/did-core/)
- [W3C Verifiable Credentials](https://www.w3.org/TR/vc-data-model/)
- [Ed25519 Signature Suite 2020](https://w3c-ccg.github.io/lds-ed25519-2020/)
- [Carbon DPI Protocol Specification](https://github.com/carbon-dpi/carbon-dpi-spec)
