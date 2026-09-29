import {
  dataCheckString,
  parseWidgetPayload,
  signMiniAppInitData,
  signWidgetPayload,
  verifyLoginWidget,
  verifyMiniAppInitData,
} from "./telegram";

const BOT_TOKEN = "123456789:AAFakeBotTokenForUnitTestsOnly_xyz";
const NOW = 1_800_000_000;

function widgetFields(authDate = NOW - 10): Record<string, string> {
  return {
    id: "424242",
    first_name: "Ada",
    last_name: "Lovelace",
    username: "ada",
    photo_url: "https://t.me/i/ada.jpg",
    auth_date: String(authDate),
  };
}

function miniAppFields(authDate = NOW - 10): Record<string, string> {
  return {
    query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
    user: JSON.stringify({
      id: 424242,
      first_name: "Ada",
      last_name: "Lovelace",
      username: "ada",
      language_code: "en",
    }),
    auth_date: String(authDate),
  };
}

describe("util/telegram", () => {
  it("builds the data-check-string sorted by key without hash", () => {
    expect(dataCheckString({ b: "2", hash: "x", a: "1" })).toBe("a=1\nb=2");
  });

  describe("login widget", () => {
    it("verifies a payload signed with sha256(bot token)", () => {
      const payload = signWidgetPayload(widgetFields(), BOT_TOKEN);
      const result = verifyLoginWidget(payload, BOT_TOKEN, { maxAgeSec: 300, now: NOW });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.user).toEqual({
        id: "424242",
        firstName: "Ada",
        lastName: "Lovelace",
        username: "ada",
        photoUrl: "https://t.me/i/ada.jpg",
      });
      expect(result.replayKey).toBe(payload.hash);
    });

    it("accepts numeric JSON fields (id, auth_date) as the widget posts them", () => {
      const signed = signWidgetPayload(widgetFields(), BOT_TOKEN);
      const body = { ...signed, id: 424242, auth_date: Number(signed.auth_date) };
      expect(parseWidgetPayload(body).id).toBe("424242");
      expect(verifyLoginWidget(body, BOT_TOKEN, { maxAgeSec: 300, now: NOW }).ok).toBe(true);
    });

    it("rejects expired, future, tampered and wrong-token payloads", () => {
      expect(
        verifyLoginWidget(signWidgetPayload(widgetFields(NOW - 301), BOT_TOKEN), BOT_TOKEN, {
          maxAgeSec: 300,
          now: NOW,
        }),
      ).toEqual({ ok: false, reason: "auth payload expired" });
      expect(
        verifyLoginWidget(signWidgetPayload(widgetFields(NOW + 61), BOT_TOKEN), BOT_TOKEN, {
          maxAgeSec: 300,
          now: NOW,
        }),
      ).toEqual({ ok: false, reason: "auth payload issued in the future" });
      expect(
        verifyLoginWidget(signWidgetPayload(widgetFields(NOW + 59), BOT_TOKEN), BOT_TOKEN, {
          maxAgeSec: 300,
          now: NOW,
        }).ok,
      ).toBe(true);
      const tampered = { ...signWidgetPayload(widgetFields(), BOT_TOKEN), id: "1" };
      expect(verifyLoginWidget(tampered, BOT_TOKEN, { maxAgeSec: 300, now: NOW })).toEqual({
        ok: false,
        reason: "hash mismatch",
      });
      expect(
        verifyLoginWidget(signWidgetPayload(widgetFields(), "other:token"), BOT_TOKEN, {
          maxAgeSec: 300,
          now: NOW,
        }),
      ).toEqual({ ok: false, reason: "hash mismatch" });
      expect(
        verifyLoginWidget({ ...widgetFields() }, BOT_TOKEN, { maxAgeSec: 300, now: NOW }),
      ).toEqual({ ok: false, reason: "hash missing or malformed" });
      expect(
        verifyLoginWidget(signWidgetPayload(widgetFields(), BOT_TOKEN), "", {
          maxAgeSec: 300,
          now: NOW,
        }).ok,
      ).toBe(false);
    });

    it("ignores unknown fields instead of hashing them", () => {
      const signed = signWidgetPayload(widgetFields(), BOT_TOKEN);
      expect(
        verifyLoginWidget({ ...signed, extra: "x" }, BOT_TOKEN, { maxAgeSec: 300, now: NOW }).ok,
      ).toBe(true);
    });
  });

  describe("mini app initData", () => {
    it("verifies initData signed with HMAC(WebAppData, bot token)", () => {
      const initData = signMiniAppInitData(miniAppFields(), BOT_TOKEN);
      const result = verifyMiniAppInitData(initData, BOT_TOKEN, { maxAgeSec: 3600, now: NOW });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.user.id).toBe("424242");
      expect(result.user.username).toBe("ada");
      expect(result.user.languageCode).toBe("en");
      expect(result.replayKey).toBe(new URLSearchParams(initData).get("hash"));
    });

    it("rejects the widget secret for initData and vice versa", () => {
      const initData = signMiniAppInitData(miniAppFields(), BOT_TOKEN);
      const params = Object.fromEntries(new URLSearchParams(initData));
      // A widget-style signature over the same fields must not verify as initData.
      const widgetSigned = signWidgetPayload(
        { query_id: params.query_id, user: params.user, auth_date: params.auth_date },
        BOT_TOKEN,
      );
      expect(
        verifyMiniAppInitData(new URLSearchParams(widgetSigned).toString(), BOT_TOKEN, {
          maxAgeSec: 3600,
          now: NOW,
        }),
      ).toEqual({ ok: false, reason: "hash mismatch" });
    });

    it("rejects expired, tampered and malformed initData", () => {
      expect(
        verifyMiniAppInitData(
          signMiniAppInitData(miniAppFields(NOW - 3601), BOT_TOKEN),
          BOT_TOKEN,
          { maxAgeSec: 3600, now: NOW },
        ),
      ).toEqual({ ok: false, reason: "auth payload expired" });
      const tampered = signMiniAppInitData(miniAppFields(), BOT_TOKEN).replace("424242", "424243");
      expect(verifyMiniAppInitData(tampered, BOT_TOKEN, { maxAgeSec: 3600, now: NOW })).toEqual({
        ok: false,
        reason: "hash mismatch",
      });
      expect(verifyMiniAppInitData("", BOT_TOKEN, { maxAgeSec: 3600, now: NOW }).ok).toBe(false);
      expect(verifyMiniAppInitData(42, BOT_TOKEN, { maxAgeSec: 3600, now: NOW }).ok).toBe(false);
      const noUser = signMiniAppInitData({ query_id: "q", auth_date: String(NOW) }, BOT_TOKEN);
      expect(verifyMiniAppInitData(noUser, BOT_TOKEN, { maxAgeSec: 3600, now: NOW })).toEqual({
        ok: false,
        reason: "user field is not JSON",
      });
    });
  });

  it("yields the same subject for one fixture user across widget and mini app", () => {
    const w = verifyLoginWidget(signWidgetPayload(widgetFields(), BOT_TOKEN), BOT_TOKEN, {
      maxAgeSec: 300,
      now: NOW,
    });
    const m = verifyMiniAppInitData(signMiniAppInitData(miniAppFields(), BOT_TOKEN), BOT_TOKEN, {
      maxAgeSec: 3600,
      now: NOW,
    });
    expect(w.ok && m.ok && w.user.id === m.user.id).toBe(true);
  });

  it("replay keys are the payload hash so a claim on tg:<hash> blocks reuse", () => {
    const signed = signWidgetPayload(widgetFields(), BOT_TOKEN);
    const first = verifyLoginWidget(signed, BOT_TOKEN, { maxAgeSec: 300, now: NOW });
    const second = verifyLoginWidget(signed, BOT_TOKEN, { maxAgeSec: 300, now: NOW });
    expect(first.ok && second.ok && first.replayKey === second.replayKey).toBe(true);
  });
});
