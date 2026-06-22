import { 
    generateDeviceKeypair, 
    computeCIH, 
    EventBusClient 
} from '@carbon-dpi/sdk';
import { randomUUID } from 'node:crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Carbon DPI — EV Telematics Reference Client
// ─────────────────────────────────────────────────────────────────────────────

const TRUST_REGISTRY_URL = process.env.TRUST_REGISTRY_URL || "http://localhost:3003";
const EVENT_BUS_URL = process.env.EVENT_BUS_URL || "http://localhost:3004";

// The physical device identifier (VIN / Telematics ID)
const DEVICE_DID = `did:cdpi:india:ev:VIN-${randomUUID().substring(0, 8).toUpperCase()}`;
const DEVICE_GEOLOCATION = { lat: 12.9716, lng: 77.5946 }; // Bangalore

async function registerDevice(cih: string, publicKeyBase64: string) {
    console.log(`\n[EVApp] Registering telematics unit with Trust Registry...`);
    
    try {
        const res = await fetch(`${TRUST_REGISTRY_URL}/v1/registry/devices`, {
            method: "POST",
            headers: { 
                "Content-Type": "application/json",
                "x-api-key": process.env.REGISTRY_ADMIN_KEY || "dev-admin-key"
            },
            body: JSON.stringify({
                cihReference: cih,
                sourceType: "EV_TELEMATICS",
                sourceId: DEVICE_DID,
                publicKeyBase64: publicKeyBase64,
                geolocation: DEVICE_GEOLOCATION
            })
        });

        if (res.status === 201) {
            console.log(`[EVApp] ✅ Telematics officially registered!`);
        } else {
            console.error(`[EVApp] ❌ Failed to register hardware:`, await res.text());
            process.exit(1);
        }
    } catch (e) {
        console.error(`[EVApp] ❌ Trust Registry unreachable at ${TRUST_REGISTRY_URL}. Please ensure it is running.`);
        process.exit(1);
    }
}

async function start() {
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  🚗  Carbon DPI — EV Telematics Simulator");
    console.log("═══════════════════════════════════════════════════════════════");

    // 1. Generate Ed25519 Hardware Keys
    console.log(`[EVApp] Booting up TCU... generating secure enclave keys...`);
    const keypair = generateDeviceKeypair();
    console.log(`[EVApp] Hardware Public Key: ${keypair.publicKeyBase64.substring(0, 40)}...`);

    // 2. Compute the Composite Identity Hash (CIH)
    const cih = computeCIH({
        identityHash: "EV-OWNER-HASH",
        assetId: "EV-FLEET-001",
        deviceId: DEVICE_DID,
        lat: DEVICE_GEOLOCATION.lat,
        lng: DEVICE_GEOLOCATION.lng,
        timestamp: new Date().toISOString()
    });
    console.log(`[EVApp] Device DID: ${DEVICE_DID}`);
    console.log(`[EVApp] Device CIH: ${cih}`);

    // 3. Register with Trust Registry
    await registerDevice(cih, keypair.publicKeyBase64);

    // 4. Initialize the Event Bus Client
    const client = new EventBusClient(EVENT_BUS_URL, cih, keypair.privateKeyPem);

    console.log(`\n[EVApp] Beginning trip telemetry transmission (1 reading / 5 seconds)...`);

    // 5. Stream telemetry loop
    let totalKm = 0;

    setInterval(async () => {
        // Simulate EV driving (0.1 to 0.5 km per tick)
        const reading = parseFloat((0.1 + Math.random() * 0.4).toFixed(2));
        totalKm += reading;

        console.log(`[EVApp] 🚗 Drove ${reading} km (Total Trip: ${totalKm.toFixed(2)} km). Pushing to network...`);

        const success = await client.pushTelemetry({
            sourceType: "EV_TELEMATICS",
            sourceId: DEVICE_DID,
            timestamp: new Date().toISOString(),
            geolocation: DEVICE_GEOLOCATION,
            value: reading,
            unit: "km"
        });

        if (!success) {
            console.log(`[EVApp] ⚠️ Failed to push telemetry point.`);
        }
    }, 5000);
}

start();
