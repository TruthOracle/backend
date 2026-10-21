/**
 * Pure rules of list screening (SPEC §11.6; B1): the normalized list CSV, the name-fold keys of an
 * entry, matching an account (verified names + birth date, party ids) against the latest lists,
 * and when a full re-screen is due / stale. Unit-tested in screening.logic.spec.ts.
 */
import {
  FREEZING_LISTS,
  SCREENING_ENTRY_KINDS,
  type ScreeningEntryKind,
  type ScreeningHitMatch,
  type ScreeningListName,
} from "../types";
import { parseCsv } from "../util/csv";
import { ApiError } from "../util/errors";
import {
  bridgeWords,
  foldName,
  latinFold,
  nameKeys,
  personBridgeKeys,
  personKeys,
} from "../util/name-fold";
import { DAY_MS, HOUR_MS } from "../util/time";
import type { VerifiedName } from "./kyc-identity.port";

/** The header of the normalized CSV (optional in the file; when present it must be exactly this). */
export const SCREENING_CSV_HEADER = ["kind", "name_variants", "birth_date", "ids"] as const;
const MAX_VARIANTS = 50;
const MAX_IDS = 50;
const MAX_CELL = 300;
export const MAX_SCREENING_ENTRIES = 100_000;

export interface ScreeningEntryInput {
  /** Record number in the file, the header not counted. */
  line: number;
  kind: ScreeningEntryKind;
  names: string[];
  nameKeys: string[];
  birthDate: string | null;
  ids: string[];
}

function invalid(line: number | null, message: string): ApiError {
  return new ApiError(
    400,
    "screening_list_invalid",
    line === null ? message : `record ${line}: ${message}`,
    line === null ? undefined : { line },
  );
}

/**
 * A birth date as lists write it → `YYYY`, `YYYY-MM` or `YYYY-MM-DD` (a year or month alone is
 * common); `DD.MM.YYYY` (Belarusian lists) is accepted. Null for blank; throws on anything else.
 */
