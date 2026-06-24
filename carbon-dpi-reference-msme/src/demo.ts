import {
    generateDeviceKeypair,
    computeCIH,
    EventBusClient
} from '@carbon-dpi/sdk';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// ─────────────────────────────────────────────────────────────────────────────
// Carbon DPI — MSME Biogas Reference Client
// ─────────────────────────────────────────────────────────────────────────────

const TRUST_REGISTRY_URL = process.env.TRUST_REGISTRY_URL || "http://localhost:3003";
const EVENT_BUS_URL = process.env.EVENT_BUS_URL || "http://localhost:3004";
const EVENT_BUS_API_KEY = process.env.EVENT_BUS_API_KEY || "default-ingest-key";
const REGISTRY_ADMIN_KEY = process.env.REGISTRY_ADMIN_KEY || "dev-admin-key";
const GEOLOCATION = { lat: 19.0760, lng: 72.8777 }; // Mumbai

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
        console.log(`[MSMEApp] 🔄 Loading existing device state from ${STATE_FILE}...`);
        return JSON.parse(readFileSync(STATE_FILE, "utf-8")) as DeviceState;
    }

    console.log(`[MSMEApp] 🆕 First boot — generating device identity...`);
    const keypair = generateDeviceKeypair();
    const deviceDid = `did:cdpi:india:biogas:METER-${randomUUID().substring(0, 8).toUpperCase()}`;
    const commissionDate = new Date().toISOString();

    const cih = computeCIH({
        identityHash: process.env.IDENTITY_HASH || "MSME-GSTIN-HASH",
        assetId: "BIOGAS-PLANT-001",
        deviceId: deviceDid,
        lat: GEOLOCATION.lat,
        lng: GEOLOCATION.lng,
        timestamp: commissionDate,  // Fixed at provisioning — stable identity anchor
    });

    const state: DeviceState = { cih, publicKeyBase64: keypair.publicKeyBase64, privateKeyPem: keypair.privateKeyPem, deviceDid, commissionDate };
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log(`[MSMEApp] ✅ Device state saved to ${STATE_FILE}`);
    return state;
}

async function registerDevice(state: DeviceState): Promise<boolean> {
    console.log(`\n[MSMEApp] Checking device registration in Trust Registry...`);
    try {
        const checkRes = await fetch(`${TRUST_REGISTRY_URL}/v1/registry/devices/${state.cih}`);
        if (checkRes.ok) {
            const device = await checkRes.json();
            if (device.status === "ACTIVE") {
                console.log(`[MSMEApp] ✅ Device already registered and active. Resuming.`);
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
                sourceType: "BIOGAS_FLOW_METER",
                sourceId: state.deviceDid,
                publicKeyBase64: state.publicKeyBase64,
                geolocation: GEOLOCATION
            })
        });
        if (res.status === 201 || res.status === 200) {
            console.log(`[MSMEApp] ✅ Flow meter officially registered!`);
            return true;
        }
        console.error(`[MSMEApp] ❌ Failed to register hardware:`, await res.text());
        return false;
    } catch (e) {
        console.error(`[MSMEApp] ❌ Trust Registry unreachable at ${TRUST_REGISTRY_URL}.`);
        return false;
    }
}

async function start() {
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  🏭  Carbon DPI — MSME Biogas Simulator");
    console.log("═══════════════════════════════════════════════════════════════");

    const state = loadOrCreateDeviceState();
    console.log(`[MSMEApp] Device DID: ${state.deviceDid}`);
    console.log(`[MSMEApp] Device CIH: ${state.cih} (stable, from ${state.commissionDate})`);

    const registered = await registerDevice(state);
    if (!registered) process.exit(1);

    const client = new EventBusClient(EVENT_BUS_URL, state.cih, state.privateKeyPem, EVENT_BUS_API_KEY);

    console.log(`\n[MSMEApp] Beginning telemetry transmission (1 reading / 5 seconds)...`);
    let totalM3 = 0;

    setInterval(async () => {
        const reading = parseFloat((1 + Math.random() * 4).toFixed(2));
        totalM3 += reading;
        console.log(`[MSMEApp] 🏭 Captured ${reading} m3 biogas (Total: ${totalM3.toFixed(2)} m3). Pushing to network...`);

        const success = await client.pushTelemetry({
            sourceType: "BIOGAS_FLOW_METER",
            sourceId: state.deviceDid,
            timestamp: new Date().toISOString(),
            geolocation: GEOLOCATION,
            value: reading,
            unit: "m3"
        });
        if (!success) console.log(`[MSMEApp] ⚠️ Failed to push telemetry point.`);
    }, 5000);
}

start();
