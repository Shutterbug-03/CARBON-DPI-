export type DataSourceType = "IOT_SENSOR" | "SATELLITE" | "SCADA" | "MANUAL_ENTRY" | "API_IMPORT" | "DOCUMENT_SCAN";

export interface DeviceRegistration {
  cihReference: string;
  sourceType: DataSourceType;
  sourceId: string;
  publicKeyBase64: string;
  geolocation: {
    lat: number;
    lng: number;
  };
  status: "ACTIVE" | "REVOKED" | "SUSPENDED";
  registeredAt: string;
}

export interface VerifierRegistration {
  verifierId: string;
  name: string;
  did: string;
  accreditedScopes: string[];
  status: "ACTIVE" | "REVOKED" | "SUSPENDED";
  registeredAt: string;
}
