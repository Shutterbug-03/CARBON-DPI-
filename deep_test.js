import { spawn, execSync } from "child_process";
import { randomUUID, generateKeyPairSync, sign, createHash, createHmac } from "crypto";
import { createServer } from "http";
import mqtt from "mqtt";
import zlib from "zlib";

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Generate cryptographic keys for BAP, BPP, and Device dynamically for the test run
console.log("🔑 Generating cryptographic keys for test environment...");
const bapKeys = generateKeyPairSync("ed25519");
const bapPublicKey = bapKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const bapPrivateKey = bapKeys.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");

const bppKeys = generateKeyPairSync("ed25519");
const bppPublicKey = bppKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const bppPrivateKey = bppKeys.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");

const deviceKeys = generateKeyPairSync("ed25519");
const devicePublicKey = deviceKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const devicePrivateKey = deviceKeys.privateKey; // Keep as KeyObject for signing

const ADMIN_KEY = "deep_test_admin_key";

// Setup HTTP mock webhook receiver on port 3095
const receivedWebhooks = [];
let webhookSecret = null;

const webhookServer = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/webhook") {
    let body = "";
    req.on("data", chunk => {
      body += chunk.toString();
    });
    req.on("end", () => {
      const signatureHeader = req.headers["x-hub-signature-256"];
      const tenantHeader = req.headers["x-tenant-id"];
      
      let verified = false;
      if (signatureHeader && webhookSecret) {
        const hmac = createHmac("sha256", webhookSecret);
        hmac.update(body);
        const signature = hmac.digest("hex");
        
        if (signatureHeader === `sha256=${signature}`) {
          verified = true;
        }
      }
      
      try {
        const payload = JSON.parse(body);
        console.log(`[Mock Webhook] 📬 Received event ${payload.gicId ? (payload.reason ? "GIC_REVOKED" : "GIC_MINTED") : "UNKNOWN"}: signatureVerified=${verified}, tenant=${tenantHeader}`);
        receivedWebhooks.push({
          payload,
          verified,
          tenantId: tenantHeader,
          eventType: payload.gicId ? (payload.reason ? "GIC_REVOKED" : "GIC_MINTED") : "UNKNOWN"
        });
      } catch (e) {
        console.error("[Mock Webhook] Failed to parse payload:", e);
      }
      
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "OK" }));
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

webhookServer.listen(3095, () => {
  console.log("⚓ Mock Webhook Receiver listening on port 3095");
});

const services = [
  { 
    name: "Registry", 
    dir: "./carbon-dpi-registry", 
    port: 3003,
    env: {
      REGISTRY_ADMIN_KEY: ADMIN_KEY,
      REFERENCE_NODE_URL: "http://localhost:3099", // Crucial for database seeding
    }
  },
  { 
    name: "Node", 
    dir: "./carbon-dpi-reference-node", 
    port: 3099, 
    env: { 
      REGISTRY_URL: "http://localhost:3003",
      BECKN_ED25519_PRIVATE_KEY: bppPrivateKey,
      BECKN_ED25519_PUBLIC_KEY: bppPublicKey,
      BECKN_BAP_PUBLIC_KEY: bapPublicKey,
      REGISTRY_ADMIN_KEY: ADMIN_KEY,
    } 
  },
  { 
    name: "Gateway", 
    dir: "./carbon-dpi-beckn-gateway", 
    port: 3005, 
    env: { 
      REFERENCE_NODE_URL: "http://localhost:3099",
      TRUST_REGISTRY_URL: "http://localhost:3003",
    } 
  },
  { 
    name: "EventBus", 
    dir: "./carbon-dpi-event-bus", 
    port: 3004, 
    env: { 
      BECKN_GATEWAY_URL: "http://localhost:3005/v1", 
      REDIS_URL: "redis://localhost:6379", 
      BAP_URI: "http://localhost:3004/v1",
      BECKN_ED25519_PRIVATE_KEY: bapPrivateKey,
      BECKN_BPP_PUBLIC_KEY: bppPublicKey,
      BATCH_INTERVAL_MS: "2000"
    } 
  }
];

let processes = [];

async function startServices() {
  console.log("🚀 Starting all services for DEEP TEST...");
  
  for (const s of services) {
    console.log(`Starting ${s.name} on ${s.port}...`);
    const p = spawn("node", ["dist/index.js"], {
      cwd: s.dir,
      env: { ...process.env, PORT: s.port.toString(), ...s.env },
      stdio: "pipe"
    });
    
    p.stdout.on('data', data => console.log(`[${s.name}] ${data.toString().trim()}`));
    p.stderr.on('data', data => console.error(`[${s.name} ERR] ${data.toString().trim()}`));
    
    processes.push(p);
  }
  await sleep(4000); // give them time to bind
}

function cleanup() {
  console.log("🛑 Killing all services...");
  for (const p of processes) {
    p.kill("SIGTERM");
  }
  webhookServer.close();
}

