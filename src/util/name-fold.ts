/**
 * Name matching keys (SPEC §9.4, M2) for TM-THIRDPARTY (S7a) and list screening (S7b). A
 * Belarusian identity can carry the same person in Belarusian Cyrillic (Іваноў Сяргей), Russian
 * Cyrillic (Иванов Сергей) and Latin (IVANOU SIARHEI / IVANOV SERGEI); payers, banks and lists
 * write any of them. Two names match when their key sets overlap (`keysOverlap`).
 *
 * Keys of a name:
 * - the Cyrillic fold: lower-case, ё→е, і→и, ў→у, punctuation and spaces stripped;
 * - Latin keys: the name transliterated by BGN/PCGN (Russian), the 2007 Belarusian national table,
 *   ICAO 9303 (passports) and its Belarusian passport variant (г→h, ё→io) — each from the name as
 *   written and from its fold — then lower-cased with diacritics, punctuation and spaces stripped;
 * - a Latin name: lower-cased, diacritics, punctuation and spaces stripped.
 * More variants only add matches; nothing here decides alone (a rule weighs the result).
 */

type Table = "ru_bgn" | "be_2007" | "icao" | "by_passport";
const TABLES: readonly Table[] = ["ru_bgn", "be_2007", "icao", "by_passport"];

const CYRILLIC_RE = /[Ѐ-ӿ]/;
const APOSTROPHES_RE = /[’'ʼ`´]/g;
/** Vowels after which (and at word start) the iotated letters take their "y"/"j" forms. */
const RU_VOWELS = new Set([..."аеёиоуыэюяі"]);
const BE_VOWELS = new Set([..."аеёіоуыэюяи"]);

/** `"а a|б b|…"` → letter map; an empty target drops the letter. */
function letters(spec: string): Readonly<Record<string, string>> {
  return Object.fromEntries(
    spec.split("|").map((pair) => {
      const [from, to = ""] = pair.split(" ");
      return [from, to];
    }),
  );
}

/** Context-free letters, per table (the iotated vowels are handled by IOTATED). */
const BASE: Record<Table, Readonly<Record<string, string>>> = {
  ru_bgn: letters(
    "а a|б b|в v|г g|д d|ж zh|з z|и i|й y|к k|л l|м m|н n|о o|п p|р r|с s|т t|у u|ф f|х kh|ц ts|ч ch|ш sh|щ shch|ъ|ы y|ь|э e|і i|ў u|ґ g",
  ),
  be_2007: letters(
    "а a|б b|в v|г h|ґ g|д d|ж ž|з z|і i|и i|й j|к k|л l|м m|н n|о o|п p|р r|с s|т t|у u|ў ŭ|ф f|х ch|ц c|ч č|ш š|щ šč|ъ|ы y|ь|э e",
  ),
  icao: letters(
    "а a|б b|в v|г g|д d|ж zh|з z|и i|й i|к k|л l|м m|н n|о o|п p|р r|с s|т t|у u|ф f|х kh|ц ts|ч ch|ш sh|щ shch|ъ ie|ы y|ь|э e|і i|ў u|ґ g",
  ),
  by_passport: letters(
    "а a|б b|в v|г h|д d|ж zh|з z|и i|й i|к k|л l|м m|н n|о o|п p|р r|с s|т t|у u|ф f|х kh|ц ts|ч ch|ш sh|щ shch|ъ|ы y|ь|э e|і i|ў u|ґ g",
  ),
};

/** е ё ю я: [after a consonant, at word start / after a vowel or a separator]. */
const IOTATED: Record<Table, Readonly<Record<string, readonly [string, string]>>> = {
  ru_bgn: { е: ["e", "ye"], ё: ["ë", "yë"], ю: ["yu", "yu"], я: ["ya", "ya"] },
  be_2007: { е: ["ie", "je"], ё: ["io", "jo"], ю: ["iu", "ju"], я: ["ia", "ja"] },
  icao: { е: ["e", "e"], ё: ["e", "e"], ю: ["iu", "iu"], я: ["ia", "ia"] },
  by_passport: { е: ["e", "e"], ё: ["io", "io"], ю: ["iu", "iu"], я: ["ia", "ia"] },
};

/** Letters after which be_2007 uses the j-forms besides vowels (the separating signs). */
const BE_SEPARATORS = new Set(["ь", "ъ", "ў", "'"]);
const RU_SEPARATORS = new Set(["й", "ъ", "ь"]);

/** Lower-case NFC with every non-letter except apostrophes turned into a space (word boundaries kept). */
function prepare(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(APOSTROPHES_RE, "'")
    .replace(/[^\p{L}']+/gu, " ")
    .trim();
}

function transliterate(text: string, table: Table): string {
  const base = BASE[table];
  const iotated = IOTATED[table];
  const vowels = table === "be_2007" ? BE_VOWELS : RU_VOWELS;
  const separators = table === "be_2007" ? BE_SEPARATORS : RU_SEPARATORS;
  let out = "";
  let prev = " ";
  for (const ch of text) {
    const forms = iotated[ch];
    if (forms) {
      const soft = prev === " " || vowels.has(prev) || separators.has(prev);
      out += soft ? forms[1] : forms[0];
    } else if (ch === "'") {
      out += "";
    } else out += base[ch] ?? ch;
    prev = ch;
  }
  return out;
}

/** Lower-case Latin with diacritics, punctuation and spaces stripped (ł has no decomposition). */
export function latinFold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ł/g, "l")
    .replace(/[^\p{L}]/gu, "");
}

/** The Cyrillic fold (SPEC §9.4): lower-case, ё→е, і→и, ў→у, punctuation and spaces stripped. */
export function foldName(text: string): string {
  return foldLetters(text.normalize("NFC").toLowerCase()).replace(/[^\p{L}]/gu, "");
}

function foldLetters(lower: string): string {
  return lower.replace(/ё/g, "е").replace(/і/g, "и").replace(/ў/g, "у");
}

/**
 * Every key of one name string (all its words together, in the order written). Empty for a
 * string without letters.
 */
export function nameKeys(text: string | null | undefined): string[] {
  if (!text) return [];
  const prepared = prepare(text);
  if (!prepared) return [];
  const keys = new Set<string>();
  if (!CYRILLIC_RE.test(prepared)) {
    keys.add(latinFold(prepared));
  } else {
    keys.add(foldName(prepared));
    for (const variant of new Set([prepared, foldLetters(prepared)]))
      for (const table of TABLES) keys.add(latinFold(transliterate(variant, table)));
  }
  keys.delete("");
  return [...keys];
}

/** Keys per word of a free-text name (a payer string whose surname position is unknown). */
export function nameTokenKeys(text: string | null | undefined): string[][] {
  if (!text) return [];
  return prepare(text)
    .split(" ")
    .map((w) => nameKeys(w))
    .filter((k) => k.length > 0);
}

/** A person as an identity document names them (patronymic optional: foreign residents have none). */
export interface PersonName {
  last: string;
  first?: string | null;
  middle?: string | null;
}

/**
 * Surname keys (the last name alone) and full keys (last + first, with and without the
 * patronymic, in both orders).
 */
export function personKeys(name: PersonName): { surname: string[]; full: string[] } {
  const { last } = name;
  const first = name.first?.trim() ?? "";
  const middle = name.middle?.trim() ?? "";
  const orders = first
    ? [
        `${last} ${first}`,
        `${first} ${last}`,
        ...(middle ? [`${last} ${first} ${middle}`, `${first} ${middle} ${last}`] : []),
      ]
    : [last];
  return {
    surname: nameKeys(last),
    full: [...new Set(orders.flatMap((o) => nameKeys(o)))],
  };
}

/** Do two key sets share a key? */
export function keysOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const set = new Set(a);
  return b.some((k) => set.has(k));
}

