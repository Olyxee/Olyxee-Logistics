import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockIsFeatureEnabled = vi.fn();
vi.mock("@workspace/plans", () => ({
  isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
}));

import {
  sendSms,
  isSmsConfigured,
  isValidPhoneNumber,
  normalisePhoneNumber,
  _smsPortalProviderForTests,
  _resetSmsPortalTokenCacheForTests,
} from "../lib/sms";

const ORIGINAL_ENV = { ...process.env };

describe("phone number validation", () => {
  it("accepts E.164 numbers", () => {
    expect(isValidPhoneNumber("+27821234567")).toBe(true);
  });

  it("accepts plain local-format numbers", () => {
    expect(isValidPhoneNumber("0821234567")).toBe(true);
  });

  it("accepts numbers with formatting punctuation", () => {
    expect(isValidPhoneNumber("+27 82 123 4567")).toBe(true);
  });

  it("rejects missing numbers", () => {
    expect(isValidPhoneNumber(undefined)).toBe(false);
    expect(isValidPhoneNumber(null)).toBe(false);
    expect(isValidPhoneNumber("")).toBe(false);
  });

  it("rejects numbers that are too short", () => {
    expect(isValidPhoneNumber("12345")).toBe(false);
  });

  it("rejects numbers that are too long", () => {
    expect(isValidPhoneNumber("1234567890123456")).toBe(false);
  });

  it("rejects a '+' that isn't the leading character", () => {
    expect(isValidPhoneNumber("082+1234567")).toBe(false);
  });

  it("rejects non-numeric junk", () => {
    expect(isValidPhoneNumber("not-a-phone-number")).toBe(false);
  });

  it("strips formatting characters when normalising", () => {
    expect(normalisePhoneNumber("+27 (82) 123-4567")).toBe("+27821234567");
  });
});

describe("sendSms - feature flag and validation gating", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    mockIsFeatureEnabled.mockReturnValue(false);
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("is skipped when the SMS feature flag is off, regardless of credentials", async () => {
    process.env.SMSPORTAL_CLIENT_ID = "id";
    process.env.SMSPORTAL_API_SECRET = "secret";
    mockIsFeatureEnabled.mockReturnValue(false);

    const result = await sendSms({ to: "+27821234567", body: "hi" });

    expect(result).toEqual({ success: false, error: "SMS channel disabled", skipped: true });
  });

  it("rejects an invalid destination number before touching a provider", async () => {
    mockIsFeatureEnabled.mockReturnValue(true);

    const result = await sendSms({ to: "123", body: "hi" });

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toMatch(/invalid/i);
  });

  it("reports not-configured (via isSmsConfigured) when the flag is off", () => {
    mockIsFeatureEnabled.mockReturnValue(false);
    process.env.SMSPORTAL_CLIENT_ID = "id";
    process.env.SMSPORTAL_API_SECRET = "secret";

    expect(isSmsConfigured()).toBe(false);
  });
});

