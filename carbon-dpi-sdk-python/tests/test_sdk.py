import unittest
from datetime import datetime, timezone
from carbon_dpi import compute_cih, validate_cdif, calculate_mrv, generate_gic, to_w3c_vc

class TestCarbonUPISDK(unittest.TestCase):
    def setUp(self):
        self.cih_input = {
            "identityHash": "sha256-of-gstin-value",
            "assetId": "SOLAR-GJ-0442",
            "deviceId": "SUN2000-50KTL",
            "lat": 23.0225,
            "lng": 72.5714,
            "timestamp": "2024-10-01T00:00:00Z"
        }

    def test_compute_cih(self):
        cih = compute_cih(self.cih_input)
        self.assertEqual(len(cih), 64)
        # Verify determinism
        cih2 = compute_cih(self.cih_input)
        self.assertEqual(cih, cih2)

    def test_calculate_mrv_and_gic(self):
        cih = compute_cih(self.cih_input)
        
        data_points = [
            {
                "id": "dp-1",
                "cihReference": cih,
                "sourceType": "IOT_SENSOR",
                "sourceId": "INV-GJ-0001",
                "timestamp": "2024-10-01T12:00:00Z",
                "geolocation": {"lat": 23.0225, "lng": 72.5714},
                "value": 150.0,
                "unit": "kWh",
                "deviceSignature": "sig-001",
                "reportingPeriod": {"start": "2024-10-01T00:00:00Z", "end": "2024-10-01T23:59:59Z"},
                "schemaVersion": "CDIF-1.0",
                "trustScore": "HIGH",
                "raw": None
            }
        ]

        validation = validate_cdif(data_points)
        self.assertEqual(validation["summary"]["accepted"], 1)

        mrv = calculate_mrv("CUPI-METH-001", validation["accepted"])
        self.assertTrue(mrv["success"])
        self.assertGreater(mrv["impactValue"]["amount"], 0)
        self.assertEqual(mrv["confidenceScore"], 100)

        gic = generate_gic(mrv, cih)
        self.assertEqual(gic["status"], "VERIFIED")
        
        vc = to_w3c_vc(gic)
        self.assertIn("VerifiableCredential", vc["type"])
        self.assertEqual(vc["credentialSubject"]["gic_id"], gic["id"])

if __name__ == "__main__":
    unittest.main()
