/**
 * A party id for a public feed: `first 8…last 6`. Canton party ids are `<hint>::1220<64 hex>`;
 * the head keeps the hint readable, the tail keeps two trades by the same taker recognisable,
 * and nothing in between is enough to address the party. Short ids (tests, local parties) are
 * returned whole — there is nothing to hide in twenty characters.
 */
export function maskParty(party: string): string {
  const trimmed = party.trim();
  if (trimmed.length <= 20) return trimmed;
  return `${trimmed.slice(0, 8)}…${trimmed.slice(-6)}`;
}
