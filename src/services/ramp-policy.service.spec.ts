import { ApiError } from "../util/errors";
import { parseAmount } from "../util/money";
import { mintStateOf } from "./ramp-disputes.service";
import { RampEventProcessingError } from "./ramp-fulfilment.service";
import { MOCK_QR_PNG } from "./ramp-provider-mock.service";
import {
  cardExposure,
  checkoutUrlProblem,
  eripRefundProblem,
  offrampLedgerOutcome,
  quantizeUp,
  quoteRamp,
  rampFee,
  rampNextProblem,
  RampPolicyService,
  userComplianceReason,
  withdrawableBeyondExposure,
  type RampNextContext,
} from "./ramp-policy.service";
import { rampCommandId } from "./ramp-token-sync.service";

const a = parseAmount;
const NO_FEE = { feeBps: 0, feeFixed: 0n };

describe("ramp policy (docs/RAMP.md §1, §6)", () => {
  it("quantizeUp rounds to the currency's smallest unit, never down", () => {
    expect(quantizeUp(a("1.001"), 2)).toBe(a("1.01"));
    expect(quantizeUp(a("1.01"), 2)).toBe(a("1.01"));
    expect(quantizeUp(a("0.0000000001"), 2)).toBe(a("0.01"));
    expect(quantizeUp(a("7"), 0)).toBe(a("7"));
  });

  it("rampFee = fixed + amount × bps, rounded up to kopecks", () => {
    expect(rampFee(a("100"), NO_FEE, 2)).toBe(0n);
    expect(rampFee(a("100"), { feeBps: 150, feeFixed: 0n }, 2)).toBe(a("1.5"));
    expect(rampFee(a("100"), { feeBps: 150, feeFixed: a("0.3") }, 2)).toBe(a("1.8"));
    // 0.35 % of 10.01 = 0.035035 → 0.04
    expect(rampFee(a("10.01"), { feeBps: 35, feeFixed: 0n }, 2)).toBe(a("0.04"));
  });

  it("on-ramp: the amount is the fiat charged; the fee comes off the tokens credited", () => {
    expect(quoteRamp("onramp", a("100"), { feeBps: 200, feeFixed: 0n }, 2, 6)).toEqual({
      fiatAmount: a("100"),
      tokenAmount: a("98"),
      fee: a("2"),
    });
  });

  it("off-ramp: the amount is the tokens withdrawn; the fee comes off the fiat paid out", () => {
    expect(quoteRamp("offramp", a("50"), { feeBps: 0, feeFixed: a("1") }, 2, 6)).toEqual({
      fiatAmount: a("49"),
      tokenAmount: a("50"),
      fee: a("1"),
    });
  });

  it.each([
    ["zero", "0", NO_FEE, /positive/],
    ["finer than kopecks", "10.001", NO_FEE, /2 decimals/],
    ["eaten by the fee", "1", { feeBps: 0, feeFixed: a("1") }, /cover the fee/],
  ])("refuses an amount that is %s", (_name, amount, fee, message) => {
    expect(() => quoteRamp("onramp", a(amount), fee, 2, 6)).toThrow(message);
    try {
      quoteRamp("onramp", a(amount), fee, 2, 6);
    } catch (err) {
      expect(ApiError.is(err) && err.code).toBe("validation_failed");
    }
  });

  it("refuses an amount finer than the token even when the fiat allows it", () => {
    expect(() => quoteRamp("offramp", a("1.5"), NO_FEE, 2, 0)).toThrow(/token's 0 decimals/);
  });

  it("withdrawableBeyondExposure adds back the payout being settled and never goes negative", () => {
    expect(withdrawableBeyondExposure(a("40"), a("10"), a("30"))).toBe(a("20"));
    expect(withdrawableBeyondExposure(a("5"), a("10"), a("30"))).toBe(0n);
    expect(withdrawableBeyondExposure(a("5"), 0n, 0n)).toBe(a("5"));
  });
});

/** The NAK delay the consumer uses after `attempts` (contention: the order lock was busy). */
const rampEventDelay = (attempts: number, contention = false): number =>
  new RampEventProcessingError("x", true, attempts, contention).delayMs;

describe("checkout links (E-D7, X15)", () => {
  const real = {
    provider: "bepaid",
    publicAppUrl: "https://app.test",
    checkoutHosts: ["checkout.bepaid.by"],
  };
  const mock = { provider: "mock", publicAppUrl: "http://app.test", checkoutHosts: [] };

  it("a real acquirer's link must be https on a listed host, without credentials", () => {
    expect(checkoutUrlProblem("https://checkout.bepaid.by/v2/confirm?token=x", real)).toBeNull();
    expect(checkoutUrlProblem("https://CHECKOUT.bepaid.by/x", real)).toBeNull();
    expect(checkoutUrlProblem("http://checkout.bepaid.by/x", real)).toBe("checkout_url_not_https");
    expect(checkoutUrlProblem("https://checkout.bepaid.by.evil.example/x", real)).toBe(
      "checkout_url_unknown_host",
    );
    expect(checkoutUrlProblem("https://a:b@checkout.bepaid.by/x", real)).toBe(
      "checkout_url_credentials",
    );
    expect(checkoutUrlProblem("javascript:alert(1)", real)).toBe("checkout_url_not_https");
    expect(checkoutUrlProblem("not a url", real)).toBe("checkout_url_malformed");
  });

  it("the mock's link is the app's own page (its origin, http allowed off-prod)", () => {
    expect(
      checkoutUrlProblem("http://app.test/wallet/ramp/mock-checkout?payment=p", mock),
    ).toBeNull();
    expect(checkoutUrlProblem("http://app.test:8080/x", mock)).toBe(
      "checkout_url_unexpected_origin",
    );
    expect(checkoutUrlProblem("https://app.test/x", mock)).toBe("checkout_url_unexpected_origin");
    expect(checkoutUrlProblem("data:text/html,x", mock)).toBe("checkout_url_unexpected_origin");
  });
});

describe("C1's ledger proof", () => {
  const order = "11111111-2222-4333-8444-555555555555";
  it("only MarkPaid with this order's txHash makes the tokens the treasury's", () => {
    const end = (
      settledKind: "mark_paid" | "cancelled" | "settle_to_wallet" | "archived",
      txHash: string | null,
    ) => offrampLedgerOutcome({ active: false, settledKind, txHash }, order);
    expect(end("mark_paid", `ramp:${order}`)).toBe("mark_paid");
    expect(end("mark_paid", "ramp:another-order")).toBe("other");
    expect(end("mark_paid", null)).toBe("other");
    expect(end("cancelled", null)).toBe("cancelled");
    expect(end("settle_to_wallet", null)).toBe("other");
    expect(offrampLedgerOutcome({ active: true, settledKind: null, txHash: null }, order)).toBe(
      "live",
    );
    // Not indexed yet: wait, never guess.
    expect(offrampLedgerOutcome({ active: null, settledKind: null, txHash: null }, order)).toBe(
      "unindexed",
    );
  });
});

describe("token command rules of the ramp (#8, #10)", () => {
  it("mint state: never created / may land / never lands / landed (a mismatch landed something)", () => {
    expect(mintStateOf(null, null)).toBe("none");
    expect(mintStateOf("m", null)).toBe("unresolved");
    for (const s of ["pending", "submitted", "unknown"] as const)
      expect(mintStateOf("m", { status: s })).toBe("unresolved");
    for (const s of ["rejected", "abandoned"] as const)
      expect(mintStateOf("m", { status: s })).toBe("no");
    for (const s of ["recorded", "mismatch"] as const)
      expect(mintStateOf("m", { status: s })).toBe("recorded");
  });

  it("command ids are one per order and purpose; a re-mint after an abandoned one takes a generation suffix", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    expect(rampCommandId("mint", id)).toMatch(/^ramp-mint-[0-9a-f]{40}$/);
    expect(rampCommandId("remint", id, 2)).toBe(`${rampCommandId("remint", id)}-2`);
    expect(
      new Set(
        ["mint", "burn", "remint", "cbburn", "creditback"].map((k) =>
          rampCommandId(k as "mint", id),
        ),
      ).size,
    ).toBe(5);
  });

  it("webhook back-off: 5 s doubling to 10 min, no cap on attempts; a busy order retries in 5 s (E-D1)", () => {
    expect(rampEventDelay(1)).toBe(5_000);
    expect(rampEventDelay(2)).toBe(10_000);
    expect(rampEventDelay(8)).toBe(600_000);
    expect(rampEventDelay(500)).toBe(600_000);
    expect(rampEventDelay(30, true)).toBe(5_000);
  });
});

