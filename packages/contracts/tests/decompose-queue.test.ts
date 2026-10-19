import { describe, expect, it } from "vitest";
import { DecomposeQueuePollRequest, DecomposeQueuePollResponse, DecomposeQueueTicket } from "../src/ai";

const ticket = { requestId: "7e9ca34f-90ee-403c-acf0-734a27e89440", endpointId: "fal-ai/qwen-image-layered" };

describe("private durable layer queue contract", () => {
  it("accepts only a safe identifier and model path, never provider URLs", () => {
    expect(DecomposeQueueTicket.parse(ticket)).toEqual(ticket);
    for (const requestId of ["", "../x", "id/query", "id?key=x", "id#x", "a".repeat(129), 3]) {
      expect(DecomposeQueueTicket.safeParse({ ...ticket, requestId }).success).toBe(false);
    }
    for (const endpointId of ["https://evil.test", "fal-ai/../other", "fal-ai//other", "fal-ai/model?x", "fal-ai/model/", "x".repeat(201)]) {
      expect(DecomposeQueueTicket.safeParse({ ...ticket, endpointId }).success).toBe(false);
    }
    expect(DecomposeQueueTicket.safeParse({ ...ticket, statusUrl: "https://evil.test" }).success).toBe(false);
  });

  it("requires explicit never retry policy for resume", () => {
    expect(DecomposeQueuePollRequest.parse({ ...ticket, providerRetryPolicy: "never" }).requestId).toBe(ticket.requestId);
    for (const providerRetryPolicy of [undefined, null, "always"]) {
      expect(DecomposeQueuePollRequest.safeParse({ ...ticket, providerRetryPolicy }).success).toBe(false);
    }
  });

  it("does not mistake a queue acknowledgment for finished layers", () => {
    for (const status of ["IN_QUEUE", "IN_PROGRESS"]) {
      expect(DecomposeQueuePollResponse.parse({ status })).toEqual({ status });
      expect(DecomposeQueuePollResponse.safeParse({ status, result: {} }).success).toBe(false);
    }
    expect(DecomposeQueuePollResponse.safeParse({ status: "COMPLETED" }).success).toBe(false);
    expect(DecomposeQueuePollResponse.safeParse({ status: "UNKNOWN" }).success).toBe(false);
    const completed = { status: "COMPLETED", result: { layers: [{ imageUrl: "https://v3.fal.media/layer.png", width: 640, height: 640 }], seed: 12 } };
    expect(DecomposeQueuePollResponse.parse(completed)).toEqual(completed);
  });
});
