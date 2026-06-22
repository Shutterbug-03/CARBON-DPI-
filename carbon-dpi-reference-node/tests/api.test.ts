/// <reference types="jest" />

import request from "supertest";
import { app } from "../src/index";
import { PrismaClient } from "@prisma/client-node";

// Mock prisma to avoid hitting a real DB in simple tests
jest.mock("@prisma/client-node", () => {
  const mPrismaClient = {
    $queryRaw: jest.fn().mockResolvedValue([{ 1: 1 }]),
    transaction: {
      count: jest.fn().mockResolvedValue(0),
    },
  };
  return { PrismaClient: jest.fn(() => mPrismaClient) };
});

describe("Reference Node API", () => {
  describe("GET /heartbeat", () => {
    it("should return UP and DB connected", async () => {
      const res = await request(app).get("/heartbeat");
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe("UP");
      expect(res.body.db).toBe("CONNECTED");
    });
  });

  describe("GET /v1/status", () => {
    it("should return node status and subscriber ID", async () => {
      const res = await request(app).get("/v1/status");
      expect(res.statusCode).toBe(200);
      expect(res.body.subscriber_id).toBeDefined();
    });
  });
});
