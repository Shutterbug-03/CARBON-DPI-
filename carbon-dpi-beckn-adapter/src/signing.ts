/**
 * Carbon DPI — Beckn Ed25519 Signing Utilities
 *
 * Implements the Beckn specification for request signing:
 *   Authorization: Signature keyId="<subscriber_id>|<unique_key_id>|ed25519",
 *                            algorithm="ed25519",
 *                            created="<unix_ts>",
 *                            expires="<unix_ts>",
 *                            headers="(created) (expires) digest",
 *                            signature="<base64_ed25519_sig>"
 *
 * References:
 *   https://developers.becknprotocol.io/docs/introduction/signing-beckn-apis/
 */

import * as crypto from "node:crypto";

// ──────────────────────────────────────────────────────────────────────────────
// Key Pair Management
// ──────────────────────────────────────────────────────────────────────────────

export interface Ed25519KeyPair {
  publicKey: string;  // Base64-encoded DER
  privateKey: string; // Base64-encoded DER
}

/**
 * Generate a new Ed25519 key pair for Beckn subscriber registration.
 * Run this ONCE and store the keys in .env — do NOT regenerate on each boot.
 */
export function generateKeyPair(): Ed25519KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  return {
    publicKey: publicKey.toString("base64"),
    privateKey: privateKey.toString("base64"),
  };
}

/**
 * Load Ed25519 key pair from environment variables.
 */
export function loadKeyPairFromEnv(): Ed25519KeyPair {
  const pub = process.env.BECKN_ED25519_PUBLIC_KEY;
  const priv = process.env.BECKN_ED25519_PRIVATE_KEY;
  if (!pub || !priv) {
    throw new Error(
      "BECKN_ED25519_PUBLIC_KEY and BECKN_ED25519_PRIVATE_KEY must be set in environment. " +
      "Run `npm run keygen` to generate a new key pair."
    );
  }
  return { publicKey: pub, privateKey: priv };
}

// ──────────────────────────────────────────────────────────────────────────────
// Digest
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Compute the SHA-256 digest of the request body, formatted as required by Beckn:
 *   digest: BLAKE-512=<base64>   (Beckn uses this header name but SHA-256 content)
 */
export function computeBodyDigest(body: string): string {
  const hash = crypto.createHash("sha256").update(body).digest("base64");
  return `SHA-256=${hash}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Signing String
// ──────────────────────────────────────────────────────────────────────────────

export function buildSigningString(params: {
  created: number;
  expires: number;
  digest: string;
}): string {
  return [
    `(created): ${params.created}`,
    `(expires): ${params.expires}`,
    `digest: ${params.digest}`,
  ].join("\n");
}

// ──────────────────────────────────────────────────────────────────────────────
// Sign Request
// ──────────────────────────────────────────────────────────────────────────────

export interface BecknSignatureParams {
  subscriberId: string;   // e.g. "carbon-dpi.greenpe.in"
  uniqueKeyId: string;    // e.g. "carbon-dpi-key-001"
  privateKeyBase64: string;
  body: string;           // Raw JSON string of the request body
  ttlSeconds?: number;    // Signature validity window (default: 300s)
}

export interface SignedHeaders {
  Authorization: string;
  Digest: string;
}

/**
 * Sign a Beckn API request body and return the Authorization + Digest headers.
 */
export function signBecknRequest(params: BecknSignatureParams): SignedHeaders {
  const now = Math.floor(Date.now() / 1000);
  const expires = now + (params.ttlSeconds ?? 300);

  const digest = computeBodyDigest(params.body);
  const signingString = buildSigningString({ created: now, expires, digest });

  const privateKeyDer = Buffer.from(params.privateKeyBase64, "base64");
  const privateKey = crypto.createPrivateKey({ key: privateKeyDer, format: "der", type: "pkcs8" });
  const signature = crypto.sign(null, Buffer.from(signingString), privateKey).toString("base64");

  const authHeader = [
    `Signature keyId="${params.subscriberId}|${params.uniqueKeyId}|ed25519"`,
    `algorithm="ed25519"`,
    `created="${now}"`,
    `expires="${expires}"`,
    `headers="(created) (expires) digest"`,
    `signature="${signature}"`,
  ].join(",");

  return { Authorization: authHeader, Digest: digest };
}

// ──────────────────────────────────────────────────────────────────────────────
// Verify Incoming Request
// ──────────────────────────────────────────────────────────────────────────────

export interface VerifyResult {
  valid: boolean;
  reason?: string;
}

/**
 * Verify an incoming Beckn request's Authorization header.
 * Used by BAP callback endpoints to authenticate incoming on_* callbacks.
 */
export function verifyBecknSignature(params: {
  authorizationHeader: string;
  digestHeader: string;
  body: string;
  publicKeyBase64: string;
}): VerifyResult {
  try {
    // 1. Verify body digest
    const expectedDigest = computeBodyDigest(params.body);
    if (expectedDigest !== params.digestHeader) {
      return { valid: false, reason: "Body digest mismatch" };
    }

    // 2. Parse Authorization header
    const parts: Record<string, string> = {};
    params.authorizationHeader
      .replace(/^Signature\s+/, "")
      .split(",")
      .forEach((part) => {
        const eqIdx = part.indexOf("=");
        const key = part.slice(0, eqIdx).trim();
        const val = part.slice(eqIdx + 1).trim().replace(/^"|"$/g, "");
        parts[key] = val;
      });

    const { created, expires, signature } = parts;
    if (!created || !expires || !signature) {
      return { valid: false, reason: "Missing required signature fields" };
    }

    // 3. Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (now > parseInt(expires, 10)) {
      return { valid: false, reason: "Signature expired" };
    }

    // 4. Reconstruct signing string and verify
    const signingString = buildSigningString({
      created: parseInt(created, 10),
      expires: parseInt(expires, 10),
      digest: params.digestHeader,
    });

    const publicKeyDer = Buffer.from(params.publicKeyBase64, "base64");
    const publicKey = crypto.createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
    const isValid = crypto.verify(
      null,
      Buffer.from(signingString),
      publicKey,
      Buffer.from(signature, "base64")
    );

    return isValid ? { valid: true } : { valid: false, reason: "Invalid signature" };
  } catch (err: any) {
    return { valid: false, reason: `Verification error: ${err.message}` };
  }
}
