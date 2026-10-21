import { ApiError } from "./errors";

/**
 * Text charsets an uploaded file may declare (SPEC §8, X16): Belarusian bank exports are often
 * Windows-1251. The caller names the charset (a body field, never sniffed); bytes are decoded with
 * `TextDecoder({ fatal: true })`, so invalid UTF-8 is refused instead of turning into U+FFFD.
 */
export const TEXT_CHARSETS = ["utf-8", "windows-1251"] as const;
export type TextCharset = (typeof TEXT_CHARSETS)[number];

export function isTextCharset(value: unknown): value is TextCharset {
  return typeof value === "string" && (TEXT_CHARSETS as readonly string[]).includes(value);
}

/** Decode `bytes` strictly; a UTF-8 BOM is dropped. Throws `400 validation_failed` on bad input. */
export function decodeText(bytes: Uint8Array, charset: TextCharset): string {
  if (!isTextCharset(charset)) {
    throw new ApiError(
      400,
      "validation_failed",
      `charset must be one of ${TEXT_CHARSETS.join(", ")}`,
    );
  }
  try {
    return new TextDecoder(charset, { fatal: true }).decode(bytes);
  } catch {
    throw new ApiError(400, "validation_failed", `the file is not valid ${charset}`);
  }
}
