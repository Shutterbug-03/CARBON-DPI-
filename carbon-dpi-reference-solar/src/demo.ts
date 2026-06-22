import { 
    generateDeviceKeypair, 
    computeCIH, 
    EventBusClient,
    CIHInput
} from '@carbon-dpi/sdk';
import { randomUUID } from 'node:crypto';

// ─────────────────────────────────────────────────────────────────────────────
// Carbon DPI — Solar Inverter Reference Client
// ─────────────────────────────────────────────────────────────────────────────

const TRUST_REGISTRY_URL = process.env.TRUST_REGISTRY_URL || "http://localhost:3003";
const EVENT_BUS_URL = process.env.EVENT_BUS_URL || "http://localhost:3004";

// The physical device identifier (serial number / DID)
const DEVICE_DID = `did:cdpi:india:solar:INV-${randomUUID().substring(0, 8)}`;
const ASSET_ID = `SOLAR-PV-${randomUUID().substring(0, 8)}`;
const IDENTITY_HASH = `GSTIN-24AADCS7412M1Z8`; // Example enterprise identity
const DEVICE_GEOLOCATION = { lat: 28.6139, lng: 77.2090 }; // New Delhi

async function registerDevice(cih: string, publicKeyBase64: string) {
    console.log(`\n[SolarApp] Registering hardware with Trust Registry...`);
    
    try {
        const res = await fetch(`${TRUST_REGISTRY_URL}/v1/registry/devices`, {
            method: "POST",
            headers: { 
                "Content-Type": "application/json",
                "x-api-key": process.env.REGISTRY_ADMIN_KEY || "dev-admin-key"
            },
            body: JSON.stringify({
                cihReference: cih,
                sourceType: "SOLAR_INVERTER",
                sourceId: DEVICE_DID,
                publicKeyBase64: publicKeyBase64,
                geolocation: DEVICE_GEOLOCATION
            })
        });

        if (res.status === 201) {
            console.log(`[SolarApp] ✅ Hardware officially registered!`);
        } else {
            console.error(`[SolarApp] ❌ Failed to register hardware:`, await res.text());
            process.exit(1);
        }
    } catch (e) {
        console.error(`[SolarApp] ❌ Trust Registry unreachable at ${TRUST_REGISTRY_URL}. Please ensure it is running.`);
        process.exit(1);
    }
}

async function start() {
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  ☀️  Carbon DPI — Solar Inverter Simulator");
    console.log("═══════════════════════════════════════════════════════════════");

    // 1. Generate Ed25519 Hardware Keys
    console.log(`[SolarApp] Booting up... generating secure enclave keys...`);
    const keypair = generateDeviceKeypair();
    console.log(`[SolarApp] Hardware Public Key: ${keypair.publicKeyBase64.substring(0, 40)}...`);

    // 2. Compute the Composite Identity Hash (CIH) — canonical 6-field binding
    const cihInput: CIHInput = {
        identityHash: IDENTITY_HASH,
        assetId: ASSET_ID,
        deviceId: DEVICE_DID,
        lat: DEVICE_GEOLOCATION.lat,
        lng: DEVICE_GEOLOCATION.lng,
        timestamp: new Date().toISOString(),
    };
    const cih = computeCIH(cihInput);
    console.log(`[SolarApp] Device DID: ${DEVICE_DID}`);
    console.log(`[SolarApp] Device CIH: ${cih}`);

    // 3. Register with Trust Registry
    await registerDevice(cih, keypair.publicKeyBase64);

    // 4. Initialize the Event Bus Client (handles signatures automatically)
    const client = new EventBusClient(EVENT_BUS_URL, cih, keypair.privateKeyPem);

    console.log(`\n[SolarApp] Beginning telemetry transmission (1 reading / 5 seconds)...`);

    // 5. Stream telemetry loop
    let totalKwh = 0;

    setInterval(async () => {
        // Simulate solar generation (0.5 to 1.5 kWh per tick)
        const reading = parseFloat((0.5 + Math.random()).toFixed(3));
        totalKwh += reading;

        console.log(`[SolarApp] ⚡️ Generated ${reading} kWh (Total: ${totalKwh.toFixed(3)} kWh). Pushing to network...`);

        const success = await client.pushTelemetry({
            sourceType: "SOLAR_INVERTER",
            sourceId: DEVICE_DID,
            timestamp: new Date().toISOString(),
            geolocation: DEVICE_GEOLOCATION,
            value: reading,
            unit: "kWh"
        });

        if (!success) {
            console.log(`[SolarApp] ⚠️ Failed to push telemetry point.`);
        }
    }, 5000);
}

start();
