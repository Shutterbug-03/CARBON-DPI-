import { 
    generateDeviceKeypair, 
    computeCIH, 
    EventBusClient 
} from '@carbon-dpi/sdk';
import { randomUUID } from 'node:crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Carbon DPI — MSME Biogas Reference Client
// ─────────────────────────────────────────────────────────────────────────────

const TRUST_REGISTRY_URL = process.env.TRUST_REGISTRY_URL || "http://localhost:3003";
const EVENT_BUS_URL = process.env.EVENT_BUS_URL || "http://localhost:3004";

// The physical device identifier (Flow Meter ID)
const DEVICE_DID = `did:cdpi:india:biogas:METER-${randomUUID().substring(0, 8).toUpperCase()}`;
const DEVICE_GEOLOCATION = { lat: 19.0760, lng: 72.8777 }; // Mumbai

async function registerDevice(cih: string, publicKeyBase64: string) {
    console.log(`\n[MSMEApp] Registering flow meter with Trust Registry...`);
    
    try {
        const res = await fetch(`${TRUST_REGISTRY_URL}/v1/registry/devices`, {
            method: "POST",
            headers: { 
                "Content-Type": "application/json",
                "x-api-key": process.env.REGISTRY_ADMIN_KEY || "dev-admin-key"
            },
            body: JSON.stringify({
                cihReference: cih,
                sourceType: "BIOGAS_FLOW_METER",
                sourceId: DEVICE_DID,
                publicKeyBase64: publicKeyBase64,
                geolocation: DEVICE_GEOLOCATION
            })
        });

        if (res.status === 201) {
            console.log(`[MSMEApp] ✅ Flow meter officially registered!`);
        } else {
            console.error(`[MSMEApp] ❌ Failed to register hardware:`, await res.text());
            process.exit(1);
        }
    } catch (e) {
        console.error(`[MSMEApp] ❌ Trust Registry unreachable at ${TRUST_REGISTRY_URL}. Please ensure it is running.`);
        process.exit(1);
    }
}

async function start() {
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  🏭  Carbon DPI — MSME Biogas Simulator");
    console.log("═══════════════════════════════════════════════════════════════");

    // 1. Generate Ed25519 Hardware Keys
    console.log(`[MSMEApp] Booting up flow meter... generating secure enclave keys...`);
    const keypair = generateDeviceKeypair();
    console.log(`[MSMEApp] Hardware Public Key: ${keypair.publicKeyBase64.substring(0, 40)}...`);

    // 2. Compute the Composite Identity Hash (CIH)
    const cih = computeCIH({
        identityHash: "MSME-GSTIN-HASH",
        assetId: "BIOGAS-PLANT-001",
        deviceId: DEVICE_DID,
        lat: DEVICE_GEOLOCATION.lat,
        lng: DEVICE_GEOLOCATION.lng,
        timestamp: new Date().toISOString()
    });
    console.log(`[MSMEApp] Device DID: ${DEVICE_DID}`);
    console.log(`[MSMEApp] Device CIH: ${cih}`);

    // 3. Register with Trust Registry
    await registerDevice(cih, keypair.publicKeyBase64);

    // 4. Initialize the Event Bus Client
    const client = new EventBusClient(EVENT_BUS_URL, cih, keypair.privateKeyPem);

    console.log(`\n[MSMEApp] Beginning telemetry transmission (1 reading / 5 seconds)...`);

    // 5. Stream telemetry loop
    let totalM3 = 0;

    setInterval(async () => {
        // Simulate biogas generation (1 to 5 m3 per tick)
        const reading = parseFloat((1 + Math.random() * 4).toFixed(2));
        totalM3 += reading;

        console.log(`[MSMEApp] 🏭 Captured ${reading} m3 biogas (Total: ${totalM3.toFixed(2)} m3). Pushing to network...`);

        const success = await client.pushTelemetry({
            sourceType: "BIOGAS_FLOW_METER",
            sourceId: DEVICE_DID,
            timestamp: new Date().toISOString(),
            geolocation: DEVICE_GEOLOCATION,
            value: reading,
            unit: "m3"
        });

        if (!success) {
            console.log(`[MSMEApp] ⚠️ Failed to push telemetry point.`);
        }
    }, 5000);
}

start();