// ── the be / ru / Latin bridge (C12) ─────────────────────────────────────────────────────────

/** Cyrillic letters → consonant classes; vowels, й and the signs drop (ў reads as в). */
const CYR_CLASS = letters(
  "б b|в v|ў v|г g|ґ g|х g|д d|ж j|з z|к k|л l|м m|н n|п p|р r|с s|т t|ц t|ф f|ч c|ш x|щ x",
);
/** Latin digraphs (longest first) → the same classes. */
const LAT_DIGRAPHS: readonly (readonly [string, string])[] = [
  ["shch", "x"],
  ["dzh", "dj"],
  ["sh", "x"],
  ["zh", "j"],
  ["kh", "g"],
  ["ch", "c"],
  ["ts", "t"],
  ["tz", "t"],
  ["dz", "d"],
  ["ph", "f"],
];
const LAT_CLASS = letters(
  "b b|v v|w v|g g|h g|d d|z z|k k|q k|c k|l l|m m|n n|p p|r r|s s|t t|f f|x ks",
);
/** Diacritic letters the national table and Polish write (before the marks are stripped). */
const LAT_SPECIAL = letters("ŭ w|ž zh|š sh|č ch|ć ch|ś s|ź z|ł l|ń n");
const LAT_VOWELS = new Set([..."aeiouy"]);

/**
 * Common Belarusian given names whose Russian form no skeleton reaches (Вольга / Ольга: the
 * prothetic в; Мікалай / Николай; Ганна / Анна, …). Both columns are reduced at load.
 */
const GIVEN_NAMES: readonly (readonly [string, string])[] = [
  ["Вольга", "Ольга"],
  ["Мікалай", "Николай"],
  ["Мікола", "Николай"],
  ["Уладзімір", "Владимир"],
  ["Ганна", "Анна"],
  ["Рыгор", "Григорий"],
  ["Алесь", "Александр"],
  ["Зміцер", "Дмитрий"],
  ["Кастусь", "Константин"],
  ["Міхась", "Михаил"],
  ["Язэп", "Иосиф"],
  ["Янка", "Иван"],
  ["Юрась", "Юрий"],
  ["Пятрусь", "Петр"],
];
let givenCanon: Map<string, string> | null = null;