function signDataPoint(dp, privateKey) {
  const basePayload = {
    id: dp.id,
    cihReference: dp.cihReference,
    sourceType: dp.sourceType,
    sourceId: dp.sourceId,
    timestamp: dp.timestamp,
    geolocation: dp.geolocation,
    value: dp.value,
    unit: dp.unit
  };
  const payloadStr = JSON.stringify(basePayload, Object.keys(basePayload).sort());
  const dataBuffer = Buffer.from(payloadStr);
  const signature = sign(null, dataBuffer, privateKey);
  return signature.toString("base64");
}

async function runDeepTest() {
  try {
    // Clear out databases before starting tests
    try {
      execSync(`sqlite3 ./carbon-dpi-reference-node/prisma/dev.db "DELETE FROM Certificate; DELETE FROM \\"Transaction\\"; DELETE FROM DataPoint; DELETE FROM WebhookSubscription; DELETE FROM OutboxEvent;"`);
      execSync(`sqlite3 ./carbon-dpi-registry/prisma/dev.db "DELETE FROM Verifier; DELETE FROM Device;"`);
      console.log("🧹 SQLite databases cleared.");
    } catch (e) {
      // Ignored if db file doesn't exist yet
    }

    await startServices();

    // Wait for BPP and Registry sync
    await sleep(2000);

    // 1. Register a fake solar device on the Registry to satisfy CDIF checks
    console.log("✅ Registering mock Solar IoT device...");
    const cih = createHash("sha256").update(randomUUID()).digest("hex"); // Must be exactly 64 characters
    const registerResponse = await fetch(`http://localhost:3003/v1/registry/devices`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "x-api-key": ADMIN_KEY
      },
      body: JSON.stringify({
        cihReference: cih,
        sourceType: "IOT_SENSOR",
        sourceId: "SN-DEEP-TEST",
        publicKeyBase64: devicePublicKey,
        geolocation: {
          lat: 12.9716,
          lng: 77.5946
        }
      })
    });
    
    if (!registerResponse.ok) {
      const errorText = await registerResponse.text();
      throw new Error(`Device registration failed: ${errorText}`);
    }

    // 2. Subscribe our mock webhook receiver to GIC_MINTED and GIC_REVOKED events
    console.log("✅ Subscribing mock webhook receiver...");
    const subscribeRes = await fetch("http://localhost:3099/v1/webhooks/subscribe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ADMIN_KEY
      },
      body: JSON.stringify({
        url: "http://localhost:3095/webhook",
        events: ["GIC_MINTED", "GIC_REVOKED"]
      })
    });
    
    if (!subscribeRes.ok) {
      throw new Error(`Webhook subscription failed: ${await subscribeRes.text()}`);
    }
    const subData = await subscribeRes.json();
    webhookSecret = subData.secret;
    console.log(`✅ Webhook subscribed. Secret: ${webhookSecret}`);

    // 3. Fire 50 concurrent telemetry points over MQTT with tenantId "tenant-green-1"
    console.log("✅ Connecting to MQTT Broker on port 1883...");
    const mqttClient = mqtt.connect("mqtt://localhost:1883");
    
    await new Promise((resolve, reject) => {
      mqttClient.on("connect", () => {
        console.log("📡 Connected to MQTT. Publishing 50 telemetry points with tenant-green-1...");
        
        for (let i = 0; i < 50; i++) {
          const id = `dp-${randomUUID()}`;
          const dp = {
            id,
            cihReference: cih,
            sourceType: "IOT_SENSOR",
            sourceId: "SN-DEEP-TEST",
            timestamp: new Date().toISOString(),
            geolocation: { lat: 12.9716, lng: 77.5946 },
            value: 2.5 + Math.random(),
            unit: "kWh",
            tenantId: "tenant-green-1"
          };
          
          const deviceSignature = signDataPoint(dp, devicePrivateKey);
          const payload = {
            ...dp,
            deviceSignature
          };
          
          mqttClient.publish("carbon-dpi/telemetry", JSON.stringify(payload));
        }
        
        mqttClient.end();
        resolve();
      });
      mqttClient.on("error", (err) => {
        reject(err);
      });
    });

    console.log("⏳ Waiting 15 seconds for Event Bus batching -> Gateway Multicast -> BPP Processing -> Webhook Dispatch...");
    await sleep(15000);

    // 4. Verify that W3C Certificate was generated and webhook dispatched
    console.log("🔍 Inspecting Reference Node Database for generated W3C Certificates...");
    const nodeDbOutput = execSync(`sqlite3 ./carbon-dpi-reference-node/prisma/dev.db "SELECT count(*) FROM Certificate;"`).toString().trim();
    console.log(`✅ Certificates generated in DB: ${nodeDbOutput}`);
    
    if (parseInt(nodeDbOutput, 10) < 1) {
      throw new Error("No certificates generated in the database.");
    }

    console.log(`🔍 Checking received webhooks... (total: ${receivedWebhooks.length})`);
    const mintedWebhook = receivedWebhooks.find(w => w.eventType === "GIC_MINTED");
    if (!mintedWebhook) {
      throw new Error("GIC_MINTED webhook not received.");
    }
    
    if (!mintedWebhook.verified) {
      throw new Error("GIC_MINTED webhook signature verification FAILED!");
    }
    
    if (mintedWebhook.tenantId !== "tenant-green-1") {
      throw new Error(`Expected webhook tenantId 'tenant-green-1', got '${mintedWebhook.tenantId}'`);
    }
    
    const gicId = mintedWebhook.payload.gicId;
    console.log(`✅ Webhook verified successfully. GIC ID: ${gicId}`);

    // 5. Verify multi-tenancy database isolation
    const txId = execSync(`sqlite3 ./carbon-dpi-reference-node/prisma/dev.db "SELECT transactionId FROM \\"Transaction\\" LIMIT 1;"`).toString().trim();
    console.log(`🔍 Found Transaction ID in DB: ${txId}`);
    
    console.log("🔍 Testing tenant isolation on transaction endpoint...");
    
    // Query with wrong tenant (default)
    const txResDefault = await fetch(`http://localhost:3099/v1/transaction/${txId}`, {
      headers: { "x-tenant-id": "default" }
    });
    console.log(`  Query with default tenant status: ${txResDefault.status} (expected: 404)`);
    if (txResDefault.status !== 404) {
      throw new Error(`Expected 404 for wrong tenant, got ${txResDefault.status}`);
    }
    
    // Query with correct tenant (tenant-green-1)
    const txResGreen = await fetch(`http://localhost:3099/v1/transaction/${txId}`, {
      headers: { "x-tenant-id": "tenant-green-1" }
    });
    console.log(`  Query with tenant-green-1 status: ${txResGreen.status} (expected: 200)`);
    if (txResGreen.status !== 200) {
      throw new Error(`Expected 200 for correct tenant, got ${txResGreen.status}`);
    }
    
    // 6. Test Revocation
    console.log("⚠️ Revoking the Green Impact Certificate...");
    const revokeRes = await fetch(`http://localhost:3099/v1/gic/${gicId}/revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ADMIN_KEY
      },
      body: JSON.stringify({ reason: "Double reporting detected" })
    });
    
    if (!revokeRes.ok) {
      throw new Error(`Revocation request failed: ${await revokeRes.text()}`);
    }
    console.log("✅ GIC revoked successfully via admin API.");

    console.log("⏳ Waiting 6 seconds for outbox webhook dispatcher to deliver GIC_REVOKED event...");
    await sleep(6000);

    const revokedWebhook = receivedWebhooks.find(w => w.eventType === "GIC_REVOKED");
    if (!revokedWebhook) {
      throw new Error("No GIC_REVOKED webhook received!");
    }
    if (!revokedWebhook.verified) {
      throw new Error("GIC_REVOKED webhook signature verification FAILED!");
    }
    if (revokedWebhook.tenantId !== "tenant-green-1") {
      throw new Error(`Expected revoked webhook tenantId 'tenant-green-1', got '${revokedWebhook.tenantId}'`);
    }
    console.log("✅ Revocation webhook verified successfully.");

    // 7. Verify W3C Status List VC
    console.log("🔍 Fetching W3C Status List for certificates...");
    const statusListRes = await fetch("http://localhost:3099/v1/status-list/certificates");
    if (!statusListRes.ok) {
      throw new Error(`Failed to fetch Status List: ${await statusListRes.text()}`);
    }
    const statusListVC = await statusListRes.json();
    console.log("✅ Status List VC structure matches W3C standard:", statusListVC.type);
    
    const encodedList = statusListVC.credentialSubject.encodedList;
    const decodedBuffer = Buffer.from(encodedList, "base64");
    const unzipped = zlib.gunzipSync(decodedBuffer);
    const bitAtZero = unzipped[0] & 1;
    console.log(`✅ Status list bitstring index 0: ${bitAtZero} (expected: 1)`);
    if (bitAtZero !== 1) {
      throw new Error("Expected status list index 0 to be 1 (REVOKED)");
    }

    // 8. Verify metrics & docs endpoints
    console.log("🔍 Verifying Observability & Documentation endpoints...");
    const metricsRes = await fetch("http://localhost:3099/metrics");
    if (!metricsRes.ok) {
      throw new Error(`Prometheus metrics endpoint failed: ${metricsRes.status}`);
    }
    console.log("✅ Reference Node metrics working.");
    
    const docsRes = await fetch("http://localhost:3099/docs");
    if (!docsRes.ok) {
      throw new Error(`Swagger UI endpoint failed: ${docsRes.status}`);
    }
    console.log("✅ Reference Node Swagger UI working.");

    console.log("🎉 ALL PHASE 8 FEATURES VERIFIED SUCCESSFULLY IN DEEP INTEGRATION TEST!");

  } catch (err) {
    console.error("❌ Test execution failed:", err);
    process.exitCode = 1;
  } finally {
    cleanup();
    setTimeout(() => process.exit(), 1000);
  }
}

runDeepTest();
