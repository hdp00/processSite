import { Inject, Injectable, Optional } from "@nestjs/common";
import { ProblemException } from "../common/http/problem-details.js";

const DEFAULT_WINDOW_MS = 15 * 60 * 1_000;
const DEFAULT_BLOCK_MS = 15 * 60 * 1_000;
const DEFAULT_ACCOUNT_IP_FAILURE_LIMIT = 5;
const DEFAULT_IP_FAILURE_LIMIT = 100;
const DEFAULT_UNAVAILABLE_WINDOW_MS = 60 * 1_000;
const DEFAULT_UNAVAILABLE_BLOCK_MS = 60 * 1_000;
const DEFAULT_UNAVAILABLE_IP_LIMIT = 60;
const DEFAULT_GLOBAL_IN_FLIGHT_LIMIT = 4;
const DEFAULT_IP_IN_FLIGHT_LIMIT = 2;

interface FailureBucket {
  failures: number[];
  blockedUntil?: number;
  lastActivity: number;
}

export interface LoginRateLimitOptions {
  windowMs: number;
  blockMs: number;
  accountIpFailureLimit: number;
  ipFailureLimit: number;
  unavailableWindowMs: number;
  unavailableBlockMs: number;
  unavailableIpLimit: number;
  globalInFlightLimit: number;
  ipInFlightLimit: number;
}

export const LOGIN_RATE_LIMIT_OPTIONS = Symbol("LOGIN_RATE_LIMIT_OPTIONS");

const defaultOptions: LoginRateLimitOptions = {
  windowMs: DEFAULT_WINDOW_MS,
  blockMs: DEFAULT_BLOCK_MS,
  accountIpFailureLimit: DEFAULT_ACCOUNT_IP_FAILURE_LIMIT,
  ipFailureLimit: DEFAULT_IP_FAILURE_LIMIT,
  unavailableWindowMs: DEFAULT_UNAVAILABLE_WINDOW_MS,
  unavailableBlockMs: DEFAULT_UNAVAILABLE_BLOCK_MS,
  unavailableIpLimit: DEFAULT_UNAVAILABLE_IP_LIMIT,
  globalInFlightLimit: DEFAULT_GLOBAL_IN_FLIGHT_LIMIT,
  ipInFlightLimit: DEFAULT_IP_IN_FLIGHT_LIMIT,
};

const activeFailures = (bucket: FailureBucket, now: number, windowMs: number): number[] => (
  bucket.failures.filter((timestamp) => timestamp > now - windowMs)
);

const retryAfterSeconds = (blockedUntil: number, now: number): number => Math.max(1, Math.ceil((blockedUntil - now) / 1_000));

const rateLimited = (seconds: number, detail = "登录失败次数已达到临时限制，请稍后重试。") => new ProblemException({
  status: 429,
  code: "RATE_LIMITED",
  title: "登录尝试过于频繁",
  detail,
  retryAfterSeconds: seconds,
});

@Injectable()
export class LoginRateLimiter {
  private readonly accountIpBuckets = new Map<string, FailureBucket>();
  private readonly ipBuckets = new Map<string, FailureBucket>();
  private readonly unavailableIpBuckets = new Map<string, FailureBucket>();
  private readonly inFlightByIp = new Map<string, number>();
  private inFlightTotal = 0;
  private operationsSinceSweep = 0;

  private readonly options: LoginRateLimitOptions;

  constructor(
    @Optional() @Inject(LOGIN_RATE_LIMIT_OPTIONS) options?: LoginRateLimitOptions,
  ) {
    this.options = options ?? defaultOptions;
  }

  assertAllowed(normalizedLoginName: string, clientIp: string, now = Date.now()): void {
    this.maybeSweep(now);
    const accountBucket = this.readActiveBucket(this.accountIpBuckets, this.accountIpKey(normalizedLoginName, clientIp), now);
    const ipBucket = this.readActiveBucket(this.ipBuckets, clientIp, now);
    const unavailableIpBucket = this.readActiveBucket(
      this.unavailableIpBuckets,
      clientIp,
      now,
      this.options.unavailableWindowMs,
    );
    const blockedUntil = Math.max(
      accountBucket?.blockedUntil ?? 0,
      ipBucket?.blockedUntil ?? 0,
      unavailableIpBucket?.blockedUntil ?? 0,
    );
    if (blockedUntil > now) throw rateLimited(retryAfterSeconds(blockedUntil, now));
  }