/**
 * R2b-6: an l before another consonant reads as v — Belarusian writes ў where Russian keeps л
 * (Ваўкоў / Волков, Воўк / Волк), and ў is v already. Applied to every script alike, so a name
 * still bridges to its own spellings; an l before l, a vowel or nothing stays l.
 */
function lToV(nextClass: string | undefined): boolean {
  return nextClass !== undefined && nextClass !== "" && nextClass !== "l";
}

function cyrSkeleton(word: string): string {
  // шч is the Belarusian щ (Шчарбакоў / Щербаков), дз its д.
  const w = [...word.replace(/шч/g, "щ").replace(/дз/g, "д")];
  let out = "";
  for (let i = 0; i < w.length; i += 1) {
    const cls = CYR_CLASS[w[i]] ?? "";
    const next = w.slice(i + 1).find((ch) => ch !== "ь" && ch !== "ъ");
    out +=
      cls === "l" && lToV(next === undefined ? undefined : (CYR_CLASS[next] ?? "")) ? "v" : cls;
  }
  return out;
}

function latSkeleton(word: string): string {
  const w = [...word]
    .map((ch) => LAT_SPECIAL[ch] ?? ch)
    .join("")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z]/g, "");
  let out = "";
  for (let i = 0; i < w.length;) {
    const digraph = LAT_DIGRAPHS.find(([from]) => w.startsWith(from, i));
    if (digraph) {
      out += digraph[1];
      i += digraph[0].length;
      continue;
    }
    const ch = w[i];
    // A Belarusian ў after a/e/o (IVANOU, KAZLOU, SHAUCHENKA) — not after i (LIUDMILA: ю).
    if (ch === "u" && i > 0 && "aeo".includes(w[i - 1]) && !LAT_VOWELS.has(w[i + 1] ?? "b"))
      out += "v";
    else if (ch === "l" && lToV(i + 1 < w.length ? (LAT_CLASS[w[i + 1]] ?? "") : undefined))
      out += "v";
    else if (!LAT_VOWELS.has(ch)) out += LAT_CLASS[ch] ?? "";
    i += 1;
  }
  return out;
}

/** One word's consonant skeleton (empty without consonants), repeats collapsed. */
function skeleton(word: string): string {
  const raw = CYRILLIC_RE.test(word) ? cyrSkeleton(word) : latSkeleton(word);
  return raw.replace(/(.)\1+/g, "$1");
}

/**
 * The bridge key of one word (C12): the same name in Belarusian Cyrillic, Russian Cyrillic or Latin
 * (passport ICAO, BGN, English) reduced to one consonant skeleton — vowels (akanye, yakanye, і / и,
 * э / е), й / j / y and the signs dropped; ў, a Latin u after a / e / o, and an l before another
 * consonant, as v; шч → щ; дз / dz → d; ц / ts / т → t; г / ґ / х / h / kh → g; щ / ш → sh;
 * repeats collapsed — and the given names of
 * GIVEN_NAMES mapped to the Russian form. Lossy on purpose: a bridged match is weighed with the
 * birth date and decided by the AML officer, never alone; `nameKeys` stays the exact match.
 */
export function bridgeWord(word: string): string {
  if (!givenCanon) {
    givenCanon = new Map();
    for (const [be, ru] of GIVEN_NAMES) {
      const from = skeleton(prepare(be));
      const to = skeleton(prepare(ru));
      if (from !== to) givenCanon.set(from, to);
    }
  }
  const s = skeleton(prepare(word).replace(/[\s']/g, ""));
  return givenCanon.get(s) ?? s;
}

/** The bridge words of a free-text name, in the order written (words without consonants left out). */
export function bridgeWords(text: string | null | undefined): string[] {
  if (!text) return [];
  return prepare(text)
    .split(" ")
    .map((w) => bridgeWord(w))
    .filter(Boolean);
}

/** The bridge key of a free-text name as written: its words' skeletons in order. */
export function bridgeKeys(text: string | null | undefined): string[] {
  const words = bridgeWords(text);
  return words.length ? [words.join("")] : [];
}

/**
 * A person's bridge keys: the surname's, and surname + first name in both orders (the patronymic
 * left out: Мікалаевіч / Николаевич differ beyond any skeleton). No full key without a first name.
 */
export function personBridgeKeys(name: PersonName): { surname: string; full: string[] } {
  const surname = bridgeWords(name.last).join("");
  const first = bridgeWords(name.first).join("");
  return {
    surname,
    full: surname && first ? [...new Set([surname + first, first + surname])] : [],
  };
}
