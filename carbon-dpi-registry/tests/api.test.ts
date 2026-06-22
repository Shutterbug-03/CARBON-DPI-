/// <reference types="jest" />

import request from "supertest";
import { app } from "../src/index";
import { PrismaClient } from "@prisma/client-registry";

// Mock prisma to avoid hitting a real DB in simple tests
jest.mock("@prisma/client-registry", () => {
  const mPrismaClient = {
    $queryRaw: jest.fn().mockResolvedValue([{ 1: 1 }]),
    verifier: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  return { PrismaClient: jest.fn(() => mPrismaClient) };
});

describe("Registry API", () => {
  describe("GET /heartbeat", () => {
    it("should return UP and DB connected", async () => {
      const res = await request(app).get("/heartbeat");
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe("UP");
      expect(res.body.db).toBe("CONNECTED");
    });
  });

  describe("GET /v1/registry/verifiers", () => {
    it("should return an array of verifiers", async () => {
      const res = await request(app).get("/v1/registry/verifiers");
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });
});
