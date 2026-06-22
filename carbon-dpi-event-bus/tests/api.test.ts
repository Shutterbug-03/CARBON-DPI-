/// <reference types="jest" />

import request from "supertest";
import { app } from "../src/index";

jest.mock("ioredis", () => {
  return jest.fn().mockImplementation(() => {
    return {
      ping: jest.fn().mockResolvedValue("PONG"),
      llen: jest.fn().mockResolvedValue(0), // return 0 so polling interval skips
      rpop: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue("OK"),
      on: jest.fn(),
    };
  });
});

describe("Event Bus API", () => {
  describe("GET /heartbeat", () => {
    it("should return UP and Redis connected", async () => {
      const res = await request(app).get("/heartbeat");
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe("UP");
      expect(res.body.redis).toBe("CONNECTED");
      expect(res.body.bufferSize).toBe(0);
    });
  });

  describe("POST /v1/ingest", () => {
    it("should return 400 for missing payload fields", async () => {
      const res = await request(app).post("/v1/ingest").send({});
      expect(res.statusCode).toBe(400);
    });
  });
});
