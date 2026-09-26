import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real featureFlags.smsNotifications constant is hardcoded to `false` in
// @workspace/plans (see lib/plans/src/index.ts). That is correct for
// production today, but it means sendSms() can never reach the provider in
// its default state. To test the provider integration itself we mock the
// flag on, the same way we'd want a future SMS_NOTIFICATIONS_ENABLED env var
// to behave. See the "feature flag gate" describe block below for a test
// against the *real*, un-mocked flag value.
const flagState = vi.hoisted(() => ({ smsNotifications: true }));

vi.mock("@workspace/plans", () => ({
  isFeatureEnabled: (flag: string) =>
    flag === "smsNotifications" ? flagState.smsNotifications : false,
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const ORIGINAL_ENV = { ...process.env };
const fetchMock = vi.fn();

function mockAuthOk(token = "test-token", expiresInMinutes = 20) {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ token, expiresInMinutes }),
  } as Response);
}

// sms.ts keeps its SMSPortal auth token in a module-level variable
// (`cachedToken`) that persists for the lifetime of the loaded module. That
// is fine in the running server (one process, one set of credentials) but it
// means tests must get a *fresh* module instance each time, or a token
// cached by one test leaks into the next and throws off the mocked
// fetch-call sequence. vi.resetModules() + a per-test dynamic import gives
// each test its own isolated cachedToken.
let isSmsConfigured: typeof import("../lib/sms").isSmsConfigured;
let sendSms: typeof import("../lib/sms").sendSms;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  flagState.smsNotifications = true;
  process.env = { ...ORIGINAL_ENV };
  delete process.env.SMSPORTAL_CLIENT_ID;
  delete process.env.SMSPORTAL_API_SECRET;
  delete process.env.SMS_SENDER_ID;
  vi.stubGlobal("fetch", fetchMock);
  const mod = await import("../lib/sms");
  isSmsConfigured = mod.isSmsConfigured;
  sendSms = mod.sendSms;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

describe("SMS provider configuration", () => {
  it("isSmsConfigured() is false with no credentials, even with the flag on", () => {
    expect(isSmsConfigured()).toBe(false);
  });

  it("isSmsConfigured() is false with credentials but the flag off", () => {
    process.env.SMSPORTAL_CLIENT_ID = "client-1";
    process.env.SMSPORTAL_API_SECRET = "secret-1";
    flagState.smsNotifications = false;
    expect(isSmsConfigured()).toBe(false);
  });

  it("isSmsConfigured() is true only when the flag is on AND both credentials exist", () => {
    process.env.SMSPORTAL_CLIENT_ID = "client-1";
    process.env.SMSPORTAL_API_SECRET = "secret-1";
    flagState.smsNotifications = true;
    expect(isSmsConfigured()).toBe(true);
  });

  it("isSmsConfigured() is false when only one of the two credentials is set", () => {
    process.env.SMSPORTAL_CLIENT_ID = "client-1";
    expect(isSmsConfigured()).toBe(false);
  });
});

describe("SMS provider — feature flag gate (real, un-mocked value)", () => {
  it("the real featureFlags.smsNotifications constant is currently false", async () => {
    // Import the un-mocked module directly to confirm production behaviour:
    // today, SMS is hard-disabled in source regardless of env credentials.
    const { isFeatureEnabled } = await vi.importActual<
      typeof import("@workspace/plans")
    >("@workspace/plans");
    expect(isFeatureEnabled("smsNotifications")).toBe(false);
  });
});