describe("L3: an instrument coarser than the fiat", () => {
  /** The policy over a stub instrument registry (nothing else is touched by these paths). */
  function policy(
    decimals: number,
    enabled = true,
    opts: { methods?: string[]; rails?: string[]; cardCashout?: string; prodLike?: boolean } = {},
  ): RampPolicyService {
    const config = {
      isProdLike: opts.prodLike ?? false,
      ramp: {
        enabled,
        fiatDecimals: 2,
        instrument: { admin: "a::1", id: "cBYN" },
        methods: opts.methods ?? ["card"],
        payoutRails: opts.rails ?? ["card"],
      },
    };
    const instruments = { get: async () => ({ id: "cBYN", decimals, enabled: true }) };
    const provider = {
      name: "mock",
      capabilities: { methods: ["card", "erip"], cardCashout: opts.cardCashout ?? "refund" },
    };
    const none = {} as never;
    return new RampPolicyService(
      config as never,
      none,
      none,
      none,
      provider as never,
      instruments as never,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      none,
    );
  }

  it("refuses to boot with the ramp on, and is treated as unconfigured", async () => {
    await expect(policy(1).onApplicationBootstrap()).rejects.toThrow(
      /RAMP_FIAT_DECIMALS \(2\) exceeds the ramp instrument cBYN's 1 decimals/,
    );
    expect(await policy(1).instrument()).toBeNull();
    await expect(policy(1, false).onApplicationBootstrap()).resolves.toBeUndefined();
    await expect(policy(6).onApplicationBootstrap()).resolves.toBeUndefined();
    expect(await policy(6).instrument()).toMatchObject({ id: "cBYN", decimals: 6 });
  });

  it("refuses methods the acquirer lacks, and prod-like a card-less acquirer without the bank rail (S5)", async () => {
    await expect(
      policy(6, true, { methods: ["card", "krok"] }).onApplicationBootstrap(),
    ).rejects.toThrow(/RAMP_METHODS lists krok, which the mock acquirer does not offer/);
    await expect(
      policy(6, true, { cardCashout: "none", prodLike: true }).onApplicationBootstrap(),
    ).rejects.toThrow(/has no card cash-out; RAMP_PAYOUT_RAILS must include bank/);
    await expect(
      policy(6, true, {
        cardCashout: "none",
        prodLike: true,
        rails: ["bank"],
      }).onApplicationBootstrap(),
    ).resolves.toBeUndefined();
    // Off-prod a card-less acquirer simply offers no card rail.
    await expect(
      policy(6, true, { cardCashout: "none" }).onApplicationBootstrap(),
    ).resolves.toBeUndefined();
  });
});

