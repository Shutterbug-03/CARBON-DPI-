import {
    generateDeviceKeypair,
    computeCIH,
    EventBusClient
} from '@carbon-dpi/sdk';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// ─────────────────────────────────────────────────────────────────────────────
// Carbon DPI — EV Telematics Reference Client
// ─────────────────────────────────────────────────────────────────────────────

const TRUST_REGISTRY_URL = process.env.TRUST_REGISTRY_URL || "http://localhost:3003";
const EVENT_BUS_URL = process.env.EVENT_BUS_URL || "http://localhost:3004";
const EVENT_BUS_API_KEY = process.env.EVENT_BUS_API_KEY || "default-ingest-key";
const REGISTRY_ADMIN_KEY = process.env.REGISTRY_ADMIN_KEY || "dev-admin-key";
const GEOLOCATION = { lat: 12.9716, lng: 77.5946 }; // Bangalore

const STATE_FILE = ".device-state.json";

interface DeviceState {
    cih: string;
    publicKeyBase64: string;
    privateKeyPem: string;
    deviceDid: string;
    commissionDate: string;
}

function loadOrCreateDeviceState(): DeviceState {
    if (existsSync(STATE_FILE)) {
        console.log(`[EVApp] 🔄 Loading existing device state from ${STATE_FILE}...`);
        return JSON.parse(readFileSync(STATE_FILE, "utf-8")) as DeviceState;
    }

    console.log(`[EVApp] 🆕 First boot — generating device identity...`);
    const keypair = generateDeviceKeypair();
    const deviceDid = `did:cdpi:india:ev:VIN-${randomUUID().substring(0, 8).toUpperCase()}`;
    const commissionDate = new Date().toISOString();

    const cih = computeCIH({
        identityHash: process.env.IDENTITY_HASH || "EV-OWNER-HASH",
        assetId: "EV-FLEET-001",
        deviceId: deviceDid,
        lat: GEOLOCATION.lat,
        lng: GEOLOCATION.lng,
        timestamp: commissionDate,  // Fixed at provisioning — never changes on restart
    });

    const state: DeviceState = { cih, publicKeyBase64: keypair.publicKeyBase64, privateKeyPem: keypair.privateKeyPem, deviceDid, commissionDate };
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log(`[EVApp] ✅ Device state saved to ${STATE_FILE}`);
    return state;
}

async function registerDevice(state: DeviceState): Promise<boolean> {
    console.log(`\n[EVApp] Checking device registration in Trust Registry...`);
    try {
        const checkRes = await fetch(`${TRUST_REGISTRY_URL}/v1/registry/devices/${state.cih}`);
        if (checkRes.ok) {
            const device = await checkRes.json();
            if (device.status === "ACTIVE") {
                console.log(`[EVApp] ✅ Device already registered and active. Resuming.`);
                return true;
            }
        }
    } catch { /* not yet registered */ }

    try {
        const res = await fetch(`${TRUST_REGISTRY_URL}/v1/registry/devices`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": REGISTRY_ADMIN_KEY },
            body: JSON.stringify({
                cihReference: state.cih,
                sourceType: "EV_TELEMATICS",
                sourceId: state.deviceDid,
                publicKeyBase64: state.publicKeyBase64,
                geolocation: GEOLOCATION
            })
        });
        if (res.status === 201 || res.status === 200) {
            console.log(`[EVApp] ✅ Telematics officially registered!`);
            return true;
        }
        console.error(`[EVApp] ❌ Failed to register hardware:`, await res.text());
        return false;
    } catch (e) {
        console.error(`[EVApp] ❌ Trust Registry unreachable at ${TRUST_REGISTRY_URL}.`);
        return false;
    }
}

async function start() {
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  🚗  Carbon DPI — EV Telematics Simulator");
    console.log("═══════════════════════════════════════════════════════════════");

    const state = loadOrCreateDeviceState();
    console.log(`[EVApp] Device DID: ${state.deviceDid}`);
    console.log(`[EVApp] Device CIH: ${state.cih} (stable, from ${state.commissionDate})`);

    const registered = await registerDevice(state);
    if (!registered) process.exit(1);

    const client = new EventBusClient(EVENT_BUS_URL, state.cih, state.privateKeyPem, EVENT_BUS_API_KEY);

    console.log(`\n[EVApp] Beginning trip telemetry transmission (1 reading / 5 seconds)...`);
    let totalKm = 0;

    setInterval(async () => {
        const reading = parseFloat((0.1 + Math.random() * 0.4).toFixed(2));
        totalKm += reading;
        console.log(`[EVApp] 🚗 Drove ${reading} km (Total Trip: ${totalKm.toFixed(2)} km). Pushing to network...`);

        const success = await client.pushTelemetry({
            sourceType: "EV_TELEMATICS",
            sourceId: state.deviceDid,
            timestamp: new Date().toISOString(),
            geolocation: GEOLOCATION,
            value: reading,
            unit: "km"
        });
        if (!success) console.log(`[EVApp] ⚠️ Failed to push telemetry point.`);
    }, 5000);
}

start();