describe("sendSms - test mode never reaches a real provider", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, NODE_ENV: "test" };
    mockIsFeatureEnabled.mockReturnValue(true);
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("succeeds without any provider credentials configured", async () => {
    delete process.env.SMSPORTAL_CLIENT_ID;
    delete process.env.SMSPORTAL_API_SECRET;
    expect(isSmsConfigured()).toBe(true);

    const result = await sendSms({ to: "+27821234567", body: "Your order shipped" });

    expect(result.success).toBe(true);
    expect((result as { providerMessageId?: string }).providerMessageId).toMatch(/^noop-/);
  });

  it("ignores SMS_PROVIDER=smsportal while NODE_ENV=test", async () => {
    process.env.SMS_PROVIDER = "smsportal";
    process.env.SMSPORTAL_CLIENT_ID = "id";
    process.env.SMSPORTAL_API_SECRET = "secret";
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await sendSms({ to: "+27821234567", body: "hi" });

    expect(result.success).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("sendSms - provider selection is fail-safe outside test mode", () => {
  // NODE_ENV is deliberately NOT "test" in this block so resolveProviderId's
  // real SMS_PROVIDER handling runs, instead of the always-noop test-mode
  // override exercised above.
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.NODE_ENV;
    mockIsFeatureEnabled.mockReturnValue(true);
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("selects noop for the exact value 'noop'", async () => {
    process.env.SMS_PROVIDER = "noop";
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await sendSms({ to: "+27821234567", body: "hi" });

    expect(result.success).toBe(true);
    expect((result as { providerMessageId?: string }).providerMessageId).toMatch(/^noop-/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("selects SMSPortal for the exact value 'smsportal'", async () => {
    process.env.SMS_PROVIDER = "smsportal";
    // No credentials configured - if SMSPortal was really selected, this
    // must fail with its own "not configured" message rather than the noop
    // provider's always-succeeds behavior. That distinguishes the two paths.
    delete process.env.SMSPORTAL_CLIENT_ID;
    delete process.env.SMSPORTAL_API_SECRET;

    const result = await sendSms({ to: "+27821234567", body: "hi" });

    expect(result).toEqual({ success: false, error: "SMS provider not configured", skipped: true });
  });

  it("falls back to noop (never SMSPortal) for an unrecognized SMS_PROVIDER value, and warns", async () => {
    process.env.SMS_PROVIDER = "no-op"; // typo of "noop"
    process.env.SMSPORTAL_CLIENT_ID = "id";
    process.env.SMSPORTAL_API_SECRET = "secret";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { logger } = await import("../lib/logger");
    const warnSpy = vi.spyOn(logger, "warn");

    const result = await sendSms({ to: "+27821234567", body: "hi" });

    expect(result.success).toBe(true);
    expect((result as { providerMessageId?: string }).providerMessageId).toMatch(/^noop-/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ SMS_PROVIDER: "no-op" }),
      expect.stringContaining("Unrecognized SMS_PROVIDER"),
    );
  });

  it("falls back to noop for a nonsense SMS_PROVIDER value even with real credentials present", async () => {
    process.env.SMS_PROVIDER = "twilio";
    process.env.SMSPORTAL_CLIENT_ID = "id";
    process.env.SMSPORTAL_API_SECRET = "secret";
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await sendSms({ to: "+27821234567", body: "hi" });

    expect(result.success).toBe(true);
    expect((result as { providerMessageId?: string }).providerMessageId).toMatch(/^noop-/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still defaults to SMSPortal when SMS_PROVIDER is unset (documented default)", async () => {
    delete process.env.SMS_PROVIDER;
    delete process.env.SMSPORTAL_CLIENT_ID;
    delete process.env.SMSPORTAL_API_SECRET;

    const result = await sendSms({ to: "+27821234567", body: "hi" });

    expect(result).toEqual({ success: false, error: "SMS provider not configured", skipped: true });
  });
});

describe("SMSPortal provider (HTTP contract, tested directly)", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, SMSPORTAL_CLIENT_ID: "client", SMSPORTAL_API_SECRET: "secret" };
    _resetSmsPortalTokenCacheForTests();
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("authenticates then sends, returning the provider message id", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: "tok_1", expiresInMinutes: 20 }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [{ messageId: "msg_1" }] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await _smsPortalProviderForTests.send({ to: "+27821234567", body: "Your order shipped" });

    expect(result).toEqual({ success: true, providerMessageId: "msg_1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain("/Authentication");
    expect(fetchMock.mock.calls[1][0]).toContain("/BulkMessages");
    const sendCall = fetchMock.mock.calls[1][1] as RequestInit;
    expect(sendCall.headers).toMatchObject({ Authorization: "Bearer tok_1" });
  });

  it("re-authenticates once and retries after a 401, without failing the send", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "tok_stale" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "tok_fresh" }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [{ messageId: "msg_2" }] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await _smsPortalProviderForTests.send({ to: "+27821234567", body: "hi" });

    expect(result).toEqual({ success: true, providerMessageId: "msg_2" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("returns a clean failure when the provider rejects the message", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "tok_1" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await _smsPortalProviderForTests.send({ to: "+27821234567", body: "hi" });

    expect(result.success).toBe(false);
    expect((result as { error: string }).error).toContain("400");
  });

  it("returns a clean failure when the provider is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const result = await _smsPortalProviderForTests.send({ to: "+27821234567", body: "hi" });

    expect(result).toEqual({ success: false, error: "network down" });
  });

  it("skips sending when credentials are missing", async () => {
    delete process.env.SMSPORTAL_CLIENT_ID;
    delete process.env.SMSPORTAL_API_SECRET;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await _smsPortalProviderForTests.send({ to: "+27821234567", body: "hi" });

    expect(result).toEqual({ success: false, error: "SMS provider not configured", skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never leaks the API secret into the result returned to callers", async () => {
    process.env.SMSPORTAL_API_SECRET = "super-secret-value-should-never-leak";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));

    const result = await _smsPortalProviderForTests.send({ to: "+27821234567", body: "hi" });

    expect(JSON.stringify(result)).not.toContain("super-secret-value-should-never-leak");
  });
});
