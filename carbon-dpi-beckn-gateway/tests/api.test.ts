/// <reference types="jest" />

import request from "supertest";
import { app } from "../src/index";

describe("Beckn Gateway API", () => {
  describe("GET /heartbeat", () => {
    it("should return UP", async () => {
      const res = await request(app).get("/heartbeat");
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe("UP");
    });
  });

  describe("POST /v1/search", () => {
    it("should accept valid beckn format and acknowledge", async () => {
      const res = await request(app).post("/v1/search").send({ context: {}, message: {} });
      expect(res.statusCode).toBe(200);
      expect(res.body.message.ack.status).toBe("ACK");
    });
  });
});