export function normalizeBirthDate(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const dotted = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(v);
  const iso = dotted ? `${dotted[3]}-${dotted[2]}-${dotted[1]}` : v;
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(iso);
  if (!m) throw new Error(`birth_date must be YYYY, YYYY-MM, YYYY-MM-DD or DD.MM.YYYY: ${v}`);
  const [, y, mo, d] = m;
  if (mo !== undefined && (Number(mo) < 1 || Number(mo) > 12))
    throw new Error(`birth_date has no month ${mo}: ${v}`);
  if (d !== undefined) {
    const date = new Date(`${y}-${mo}-${d}T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.getUTCDate() !== Number(d))
      throw new Error(`birth_date is not a calendar day: ${v}`);
  }
  return iso;
}

const PATRONYMIC_CYRILLIC = /(вич|ич|вна|уна|ична|чна)$/;
const PATRONYMIC_LATIN = /(vich|vic|ich|vna|ovna|evna|ichna|auna|euna|ouna)$/;

/** Does the word look like an East Slavic patronymic (Мікалаевіч, Николаевна, MIKALAEVICH, …)? */
export function looksLikePatronymic(word: string): boolean {
  const cyr = foldName(word);
  if (/[а-я]/.test(cyr)) return cyr.length >= 5 && PATRONYMIC_CYRILLIC.test(cyr);
  const lat = latinFold(word);
  return lat.length >= 5 && PATRONYMIC_LATIN.test(lat);
}

/**
 * Keys of one entry's name variants: each variant as written (the list's word order) and — when
 * it ends in a patronymic — without it, so an identity whose document form carries no patronymic
 * (Latin passport names, foreign residents) still matches. Identities supply both orders
 * (`personKeys`), so the list's order needs no permutations.
 */
export function entryNameKeys(names: readonly string[]): string[] {
  const keys = new Set<string>();
  for (const name of names) {
    for (const k of nameKeys(name)) keys.add(k);
    const words = name
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean);
    if (words.length >= 3 && looksLikePatronymic(words[words.length - 1]))
      for (const k of nameKeys(words.slice(0, -1).join(" "))) keys.add(k);
  }
  return [...keys];
}

function splitCell(cell: string, max: number, what: string, line: number): string[] {
  const parts = cell
    .split("|")
    .map((s) => s.normalize("NFC").trim())
    .filter(Boolean);
  if (parts.length > max) throw invalid(line, `more than ${max} ${what}`);
  for (const p of parts)
    if (p.length > MAX_CELL) throw invalid(line, `a ${what} value is longer than ${MAX_CELL}`);
  return [...new Set(parts)];
}

/**
 * The upload's bytes from `content` (base64; line breaks allowed). Anything that is not strict
 * base64, is empty or exceeds `maxBytes` is `400 screening_list_invalid` (never a lenient decode).
 */
export function decodeBase64Upload(content: string, maxBytes: number): Buffer {
  const compact = content.replace(/\s+/g, "");
  if (!compact || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact))
    throw invalid(null, "content must be the file as base64");
  const bytes = Buffer.from(compact, "base64");
  if (bytes.length > maxBytes) throw invalid(null, `the file is larger than ${maxBytes} bytes`);
  return bytes;
}

/**
 * The normalized list CSV (SPEC §11.6): `kind,name_variants,birth_date,ids` — variants and ids
 * `|`-separated; kind person | org | address; persons and organisations need a name with letters,
 * addresses (the Decree No. 48 register) an id. An optional first header row must be exactly the
 * four names. Every problem is `400 screening_list_invalid` naming the record.
 */
export function parseScreeningList(
  text: string,
  maxEntries = MAX_SCREENING_ENTRIES,
): ScreeningEntryInput[] {
  let rows: string[][];
  try {
    rows = parseCsv(text, { delimiter: ",", maxRows: maxEntries + 1 });
  } catch (err) {
    throw invalid(null, (err as Error).message);
  }
  if (rows.length > 0 && rows[0][0]?.trim().toLowerCase() === SCREENING_CSV_HEADER[0]) {
    const header = rows[0].map((c) => c.trim().toLowerCase());
    if (header.join(",") !== SCREENING_CSV_HEADER.join(","))
      throw invalid(null, `the header must be ${SCREENING_CSV_HEADER.join(",")}`);
    rows = rows.slice(1);
  }
  if (rows.length === 0) throw invalid(null, "the list has no entries");
  if (rows.length > maxEntries) throw invalid(null, `more than ${maxEntries} entries`);
  return rows.map((cells, i) => {
    const line = i + 1;
    if (cells.length !== 4)
      throw invalid(
        line,
        `expected 4 fields (${SCREENING_CSV_HEADER.join(",")}), got ${cells.length}`,
      );
    const kind = cells[0].trim().toLowerCase();
    if (!(SCREENING_ENTRY_KINDS as readonly string[]).includes(kind))
      throw invalid(line, `kind must be one of ${SCREENING_ENTRY_KINDS.join(", ")}`);
    const names = splitCell(cells[1], MAX_VARIANTS, "name variants", line);
    const ids = splitCell(cells[3], MAX_IDS, "ids", line);
    let birthDate: string | null;
    try {
      birthDate = normalizeBirthDate(cells[2]);
    } catch (err) {
      throw invalid(line, (err as Error).message);
    }
    const keys = kind === "address" ? [] : entryNameKeys(names);
    if (kind !== "address" && keys.length === 0)
      throw invalid(line, `a ${kind} needs a name with letters`);
    if (kind === "address" && ids.length === 0) throw invalid(line, "an address needs an id");
    return { line, kind: kind as ScreeningEntryKind, names, nameKeys: keys, birthDate, ids };
  });
}

// ── matching ──────────────────────────────────────────────────────────────────────────────

/** An entry of the latest version of its list, as the matcher needs it. */
export interface CompiledEntry {
  id: string;
  listId: string;
  list: ScreeningListName;
  kind: ScreeningEntryKind;
  names: string[];
  nameKeys: string[];
  birthDate: string | null;
  ids: string[];
}

export interface ScreeningIndex {
  byKey: Map<string, CompiledEntry[]>;
  byId: Map<string, CompiledEntry[]>;
  /** C12: person entries by bridged key (word pairs / all words) and by bridged word (surnames). */
  byBridge: Map<string, CompiledEntry[]>;
  byBridgeWord: Map<string, CompiledEntry[]>;
  /** C13: organisation entries by name key (a declared principal may be a company). */
  orgByKey: Map<string, CompiledEntry[]>;
  size: number;
}

/** A bridged word shorter than this is no surname candidate (Юрий → "r", Анна → "n"). */
const MIN_BRIDGE_SURNAME = 3;
/** Entries with more words than this are keyed by all their words only (no pairs). */
const MAX_BRIDGE_PAIR_WORDS = 3;

/**
 * Bridged keys of an entry's name variants (C12): per variant, its words as written and without
 * the patronymic-looking ones — each list in the order written and, up to three words, every pair
 * in that order (identities supply both orders) — plus every word (the surname candidates). Both
 * lists: a -вич / -ич SURNAME (Шушкевич) looks like a patronymic too (R2b-2).
 */
export function entryBridgeKeys(names: readonly string[]): { full: string[]; words: string[] } {
  const full = new Set<string>();
  const words = new Set<string>();
  for (const name of names) {
    const written = name
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean);
    for (const ws of [written, written.filter((w) => !looksLikePatronymic(w))]) {
      const kept = ws.flatMap((w) => bridgeWords(w));
      if (kept.length >= 2) full.add(kept.join(""));
      if (kept.length >= 2 && kept.length <= MAX_BRIDGE_PAIR_WORDS)
        for (let i = 0; i < kept.length; i += 1)
          for (let j = i + 1; j < kept.length; j += 1) full.add(kept[i] + kept[j]);
      for (const w of kept) if (w.length >= MIN_BRIDGE_SURNAME) words.add(w);
    }
  }
  return { full: [...full], words: [...words] };
}

/** Index person entries by name key and every entry by id (party ids and their namespaces match ids). */
export function buildScreeningIndex(entries: readonly CompiledEntry[]): ScreeningIndex {
  const byKey = new Map<string, CompiledEntry[]>();
  const byId = new Map<string, CompiledEntry[]>();
  const byBridge = new Map<string, CompiledEntry[]>();
  const byBridgeWord = new Map<string, CompiledEntry[]>();
  const orgByKey = new Map<string, CompiledEntry[]>();
  const push = (map: Map<string, CompiledEntry[]>, key: string, e: CompiledEntry): void => {
    const list = map.get(key);
    if (list) list.push(e);
    else map.set(key, [e]);
  };
  for (const e of entries) {
    if (e.kind === "person") {
      for (const k of new Set(e.nameKeys)) push(byKey, k, e);
      const bridge = entryBridgeKeys(e.names);
      for (const k of bridge.full) push(byBridge, k, e);
      for (const w of bridge.words) push(byBridgeWord, w, e);
    }
    if (e.kind === "org") for (const k of new Set(e.nameKeys)) push(orgByKey, k, e);
    for (const id of e.ids) push(byId, id.trim(), e);
  }
  return { byKey, byId, byBridge, byBridgeWord, orgByKey, size: entries.length };
}

/** How far an entry's birth date agrees with the identity's; null = they disagree (no match). */
export function birthDateAgreement(
  entry: string | null,
  identity: string | null,
): "exact" | "partial" | "unknown" | null {
  if (!entry || !identity) return "unknown";
  if (!identity.startsWith(entry)) return null;
  return entry.length === identity.length ? "exact" : "partial";
}

export interface ScreeningSubject {
  names: readonly VerifiedName[];
  /** `YYYY-MM-DD`. */
  birthDate: string | null;
  parties: readonly string[];
  /** C13: the principals the account's consents declare it acts for (free text, no birth date). */
  principals?: readonly { consentId: string; text: string }[];
}

export interface ScreeningMatch {
  entry: CompiledEntry;
  match: ScreeningHitMatch;
}

/**
 * Every entry the account matches, once each: a person entry whose keys overlap the keys of any
 * verified name form (`personKeys`: both orders, with and without the patronymic) and whose birth
 * date does not contradict the identity's — else whose bridged be / ru / Latin keys do (C12), else
 * whose surname is bridged and birth date exact (a candidate); a person or organisation entry naming
 * a declared principal (C13); any entry listing one of the account's party ids or its namespace
 * (the fingerprint after `::`).
 */
export function screenSubject(index: ScreeningIndex, subject: ScreeningSubject): ScreeningMatch[] {
  const found = new Map<string, ScreeningMatch>();
  for (const name of subject.names) {
    const full = personKeys(name).full;
    for (const key of full) {
      for (const entry of index.byKey.get(key) ?? []) {
        if (found.has(entry.id)) continue;
        const dob = birthDateAgreement(entry.birthDate, subject.birthDate);
        if (dob === null) continue;
        const own = new Set(full);
        const entryName =
          entry.names.find((n) => entryNameKeys([n]).some((k) => own.has(k))) ??
          entry.names[0] ??
          "";
        found.set(entry.id, {
          entry,
          match: {
            basis: "name",
            entryName,
            entryBirthDate: entry.birthDate,
            entryIds: entry.ids,
            script: name.script,
            birthDate: dob,
            via: "fold",
          },
        });
      }
    }
  }
  // C12: the be / ru / Latin forms the exact keys keep apart (lists publish one form only).
  const bridged = (
    name: VerifiedName,
    entry: CompiledEntry,
    via: "bridge" | "surname_dob",
    dob: "exact" | "partial" | "unknown",
  ): void => {
    found.set(entry.id, {
      entry,
      match: {
        basis: "name",
        entryName: entry.names[0] ?? "",
        entryBirthDate: entry.birthDate,
        entryIds: entry.ids,
        script: name.script,
        birthDate: dob,
        via,
      },
    });
  };
  for (const name of subject.names)
    for (const key of personBridgeKeys(name).full)
      for (const entry of index.byBridge.get(key) ?? []) {
        if (found.has(entry.id)) continue;
        const dob = birthDateAgreement(entry.birthDate, subject.birthDate);
        if (dob !== null) bridged(name, entry, "bridge", dob);
      }
  // A candidate: the surname and the EXACT birth date (given names differ beyond the table).
  for (const name of subject.names) {
    const surname = personBridgeKeys(name).surname;
    if (surname.length < MIN_BRIDGE_SURNAME) continue;
    for (const entry of index.byBridgeWord.get(surname) ?? []) {
      if (found.has(entry.id)) continue;
      if (birthDateAgreement(entry.birthDate, subject.birthDate) === "exact")
        bridged(name, entry, "surname_dob", "exact");
    }
  }
  // C13: a declared principal (person or organisation, any word order; no birth date to weigh).
  for (const p of subject.principals ?? []) {
    const keys = principalKeys(p.text);
    const entries = [
      ...keys.fold.flatMap((k) => [
        ...(index.byKey.get(k) ?? []),
        ...(index.orgByKey.get(k) ?? []),
      ]),
      ...keys.bridge.flatMap((k) => index.byBridge.get(k) ?? []),
    ];
    for (const entry of entries) {
      if (found.has(entry.id)) continue;
      found.set(entry.id, {
        entry,
        match: {
          basis: "principal",
          consentId: p.consentId,
          entryName: entry.names[0] ?? "",
          entryBirthDate: entry.birthDate,
          entryIds: entry.ids,
        },
      });
    }
  }
  for (const party of subject.parties) {
    const namespace = party.includes("::") ? party.slice(party.indexOf("::") + 2) : null;
    for (const listed of [party, namespace]) {
      if (!listed) continue;
      for (const entry of index.byId.get(listed) ?? []) {
        if (found.has(entry.id)) continue;
        found.set(entry.id, { entry, match: { basis: "party", party, listed } });
      }
    }
  }
  return [...found.values()];
}

/** Word orders of a principal tried (up to this many words; more are taken as written). */
const MAX_PRINCIPAL_WORDS = 4;

function permutations(words: readonly string[]): string[][] {
  if (words.length <= 1) return [[...words]];
  return words.flatMap((w, i) =>
    permutations([...words.slice(0, i), ...words.slice(i + 1)]).map((rest) => [w, ...rest]),
  );
}

/**
 * Keys of a declared principal (C13; free text, the word order unknown): the exact keys of every
 * order of its words, with and without a patronymic, and the bridged keys of every word pair.
 */
export function principalKeys(text: string): { fold: string[]; bridge: string[] } {
  const words = text
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  const plain = words.filter((w) => !looksLikePatronymic(w));
  const fold = new Set<string>();
  for (const ws of [words, plain]) {
    const orders = ws.length <= MAX_PRINCIPAL_WORDS ? permutations(ws) : [ws];
    for (const order of orders) for (const k of nameKeys(order.join(" "))) fold.add(k);
  }
  // Bridged from the words as written too: a -вич / -ич surname looks like a patronymic (R2b-2).
  const bridge = new Set<string>();
  for (const ws of [words, plain]) {
    const bw = ws.flatMap((w) => bridgeWords(w));
    if (bw.length >= 2) bridge.add(bw.join(""));
    if (bw.length <= MAX_PRINCIPAL_WORDS)
      for (let i = 0; i < bw.length; i += 1)
        for (let j = 0; j < bw.length; j += 1) if (i !== j) bridge.add(bw[i] + bw[j]);
  }
  return { fold: [...fold], bridge: [...bridge] };
}

/** Belarusian law freezes for its own list, the UN list and the Decree No. 48 register (B1). */
export function freezesOnHit(list: ScreeningListName): boolean {
  return FREEZING_LISTS.includes(list);
}

// ── schedule and staleness ────────────────────────────────────────────────────────────────

/** A full run that ended partial / failed (or crashed while running) is retried after this. */
export const RESCREEN_RETRY_MS = HOUR_MS;

export interface FullRunFacts {
  startedAt: Date;
  status: "running" | "done" | "partial" | "failed";
  listIds: readonly string[];
}

/**
 * Why a full re-screen is due now (null = not due): never ran, a list version was imported since
 * the last complete run, RAMP_RESCREEN_DAYS passed, or the last attempt failed an hour ago or more.
 * Nothing is due without a list.
 */
export function rescreenDue(input: {
  now: Date;
  rescreenDays: number;
  latestListIds: readonly string[];
  lastDone: FullRunFacts | null;
  lastAttempt: FullRunFacts | null;
}): "never" | "new_list" | "schedule" | "retry" | null {
  const { now, lastDone, lastAttempt } = input;
  if (input.latestListIds.length === 0) return null;
  const attemptAge = lastAttempt ? now.getTime() - lastAttempt.startedAt.getTime() : Infinity;
  // A run in progress (or one that crashed less than the retry delay ago) is left alone.
  if (lastAttempt && lastAttempt.status !== "done" && attemptAge < RESCREEN_RETRY_MS) return null;
  if (!lastDone) return lastAttempt ? "retry" : "never";
  const covered = new Set(lastDone.listIds);
  if (input.latestListIds.some((id) => !covered.has(id))) return "new_list";
  if (now.getTime() - lastDone.startedAt.getTime() >= input.rescreenDays * DAY_MS)
    return "schedule";
  return null;
}

/** SPEC §6.2 `screening_stale`: the last complete full re-screen within 90 days; every freezing list imported within RAMP_SCREENING_LIST_MAX_AGE_DAYS. */
export const SCREENING_STALE_DAYS = 90;

export function screeningStaleness(input: {
  now: Date;
  listMaxAgeDays: number;
  lastDoneFullAt: Date | null;
  latestImports: Partial<Record<ScreeningListName, Date>>;
  /** C44: accounts whose verified identity could not be read at their last screening. */
  unreadableAccounts?: number;
}): { status: "green" | "amber"; problems: string[] } {
  const problems: string[] = [];
  const age = (d: Date): number => (input.now.getTime() - d.getTime()) / DAY_MS;
  if (!input.lastDoneFullAt) problems.push("no complete full re-screen yet");
  else if (age(input.lastDoneFullAt) > SCREENING_STALE_DAYS)
    problems.push(`last complete full re-screen ${Math.floor(age(input.lastDoneFullAt))} days ago`);
  for (const list of FREEZING_LISTS) {
    const at = input.latestImports[list];
    if (!at) problems.push(`${list} never imported`);
    else if (age(at) > input.listMaxAgeDays)
      problems.push(`${list} last imported ${Math.floor(age(at))} days ago`);
  }
  if (input.unreadableAccounts)
    problems.push(
      `${input.unreadableAccounts} account(s) whose verified identity cannot be read (refused until re-verified)`,
    );
  return { status: problems.length ? "amber" : "green", problems };
}