describe("card exposure (SPEC §9.3, I5, X9)", () => {
  it("is Σ (C − refunded − charged back) of recent card captures, never negative per capture", () => {
    expect(
      cardExposure([
        { captured: a("100"), refunded: 0n, chargedBack: 0n },
        { captured: a("50"), refunded: a("20"), chargedBack: 0n },
        // fully refunded by a card cash-out, and an over-refund never offsets another capture
        { captured: a("30"), refunded: a("30"), chargedBack: 0n },
        { captured: a("10"), refunded: a("5"), chargedBack: a("10") },
      ]),
    ).toBe(a("130"));
    expect(cardExposure([])).toBe(0n);
  });

  it("only the balance above the exposure may leave other than back to the card", () => {
    // 200 in-app, 130 exposed → 70 may go to a bank account or leave as a plain withdrawal.
    expect(withdrawableBeyondExposure(a("200"), 0n, a("130"))).toBe(a("70"));
    // Before MarkPaid the live amount is already debited from the balance (H2).
    expect(withdrawableBeyondExposure(a("130"), a("70"), a("130"))).toBe(a("70"));
    expect(withdrawableBeyondExposure(a("100"), 0n, a("130"))).toBe(0n);
  });
});

describe("the acquirer's next (SPEC §9.2, X15, E-D7)", () => {
  const ERIP: RampNextContext = {
    method: "erip",
    provider: "bepaid",
    publicAppUrl: "https://app.test",
    checkoutHosts: ["checkout.bepaid.by"],
    deeplinkSchemes: ["belarusbank"],
    accountNumber: "123456789012",
    amount: a("50"),
    fiatDecimals: 2,
  };
  const erip = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    kind: "erip",
    serviceCode: "4440631",
    accountNumber: "123456789012",
    amount: "50.0000000000",
    instructions: ["ERIP → Payments → TruthOracle", "Account 123456789012"],
    qrPng: MOCK_QR_PNG,
    qrRaw: "ST00012|Name=TruthOracle|Sum=50.00|Service=4440631|Acc=123456789012",
    ...extra,
  });

  it("accepts well-formed ERIP details and a hosted page on a listed https host", () => {
    expect(rampNextProblem(erip(), ERIP)).toBeNull();
    expect(rampNextProblem(erip({ qrPng: undefined, qrRaw: undefined }), ERIP)).toBeNull();
    expect(
      rampNextProblem(
        erip({ deeplinks: [{ name: "Belarusbank", url: "belarusbank://pay?acc=1" }] }),
        ERIP,
      ),
    ).toBeNull();
    expect(
      rampNextProblem(
        { kind: "redirect", url: "https://checkout.bepaid.by/v2/x" },
        { ...ERIP, method: "card" },
      ),
    ).toBeNull();
  });

  it("refuses a kind that does not match the method, unknown kinds and extra fields", () => {
    expect(rampNextProblem({ kind: "redirect", url: "https://checkout.bepaid.by/x" }, ERIP)).toBe(
      "next_kind_mismatch",
    );
    expect(rampNextProblem(erip(), { ...ERIP, method: "card" })).toBe("next_kind_mismatch");
    expect(rampNextProblem({ kind: "krok" }, ERIP)).toBe("next_unknown_kind");
    expect(rampNextProblem(null, ERIP)).toBe("next_missing");
    expect(rampNextProblem(erip({ script: "<script>" }), ERIP)).toBe("next_unexpected_field");
  });

  it("refuses bad link schemes and hosts (javascript:, data:, http, unknown host, unlisted app)", () => {
    const card = { ...ERIP, method: "card" as const };
    expect(rampNextProblem({ kind: "redirect", url: "javascript:alert(1)" }, card)).toBe(
      "checkout_url_not_https",
    );
    expect(rampNextProblem({ kind: "redirect", url: "http://checkout.bepaid.by/x" }, card)).toBe(
      "checkout_url_not_https",
    );
    expect(rampNextProblem({ kind: "redirect", url: "https://evil.example/x" }, card)).toBe(
      "checkout_url_unknown_host",
    );
    const link = (url: string) => erip({ deeplinks: [{ name: "Bank", url }] });
    expect(rampNextProblem(link("javascript:alert(1)"), ERIP)).toBe("erip_deeplink_scheme");
    expect(rampNextProblem(link("data:text/html,<b>x</b>"), ERIP)).toBe("erip_deeplink_scheme");
    expect(rampNextProblem(link("otherbank://pay"), ERIP)).toBe("erip_deeplink_scheme");
    expect(rampNextProblem(link("https://evil.example/pay"), ERIP)).toBe("erip_deeplink_host");
    expect(rampNextProblem(link("https://checkout.bepaid.by/erip"), ERIP)).toBeNull();
    expect(
      rampNextProblem(
        erip({
          deeplinks: Array.from({ length: 21 }, () => ({ name: "b", url: "belarusbank://x" })),
        }),
        ERIP,
      ),
    ).toBe("erip_deeplink");
  });

  it("refuses a wrong account number, amount or service code — another payee's money route", () => {
    expect(rampNextProblem(erip({ accountNumber: "999999999999" }), ERIP)).toBe(
      "erip_account_number",
    );
    expect(rampNextProblem(erip({ amount: "5.0000000000" }), ERIP)).toBe("erip_amount");
    expect(rampNextProblem(erip({ serviceCode: "12-34" }), ERIP)).toBe("erip_service_code");
    expect(rampNextProblem(erip({ serviceCode: "12345678901234567" }), ERIP)).toBe(
      "erip_service_code",
    );
    // The raw QR must name our service code and the exact amount.
    expect(rampNextProblem(erip({ qrRaw: "Service=4440631|Sum=500.00" }), ERIP)).toBe(
      "erip_qr_raw_mismatch",
    );
    expect(rampNextProblem(erip({ qrRaw: "Service=1|Sum=50.00" }), ERIP)).toBe(
      "erip_qr_raw_mismatch",
    );
    expect(rampNextProblem(erip({ qrRaw: "x".repeat(513) }), ERIP)).toBe("erip_qr_raw");
  });

  it("refuses instructions beyond 10 lines / 512 characters / with control characters", () => {
    expect(
      rampNextProblem(erip({ instructions: Array.from({ length: 11 }, () => "step") }), ERIP),
    ).toBe("erip_instructions");
    expect(rampNextProblem(erip({ instructions: ["x".repeat(513)] }), ERIP)).toBe(
      "erip_instructions",
    );
    expect(rampNextProblem(erip({ instructions: ["line\u0000break"] }), ERIP)).toBe(
      "erip_instructions",
    );
    expect(rampNextProblem(erip({ instructions: "one string" }), ERIP)).toBe("erip_instructions");
  });

  it("refuses a QR that is not a PNG, is a data: URL, or is over 64 KB", () => {
    const gif = Buffer.from("GIF89a-not-a-png").toString("base64");
    expect(rampNextProblem(erip({ qrPng: gif }), ERIP)).toBe("erip_qr_png_magic");
    expect(rampNextProblem(erip({ qrPng: `data:image/png;base64,${MOCK_QR_PNG}` }), ERIP)).toBe(
      "erip_qr_png",
    );
    const huge = Buffer.concat([Buffer.from(MOCK_QR_PNG, "base64"), Buffer.alloc(64 * 1024)]);
    expect(rampNextProblem(erip({ qrPng: huge.toString("base64") }), ERIP)).toBe(
      "erip_qr_png_too_large",
    );
  });
});