  recordFailure(normalizedLoginName: string, clientIp: string, now = Date.now()): void {
    this.record(this.accountIpBuckets, this.accountIpKey(normalizedLoginName, clientIp), this.options.accountIpFailureLimit, now);
    this.record(this.ipBuckets, clientIp, this.options.ipFailureLimit, now);
  }

  recordUnavailableAttempt(clientIp: string, now = Date.now()): void {
    this.record(
      this.unavailableIpBuckets,
      clientIp,
      this.options.unavailableIpLimit,
      now,
      this.options.unavailableWindowMs,
      this.options.unavailableBlockMs,
    );
  }

  recordSuccess(normalizedLoginName: string, clientIp: string): void {
    this.accountIpBuckets.delete(this.accountIpKey(normalizedLoginName, clientIp));
  }

  acquireAuthenticationSlot(clientIp: string): () => void {
    const ipInFlight = this.inFlightByIp.get(clientIp) ?? 0;
    if (
      this.inFlightTotal >= this.options.globalInFlightLimit
      || ipInFlight >= this.options.ipInFlightLimit
    ) {
      throw rateLimited(1, "当前登录验证并发较高，请稍后重试。");
    }

    this.inFlightTotal += 1;
    this.inFlightByIp.set(clientIp, ipInFlight + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlightTotal -= 1;
      const remainingForIp = (this.inFlightByIp.get(clientIp) ?? 1) - 1;
      if (remainingForIp <= 0) this.inFlightByIp.delete(clientIp);
      else this.inFlightByIp.set(clientIp, remainingForIp);
    };
  }

  private record(
    buckets: Map<string, FailureBucket>,
    key: string,
    limit: number,
    now: number,
    windowMs = this.options.windowMs,
    blockMs = this.options.blockMs,
  ): void {
    const current = this.readActiveBucket(buckets, key, now, windowMs) ?? { failures: [], lastActivity: now };
    const failures = [...current.failures, now];
    buckets.set(key, {
      failures,
      lastActivity: now,
      ...(failures.length >= limit ? { blockedUntil: now + blockMs } : {}),
    });
  }

  private readActiveBucket(
    buckets: Map<string, FailureBucket>,
    key: string,
    now: number,
    windowMs = this.options.windowMs,
  ): FailureBucket | undefined {
    const bucket = buckets.get(key);
    if (!bucket) return undefined;
    const failures = activeFailures(bucket, now, windowMs);
    const blockedUntil = bucket.blockedUntil && bucket.blockedUntil > now ? bucket.blockedUntil : undefined;
    if (!failures.length && blockedUntil === undefined) {
      buckets.delete(key);
      return undefined;
    }
    const active: FailureBucket = {
      failures,
      lastActivity: bucket.lastActivity,
      ...(blockedUntil !== undefined ? { blockedUntil } : {}),
    };
    buckets.set(key, active);
    return active;
  }

  private accountIpKey(normalizedLoginName: string, clientIp: string): string {
    return `${normalizedLoginName}\u0000${clientIp}`;
  }

  private maybeSweep(now: number): void {
    this.operationsSinceSweep += 1;
    if (this.operationsSinceSweep < 256) return;
    this.operationsSinceSweep = 0;
    const sweep = (buckets: Map<string, FailureBucket>, oldestRelevantTime: number): void => {
      buckets.forEach((bucket, key) => {
        if (bucket.lastActivity < oldestRelevantTime && (bucket.blockedUntil ?? 0) <= now) buckets.delete(key);
      });
    };
    sweep(this.accountIpBuckets, now - this.options.windowMs - this.options.blockMs);
    sweep(this.ipBuckets, now - this.options.windowMs - this.options.blockMs);
    sweep(
      this.unavailableIpBuckets,
      now - this.options.unavailableWindowMs - this.options.unavailableBlockMs,
    );
  }
}