describe("sendSms — successful send", () => {
  beforeEach(() => {
    process.env.SMSPORTAL_CLIENT_ID = "client-1";
    process.env.SMSPORTAL_API_SECRET = "secret-1";
  });

  it("authenticates, posts the message, and returns the provider message id", async () => {
    mockAuthOk();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ messageId: "msg-123" }] }),
    } as Response);

    const result = await sendSms({ to: "+27 71 234 5678", body: "Your order has shipped" });

    expect(result).toEqual({ success: true, providerMessageId: "msg-123" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [authUrl, authInit] = fetchMock.mock.calls[0];
    expect(authUrl).toBe("https://rest.smsportal.com/Authentication");
    expect(authInit.headers.Authorization).toMatch(/^Basic /);

    const [sendUrl, sendInit] = fetchMock.mock.calls[1];
    expect(sendUrl).toBe("https://rest.smsportal.com/BulkMessages");
    expect(sendInit.headers.Authorization).toBe("Bearer test-token");
    const body = JSON.parse(sendInit.body);
    expect(body.messages[0]).toEqual({
      content: "Your order has shipped",
      destination: "+27712345678", // normalised: spaces stripped
    });
  });

  it("includes the configured sender ID when SMS_SENDER_ID is set", async () => {
    process.env.SMS_SENDER_ID = "Acme";
    mockAuthOk();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ messageId: "msg-1" }] }),
    } as Response);

    await sendSms({ to: "+27712345678", body: "Hi" });

    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.sendOptions).toEqual({ senderId: "Acme" });
  });

  it("caches the auth token and does not re-authenticate on the next send", async () => {
    mockAuthOk("token-A", 20);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ messageId: "msg-1" }] }),
    } as Response);
    await sendSms({ to: "+27712345678", body: "First" });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ messageId: "msg-2" }] }),
    } as Response);
    await sendSms({ to: "+27712345678", body: "Second" });

    // 2 calls for the first send (auth + send), only 1 more for the second
    // send (send only) because the token is cached.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("sendSms — missing / invalid credentials", () => {
  it("returns a skipped failure and does not call fetch when credentials are absent", async () => {
    const result = await sendSms({ to: "+27712345678", body: "Hi" });

    expect(result).toEqual({
      success: false,
      error: "SMS provider not configured",
      skipped: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a skipped failure when only the client ID is set (partial credentials)", async () => {
    process.env.SMSPORTAL_CLIENT_ID = "client-1";

    const result = await sendSms({ to: "+27712345678", body: "Hi" });

    expect(result.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a clean error when the provider rejects the auth credentials (401 on Authentication)", async () => {
    process.env.SMSPORTAL_CLIENT_ID = "bad-client";
    process.env.SMSPORTAL_API_SECRET = "bad-secret";
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "Invalid client credentials",
    } as Response);

    const result = await sendSms({ to: "+27712345678", body: "Hi" });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("SMSPortal authentication failed");
    }
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry loop on auth failure itself
  });
});

describe("sendSms — the feature flag is a hard gate", () => {
  it("never calls fetch when the flag is off, even with valid credentials present", async () => {
    process.env.SMSPORTAL_CLIENT_ID = "client-1";
    process.env.SMSPORTAL_API_SECRET = "secret-1";
    flagState.smsNotifications = false;

    const result = await sendSms({ to: "+27712345678", body: "Hi" });

    expect(result).toEqual({ success: false, error: "SMS channel disabled", skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("sendSms — provider errors are handled without crashing", () => {
  beforeEach(() => {
    process.env.SMSPORTAL_CLIENT_ID = "client-1";
    process.env.SMSPORTAL_API_SECRET = "secret-1";
  });

  it("returns a failure result (not a throw) when BulkMessages responds with 5xx", async () => {
    mockAuthOk();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => "Service temporarily unavailable",
    } as Response);

    await expect(
      sendSms({ to: "+27712345678", body: "Hi" }),
    ).resolves.toEqual({ success: false, error: "SMSPortal send failed (503)" });
  });

  it("re-authenticates once and retries on a 401 mid-send, then succeeds", async () => {
    mockAuthOk("stale-token");
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => "expired" } as Response);
    mockAuthOk("fresh-token");
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ messageId: "msg-retry" }] }),
    } as Response);

    const result = await sendSms({ to: "+27712345678", body: "Hi" });

    expect(result).toEqual({ success: true, providerMessageId: "msg-retry" });
    expect(fetchMock).toHaveBeenCalledTimes(4); // auth, send(401), re-auth, send(ok)
  });

  it("does not throw when the network call itself rejects (timeout/DNS/etc.)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("fetch failed: ETIMEDOUT"));

    await expect(
      sendSms({ to: "+27712345678", body: "Hi" }),
    ).resolves.toEqual({ success: false, error: "fetch failed: ETIMEDOUT" });
  });

  it("does not throw when the send response body is not valid JSON", async () => {
    mockAuthOk();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    } as unknown as Response);

    const result = await sendSms({ to: "+27712345678", body: "Hi" });
    expect(result.success).toBe(true); // falls back to {} and an undefined messageId
  });
});

describe("sendSms — invalid destination number", () => {
  beforeEach(() => {
    process.env.SMSPORTAL_CLIENT_ID = "client-1";
    process.env.SMSPORTAL_API_SECRET = "secret-1";
  });

  it("rejects an empty/whitespace-only number before calling the provider", async () => {
    const result = await sendSms({ to: "   ", body: "Hi" });
    expect(result).toEqual({ success: false, error: "Invalid destination number" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a number with no digits at all", async () => {
    const result = await sendSms({ to: "not-a-number", body: "Hi" });
    expect(result).toEqual({ success: false, error: "Invalid destination number" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("BUG: does not reject a digit string that is not a plausible phone number", async () => {
    // normaliseNumber() only strips non-digit/non-plus characters; it never
    // checks length or a country-code prefix. "123" survives normalisation
    // and is sent to the provider as-is. This is a real gap — flagged in the
    // test report as a recommended fix (add a minimum-length / E.164 check).
    mockAuthOk();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ messageId: "msg-1" }] }),
    } as Response);

    const result = await sendSms({ to: "123", body: "Hi" });

    expect(result.success).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.messages[0].destination).toBe("123");
  });
});
