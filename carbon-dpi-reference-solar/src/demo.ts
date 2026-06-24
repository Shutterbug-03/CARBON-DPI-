import {
    generateDeviceKeypair,
    computeCIH,
    EventBusClient,
    CIHInput
} from '@carbon-dpi/sdk';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// ─────────────────────────────────────────────────────────────────────────────
// Carbon DPI — Solar Inverter Reference Client
//
// DESIGN: Device state (keys + CIH) is persisted to .device-state.json on
// first run and reloaded on every subsequent boot. This ensures the CIH is
// STABLE across restarts — a requirement for telemetry continuity and audit
// trail integrity. A changing CIH would orphan all past telemetry.
// ─────────────────────────────────────────────────────────────────────────────

const TRUST_REGISTRY_URL = process.env.TRUST_REGISTRY_URL || "http://localhost:3003";
const EVENT_BUS_URL = process.env.EVENT_BUS_URL || "http://localhost:3004";
const EVENT_BUS_API_KEY = process.env.EVENT_BUS_API_KEY || "default-ingest-key";
const REGISTRY_ADMIN_KEY = process.env.REGISTRY_ADMIN_KEY || "dev-admin-key";

// State file persists device identity across restarts
const STATE_FILE = ".device-state.json";

interface DeviceState {
    cih: string;
    publicKeyBase64: string;
    privateKeyPem: string;
    deviceDid: string;
    assetId: string;
    commissionDate: string;
}

function loadOrCreateDeviceState(): DeviceState {
    if (existsSync(STATE_FILE)) {
        console.log(`[SolarApp] 🔄 Loading existing device state from ${STATE_FILE}...`);
        return JSON.parse(readFileSync(STATE_FILE, "utf-8")) as DeviceState;
    }

    // First boot: generate identity and persist
    console.log(`[SolarApp] 🆕 First boot — generating device identity...`);
    const keypair = generateDeviceKeypair();
    const deviceDid = `did:cdpi:india:solar:INV-${randomUUID().substring(0, 8)}`;
    const assetId = `SOLAR-PV-${randomUUID().substring(0, 8)}`;
    const geolocation = { lat: 28.6139, lng: 77.2090 }; // New Delhi

    // Commission date is FIXED — this is the cryptographic anchor for the CIH.
    // It represents when the device was provisioned, NOT when it booted.
    const commissionDate = new Date().toISOString();

    const cihInput: CIHInput = {
        identityHash: process.env.IDENTITY_HASH || "GSTIN-24AADCS7412M1Z8",
        assetId,
        deviceId: deviceDid,
        lat: geolocation.lat,
        lng: geolocation.lng,
        timestamp: commissionDate,   // Fixed at first boot, never changes again
    };

    const cih = computeCIH(cihInput);

    const state: DeviceState = {
        cih,
        publicKeyBase64: keypair.publicKeyBase64,
        privateKeyPem: keypair.privateKeyPem,
        deviceDid,
        assetId,
        commissionDate,
    };

    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log(`[SolarApp] ✅ Device state saved to ${STATE_FILE}`);
    return state;
}

async function registerDevice(state: DeviceState): Promise<boolean> {
    console.log(`\n[SolarApp] Checking device registration in Trust Registry...`);

    // Check if already registered
    try {
        const checkRes = await fetch(`${TRUST_REGISTRY_URL}/v1/registry/devices/${state.cih}`);
        if (checkRes.ok) {
            const device = await checkRes.json();
            if (device.status === "ACTIVE") {
                console.log(`[SolarApp] ✅ Device already registered and active. Resuming.`);
                return true;
            }
        }
    } catch {
        // Registry unreachable or not yet registered — attempt registration below
    }

    try {
        const geolocation = { lat: 28.6139, lng: 77.2090 };
        const res = await fetch(`${TRUST_REGISTRY_URL}/v1/registry/devices`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": REGISTRY_ADMIN_KEY
            },
            body: JSON.stringify({
                cihReference: state.cih,
                sourceType: "SOLAR_INVERTER",
                sourceId: state.deviceDid,
                publicKeyBase64: state.publicKeyBase64,
                geolocation
            })
        });

        if (res.status === 201 || res.status === 200) {
            console.log(`[SolarApp] ✅ Hardware officially registered!`);
            return true;
        } else {
            console.error(`[SolarApp] ❌ Failed to register hardware:`, await res.text());
            return false;
        }
    } catch (e) {
        console.error(`[SolarApp] ❌ Trust Registry unreachable at ${TRUST_REGISTRY_URL}.`);
        return false;
    }
}

async function start() {
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  ☀️  Carbon DPI — Solar Inverter Simulator");
    console.log("═══════════════════════════════════════════════════════════════");

    // 1. Load or create persistent device state (stable CIH across restarts)
    const state = loadOrCreateDeviceState();
    console.log(`[SolarApp] Device DID: ${state.deviceDid}`);
    console.log(`[SolarApp] Device CIH: ${state.cih} (stable, from ${state.commissionDate})`);
    console.log(`[SolarApp] Public Key: ${state.publicKeyBase64.substring(0, 40)}...`);

    // 2. Register with Trust Registry (idempotent — skips if already active)
    const registered = await registerDevice(state);
    if (!registered) {
        process.exit(1);
    }

    // 3. Initialize the Event Bus Client
    const client = new EventBusClient(
        EVENT_BUS_URL,
        state.cih,
        state.privateKeyPem,
        EVENT_BUS_API_KEY
    );

    console.log(`\n[SolarApp] Beginning telemetry transmission (1 reading / 5 seconds)...`);

    // 4. Stream telemetry loop
    let totalKwh = 0;

    setInterval(async () => {
        // Simulate solar generation (0.5 to 1.5 kWh per tick)
        const reading = parseFloat((0.5 + Math.random()).toFixed(3));
        totalKwh += reading;

        console.log(`[SolarApp] ⚡️ Generated ${reading} kWh (Total: ${totalKwh.toFixed(3)} kWh). Pushing to network...`);

        const success = await client.pushTelemetry({
            sourceType: "SOLAR_INVERTER",
            sourceId: state.deviceDid,
            timestamp: new Date().toISOString(),
            geolocation: { lat: 28.6139, lng: 77.2090 },
            value: reading,
            unit: "kWh"
        });

        if (!success) {
            console.log(`[SolarApp] ⚠️ Failed to push telemetry point.`);
        }
    }, 5000);
}

start();
