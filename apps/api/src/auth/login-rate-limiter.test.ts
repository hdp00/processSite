import { describe, expect, it } from "vitest";
import { ProblemException } from "../common/http/problem-details.js";
import { LoginRateLimiter } from "./login-rate-limiter.js";

const testOptions = {
  windowMs: 1_000,
  blockMs: 2_000,
  accountIpFailureLimit: 2,
  ipFailureLimit: 3,
  unavailableWindowMs: 500,
  unavailableBlockMs: 750,
  unavailableIpLimit: 2,
  globalInFlightLimit: 3,
  ipInFlightLimit: 2,
};

describe("LoginRateLimiter", () => {
  it("blocks an account and IP pair after the configured number of failures", () => {
    const limiter = new LoginRateLimiter(testOptions);
    limiter.recordFailure("alice", "10.0.0.1", 100);
    limiter.recordFailure("alice", "10.0.0.1", 200);

    expect(() => limiter.assertAllowed("alice", "10.0.0.1", 201)).toThrowError(ProblemException);
    try {
      limiter.assertAllowed("alice", "10.0.0.1", 201);
    } catch (error) {
      expect(error).toBeInstanceOf(ProblemException);
      expect((error as ProblemException).problem).toMatchObject({ status: 429, code: "RATE_LIMITED" });
    }
    expect(() => limiter.assertAllowed("alice", "10.0.0.1", 2_201)).not.toThrow();
  });

  it("clears only the account dimension after success and retains the IP total", () => {
    const limiter = new LoginRateLimiter(testOptions);
    limiter.recordFailure("alice", "10.0.0.2", 100);
    limiter.recordFailure("bob", "10.0.0.2", 200);
    limiter.recordFailure("carol", "10.0.0.2", 300);
    limiter.recordSuccess("alice", "10.0.0.2");

    expect(() => limiter.assertAllowed("alice", "10.0.0.2", 301)).toThrowError(ProblemException);
  });

  it("bounds authentication work globally and per IP and releases slots idempotently", () => {
    const limiter = new LoginRateLimiter(testOptions);
    const releaseFirst = limiter.acquireAuthenticationSlot("10.0.0.3");
    const releaseSecond = limiter.acquireAuthenticationSlot("10.0.0.3");

    expect(() => limiter.acquireAuthenticationSlot("10.0.0.3")).toThrowError(ProblemException);
    const releaseThird = limiter.acquireAuthenticationSlot("10.0.0.4");
    expect(() => limiter.acquireAuthenticationSlot("10.0.0.5")).toThrowError(ProblemException);

    releaseFirst();
    releaseFirst();
    const releaseFourth = limiter.acquireAuthenticationSlot("10.0.0.5");
    releaseSecond();
    releaseThird();
    releaseFourth();
  });

  it("limits repeated domain-unavailable attempts only by client IP", () => {
    const limiter = new LoginRateLimiter(testOptions);
    limiter.recordUnavailableAttempt("10.0.0.6", 100);
    limiter.recordUnavailableAttempt("10.0.0.6", 200);

    expect(() => limiter.assertAllowed("alice", "10.0.0.6", 201)).toThrowError(ProblemException);
    expect(() => limiter.assertAllowed("bob", "10.0.0.6", 201)).toThrowError(ProblemException);
    expect(() => limiter.assertAllowed("alice", "10.0.0.7", 201)).not.toThrow();
    expect(() => limiter.assertAllowed("alice", "10.0.0.6", 951)).not.toThrow();
  });
});