describe("ERIP refunds and neutral eligibility (SPEC §9.2, §11.3)", () => {
  const caps = {
    refundMethods: ["card", "erip"] as ("card" | "erip")[],
    eripRefundMinHoursAfterSettle: 24,
  };
  const settled = new Date("2026-10-18T10:00:00Z");
  const online = {
    settledAt: settled,
    payer: { nameSource: "bank" as const, channel: "online" as const },
  };

  it("refunds ERIP through the acquirer only when it can: non-cash, settled ≥ 24 h ago", () => {
    expect(eripRefundProblem("card", online, caps)).toBeNull();
    expect(eripRefundProblem("erip", online, caps, new Date("2026-10-19T10:00:01Z"))).toBeNull();
    expect(eripRefundProblem("erip", online, caps, new Date("2026-10-19T09:59:59Z"))).toMatch(
      /open 24 h after settlement/,
    );
    expect(eripRefundProblem("erip", online, { ...caps, refundMethods: ["card"] })).toMatch(
      /refund_bank/,
    );
    expect(
      eripRefundProblem(
        "erip",
        { settledAt: settled, payer: { nameSource: null, channel: "cash" } },
        caps,
      ),
    ).toMatch(/cash .*refund_bank/);
    expect(eripRefundProblem("erip", { settledAt: settled, payer: null }, caps)).toMatch(
      /refund_bank/,
    );
    expect(eripRefundProblem("erip", { ...online, settledAt: null }, caps)).toMatch(/not settled/);
  });

  it("shows only kyc / consent / additional-info reasons by name; every other compliance code is `compliance`", () => {
    expect(userComplianceReason("consent_required")).toBe("consent_required");
    expect(userComplianceReason("kyc_required")).toBe("kyc_required");
    expect(userComplianceReason("kyc_refresh_required")).toBe("additional_info_required");
    expect(userComplianceReason("additional_info_required")).toBe("additional_info_required");
    for (const code of ["screening_pending", "vendor_sanctions", "pep_declared", "frozen", "age"])
      expect(userComplianceReason(code)).toBe("compliance");
  });
});
