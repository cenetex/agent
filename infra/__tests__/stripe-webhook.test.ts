import { createHmac } from "crypto";

describe("Stripe webhook signature verification", () => {
  function verifyStripeSignature(
    rawBody: string,
    signatureHeader: string,
    secret: string
  ): boolean {
    const parts = signatureHeader.split(",");
    let timestamp = "";
    const signatures: string[] = [];

    for (const part of parts) {
      const [key, value] = part.split("=");
      if (key === "t") timestamp = value;
      else if (key === "v1") signatures.push(value);
    }

    if (!timestamp || signatures.length === 0) return false;

    const signedPayload = `${timestamp}.${rawBody}`;
    const expected = createHmac("sha256", secret)
      .update(signedPayload, "utf8")
      .digest("hex");

    for (const sig of signatures) {
      const sigBuffer = Buffer.from(sig, "hex");
      const expectedBuffer = Buffer.from(expected, "hex");
      if (
        sigBuffer.length === expectedBuffer.length &&
        sigBuffer.equals(expectedBuffer)
      ) {
        return true;
      }
    }

    return false;
  }

  const secret = "whsec_test_secret_12345";
  const rawBody = JSON.stringify({
    type: "checkout.session.completed",
    data: { object: { id: "cs_test_123", metadata: { repo_slug: "test/repo", credits: "50" } } },
  });
  const timestamp = "1700000000";

  function makeSignature(body: string, ts: string, s: string): string {
    const signed = `${ts}.${body}`;
    const sig = createHmac("sha256", s).update(signed, "utf8").digest("hex");
    return `t=${ts},v1=${sig}`;
  }

  it("accepts a valid signature", () => {
    const header = makeSignature(rawBody, timestamp, secret);
    expect(verifyStripeSignature(rawBody, header, secret)).toBe(true);
  });

  it("rejects an invalid signature", () => {
    const header = makeSignature(rawBody, timestamp, "wrong_secret");
    expect(verifyStripeSignature(rawBody, header, secret)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifyStripeSignature(rawBody, "", secret)).toBe(false);
  });

  it("rejects a header with no v1 component", () => {
    expect(verifyStripeSignature(rawBody, `t=${timestamp}`, secret)).toBe(false);
  });

  it("rejects a header with no timestamp", () => {
    const sig = createHmac("sha256", secret)
      .update(`.${rawBody}`, "utf8")
      .digest("hex");
    expect(verifyStripeSignature(rawBody, `v1=${sig}`, secret)).toBe(false);
  });

  it("rejects a tampered body", () => {
    const header = makeSignature(rawBody, timestamp, secret);
    const tampered = rawBody.replace("50", "5000");
    expect(verifyStripeSignature(tampered, header, secret)).toBe(false);
  });

  it("accepts multiple v1 signatures (Stripe rotation)", () => {
    const validSig = createHmac("sha256", secret)
      .update(`${timestamp}.${rawBody}`, "utf8")
      .digest("hex");
    const oldSig = createHmac("sha256", "old_secret")
      .update(`${timestamp}.${rawBody}`, "utf8")
      .digest("hex");
    const header = `t=${timestamp},v1=${oldSig},v1=${validSig}`;
    expect(verifyStripeSignature(rawBody, header, secret)).toBe(true);
  });
});

describe("Stripe webhook purchase metadata extraction", () => {
  function extractPurchaseInfo(payload: any): {
    repoSlug: string;
    credits: number;
    sessionId: string;
  } | null {
    const metadata = payload?.data?.object?.metadata;
    if (!metadata) return null;

    const repoSlug = metadata.repo_slug;
    const credits = parseInt(metadata.credits, 10);
    const sessionId = payload?.data?.object?.id;

    if (!repoSlug || !Number.isFinite(credits) || credits <= 0 || !sessionId) {
      return null;
    }

    return { repoSlug, credits, sessionId };
  }

  it("extracts valid purchase metadata", () => {
    const payload = {
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_123",
          metadata: { repo_slug: "cenetex/agent", credits: "100" },
        },
      },
    };
    const result = extractPurchaseInfo(payload);
    expect(result).toEqual({
      repoSlug: "cenetex/agent",
      credits: 100,
      sessionId: "cs_test_123",
    });
  });

  it("returns null for missing metadata", () => {
    const payload = { type: "checkout.session.completed", data: { object: {} } };
    expect(extractPurchaseInfo(payload)).toBeNull();
  });

  it("returns null for missing repo_slug", () => {
    const payload = {
      type: "checkout.session.completed",
      data: { object: { id: "cs_test", metadata: { credits: "50" } } },
    };
    expect(extractPurchaseInfo(payload)).toBeNull();
  });

  it("returns null for missing credits", () => {
    const payload = {
      type: "checkout.session.completed",
      data: { object: { id: "cs_test", metadata: { repo_slug: "test/repo" } } },
    };
    expect(extractPurchaseInfo(payload)).toBeNull();
  });

  it("returns null for zero credits", () => {
    const payload = {
      type: "checkout.session.completed",
      data: { object: { id: "cs_test", metadata: { repo_slug: "test/repo", credits: "0" } } },
    };
    expect(extractPurchaseInfo(payload)).toBeNull();
  });

  it("returns null for negative credits", () => {
    const payload = {
      type: "checkout.session.completed",
      data: { object: { id: "cs_test", metadata: { repo_slug: "test/repo", credits: "-10" } } },
    };
    expect(extractPurchaseInfo(payload)).toBeNull();
  });

  it("returns null for missing session id", () => {
    const payload = {
      type: "checkout.session.completed",
      data: { object: { metadata: { repo_slug: "test/repo", credits: "50" } } },
    };
    expect(extractPurchaseInfo(payload)).toBeNull();
  });
});
