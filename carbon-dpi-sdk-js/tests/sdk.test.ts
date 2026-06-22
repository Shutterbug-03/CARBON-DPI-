import { computeCIH } from "../src/index";

describe("Carbon DPI JS SDK", () => {

    it("should compute deterministic CIH", () => {
        const params = {
            identityHash: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
            assetId: "ASSET-001",
            deviceId: "DEVICE-001",
            lat: 12.3456,
            lng: 78.9012,
            timestamp: "2024-01-01T00:00:00Z"
        };

        const cih1 = computeCIH(params);
        const cih2 = computeCIH(params);

        expect(cih1).toBe(cih2);
        expect(typeof cih1).toBe("string");
        expect(cih1.length).toBe(64); // SHA-256 hash length in hex
    });

    it("should normalize inputs for CIH computation", () => {
        const params1 = {
            identityHash: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
            assetId: "ASSET-001",
            deviceId: "DEVICE-001",
            lat: 12.3456,
            lng: 78.9012,
            timestamp: "2024-01-01T00:00:00Z"
        };

        const params2 = {
            identityHash: "  1234567890ABCDEF1234567890abcdef1234567890abcdef1234567890abcdef  ", // Mixed case & spaces
            assetId: " ASSET-001 ",
            deviceId: " device-001 ", // Lowercase
            lat: 12.3456,
            lng: 78.9012,
            timestamp: " 2024-01-01T00:00:00Z "
        };

        const cih1 = computeCIH(params1);
        const cih2 = computeCIH(params2);

        expect(cih1).toBe(cih2);
    });
});
