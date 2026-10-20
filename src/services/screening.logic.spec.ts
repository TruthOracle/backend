import { ApiError } from "../util/errors";
import { DAY_MS, HOUR_MS } from "../util/time";
import type { VerifiedName } from "./kyc-identity.port";
import {
  birthDateAgreement,
  buildScreeningIndex,
  type CompiledEntry,
  entryNameKeys,
  freezesOnHit,
  looksLikePatronymic,
  normalizeBirthDate,
  parseScreeningList,
  principalKeys,
  rescreenDue,
  screeningStaleness,
  screenSubject,
} from "./screening.logic";

const HEADER = "kind,name_variants,birth_date,ids\r\n";

function errorOf(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (err) {
    if (ApiError.is(err)) return err;
    throw err;
  }
  throw new Error("expected an ApiError");
}

function compiled(
  rows: string,
  list: CompiledEntry["list"] = "by_terror",
  listId = "list-1",
): CompiledEntry[] {
  return parseScreeningList(HEADER + rows).map((e, i) => ({
    id: `${listId}:${i + 1}`,
    listId,
    list,
    kind: e.kind,
    names: e.names,
    nameKeys: e.nameKeys,
    birthDate: e.birthDate,
    ids: e.ids,
  }));
}

describe("the normalized list CSV (SPEC §11.6)", () => {
  it("parses persons, organisations and addresses with |-separated variants and ids", () => {
    const entries = parseScreeningList(
      HEADER +
        `person,"Іваноў Сяргей Мікалаевіч|Иванов Сергей Николаевич|IVANOU SIARHEI",15.03.1975,MP1234567\r\n` +
        `org,"""Ромашка"" ООО|Romashka LLC",,\r\n` +
        `address,,,"wallet::1220abcd|0xdeadbeef"\r\n`,
    );
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      line: 1,
      kind: "person",
      names: ["Іваноў Сяргей Мікалаевіч", "Иванов Сергей Николаевич", "IVANOU SIARHEI"],
      birthDate: "1975-03-15",
      ids: ["MP1234567"],
    });
    expect(entries[0].nameKeys).toEqual(
      expect.arrayContaining([
        "иваноусяргеймикалаевич",
        "ivanovsergeinikolaevich",
        "ivanousiarhei",
      ]),
    );
    expect(entries[1]).toMatchObject({ kind: "org", names: ['"Ромашка" ООО', "Romashka LLC"] });
    expect(entries[2]).toMatchObject({
      kind: "address",
      names: [],
      nameKeys: [],
      ids: ["wallet::1220abcd", "0xdeadbeef"],
    });
  });

  it("accepts a file without the header, years and months as birth dates, and drops blank variants", () => {
    const [e] = parseScreeningList(`PERSON, Petrov Petr | |,1980,\n`);
    expect(e).toMatchObject({ kind: "person", names: ["Petrov Petr"], birthDate: "1980", ids: [] });
    expect(normalizeBirthDate("1980-07")).toBe("1980-07");
    expect(normalizeBirthDate(" ")).toBeNull();
  });

  it("refuses malformed files with screening_list_invalid naming the record", () => {
    const cases: [string, RegExp][] = [
      [HEADER, /no entries/],
      ["kind,names,birth_date,ids\r\nperson,A B,,\r\n", /header must be/],
      [HEADER + "person,Ivanov Ivan\r\n", /record 1: expected 4 fields/],
      [HEADER + "person,A B,,\r\nship,X,,\r\n", /record 2: kind must be/],
      [HEADER + "person,---,,\r\n", /record 1: a person needs a name/],
      [HEADER + "address,,,\r\n", /record 1: an address needs an id/],
      [HEADER + "person,A B,1975-13-01,\r\n", /record 1: birth_date has no month/],
      [HEADER + "person,A B,31.02.1975,\r\n", /not a calendar day/],
      [HEADER + "person,A B,around 1975,\r\n", /birth_date must be/],
      [HEADER + 'person,"A B,,\r\n', /unterminated quote/],
    ];
    for (const [text, message] of cases) {
      const err = errorOf(() => parseScreeningList(text));
      expect(err).toMatchObject({ status: 400, code: "screening_list_invalid" });
      expect(err.message).toMatch(message);
    }
    expect(
      errorOf(() => parseScreeningList(HEADER + "person,A B,,\r\n".repeat(3), 2)),
    ).toMatchObject({
      code: "screening_list_invalid",
    });
  });
});

describe("entry keys and matching (be / ru / Latin variants, birth dates, parties)", () => {
  it("recognises patronymics and also keys a name without it", () => {
    for (const w of [
      "Мікалаевіч",
      "Николаевич",
      "Мікалаеўна",
      "Николаевна",
      "MIKALAEVICH",
      "Ilyinichna",
    ])
      expect(looksLikePatronymic(w)).toBe(true);
    for (const w of ["Иванов", "Сяргей", "IVANOU", "Smith", "Ivan"])
      expect(looksLikePatronymic(w)).toBe(false);
    const keys = entryNameKeys(["ИВАНОВ Сергей Николаевич"]);
    expect(keys).toEqual(
      expect.arrayContaining(["ивановсергейниколаевич", "ивановсергей", "ivanovsergei"]),
    );
    // A third word that is not a patronymic keeps the name whole (no generic two-word key).
    expect(entryNameKeys(["Abu Bakr Al-Baghdadi"])).not.toContain("abubakr");
  });

  const index = buildScreeningIndex([
    ...compiled(
      `person,"Іваноў Сяргей Мікалаевіч|Иванов Сергей Николаевич",1975-03-15,\r\n` +
        `person,Petrova Anna,1980,\r\n` +
        `person,Sidorov Oleg,,\r\n` +
        `org,Ivanov Sergei,,\r\n`,
    ),
    ...compiled(`address,,,"wallet::1220abcd|1220ffff"\r\n`, "decree48", "list-2"),
  ]);

  it("matches the Belarusian, Russian and passport forms of the same person, in either word order", () => {
    const forms = [
      { script: "be" as const, last: "Іваноў", first: "Сяргей", middle: "Мікалаевіч" },
      { script: "ru" as const, last: "Иванов", first: "Сергей", middle: "Николаевич" },
      // The passport's Latin form has no patronymic: the entry's patronymic-less key catches it.
      { script: "lat" as const, last: "IVANOU", first: "SIARHEI" },
      { script: "lat" as const, last: "IVANOV", first: "SERGEI" },
    ];
    for (const name of forms) {
      const hits = screenSubject(index, { names: [name], birthDate: "1975-03-15", parties: [] });
      expect(hits.map((h) => h.entry.id)).toEqual(["list-1:1"]);
      expect(hits[0].match).toMatchObject({
        basis: "name",
        script: name.script,
        birthDate: "exact",
      });
    }
    // An identity carrying all three forms is one hit, not three; the organisation entry never matches a person.
    expect(
      screenSubject(index, { names: forms, birthDate: "1975-03-15", parties: [] }),
    ).toHaveLength(1);
  });

  it("a contradicting birth date clears a name match; a missing one or a year-only entry still matches", () => {
    const ivanov = { script: "ru" as const, last: "Иванов", first: "Сергей", middle: "Николаевич" };
    expect(screenSubject(index, { names: [ivanov], birthDate: "1976-03-15", parties: [] })).toEqual(
      [],
    );
    expect(
      screenSubject(index, { names: [ivanov], birthDate: null, parties: [] })[0].match,
    ).toMatchObject({ birthDate: "unknown" });
    const anna = { script: "lat" as const, last: "PETROVA", first: "ANNA" };
    expect(
      screenSubject(index, { names: [anna], birthDate: "1980-11-02", parties: [] })[0].match,
    ).toMatchObject({ birthDate: "partial", entryName: "Petrova Anna" });
    expect(screenSubject(index, { names: [anna], birthDate: "1981-11-02", parties: [] })).toEqual(
      [],
    );
    const oleg = { script: "lat" as const, last: "Sidorov", first: "Oleg" };
    expect(
      screenSubject(index, { names: [oleg], birthDate: "1990-01-01", parties: [] }),
    ).toHaveLength(1);
    // Other people stay apart.
    const other = { script: "ru" as const, last: "Петров", first: "Сергей" };
    expect(screenSubject(index, { names: [other], birthDate: "1975-03-15", parties: [] })).toEqual(
      [],
    );
  });

  it("matches a party id or its namespace against listed ids", () => {
    const hits = screenSubject(index, {
      names: [],
      birthDate: null,
      parties: ["clean::1220aaaa", "wallet::1220abcd", "other::1220ffff"],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].match).toEqual({
      basis: "party",
      party: "wallet::1220abcd",
      listed: "wallet::1220abcd",
    });
    const byNamespace = screenSubject(index, {
      names: [],
      birthDate: null,
      parties: ["x::1220ffff"],
    });
    expect(byNamespace[0].match).toEqual({
      basis: "party",
      party: "x::1220ffff",
      listed: "1220ffff",
    });
  });

  it("birth-date agreement levels and which lists freeze", () => {
    expect(birthDateAgreement("1975-03-15", "1975-03-15")).toBe("exact");
    expect(birthDateAgreement("1975-03", "1975-03-15")).toBe("partial");
    expect(birthDateAgreement("1975", "1974-03-15")).toBeNull();
    expect(birthDateAgreement(null, "1975-03-15")).toBe("unknown");
    expect(["by_terror", "un", "decree48"].every((l) => freezesOnHit(l as never))).toBe(true);
    expect(freezesOnHit("foreign")).toBe(false);
  });
});

describe("C12: Belarusian and Latin identity forms against Russian-only list entries", () => {
  // The KGB list is published in Russian; the UN list in English. Neither carries the be form.
  const index = buildScreeningIndex([
    ...compiled(
      `person,ИВАНОВ Сергей Николаевич,01.05.1980,\r\n` +
        `person,ТИХАНОВСКАЯ Светлана Георгиевна,1982,\r\n`,
    ),
    ...compiled(
      `person,"Sergey Nikolaevich IVANOV|IVANOV Sergey",1980-05-01,\r\n`,
      "un",
      "list-un",
    ),
  ]);
  const ids = (names: VerifiedName[], birthDate: string | null): string[] =>
    screenSubject(index, { names, birthDate, parties: [] })
      .map((h) => h.entry.id)
      .sort();

  it("a be-only or Latin-only identity matches the Russian and English entries (bridged), with the birth date as before", () => {
    const be: VerifiedName = {
      script: "be",
      last: "Іваноў",
      first: "Сяргей",
      middle: "Мікалаевіч",
    };
    const lat: VerifiedName = { script: "lat", last: "IVANOU", first: "SIARHEI" };
    for (const name of [be, lat]) {
      expect(ids([name], "1980-05-01")).toEqual(["list-1:1", "list-un:1"]);
      const [hit] = screenSubject(index, { names: [name], birthDate: "1980-05-01", parties: [] });
      expect(hit.match).toMatchObject({ basis: "name", via: "bridge", birthDate: "exact" });
      // A contradicting birth date still clears it.
      expect(ids([name], "1981-05-01")).toEqual([]);
    }
    // Latin Sergei vs the list's Sergey.
    expect(ids([{ script: "lat", last: "IVANOV", first: "SERGEI" }], "1980-05-01")).toEqual([
      "list-1:1",
      "list-un:1",
    ]);
    expect(ids([{ script: "be", last: "Ціханоўская", first: "Святлана" }], "1982-08-11")).toEqual([
      "list-1:2",
    ]);
  });

  it("the surname and the exact birth date alone make a candidate hit; a year-only or missing birth date does not", () => {
    const oleg: VerifiedName = { script: "be", last: "Іваноў", first: "Алег" };
    const [hit, ...rest] = screenSubject(index, {
      names: [oleg],
      birthDate: "1980-05-01",
      parties: [],
    });
    expect(rest.map((h) => h.entry.id)).toEqual(["list-un:1"]);
    expect(hit.match).toMatchObject({ basis: "name", via: "surname_dob", birthDate: "exact" });
    expect(ids([oleg], null)).toEqual([]);
    expect(ids([{ script: "be", last: "Ціханоўская", first: "Вольга" }], "1982-08-11")).toEqual([]);
    expect(ids([{ script: "ru", last: "Петров", first: "Сергей" }], "1980-05-01")).toEqual([]);
  });
});

describe("R2b-2 / R2b-6: -вич surnames, шч / щ and ў / л reach the bridge", () => {
  const ids = (entries: CompiledEntry[], names: VerifiedName[], birthDate: string): string[] =>
    screenSubject(buildScreeningIndex(entries), { names, birthDate, parties: [] })
      .map((h) => h.entry.id)
      .sort();
  const shushkevich: VerifiedName[] = [
    { script: "be", last: "Шушкевіч", first: "Станіслаў" },
    { script: "lat", last: "SHUSHKEVICH", first: "STANISLAU" },
  ];

  it("a -вич / -ич surname is a surname, not a patronymic: the be + Latin identity matches every list form", () => {
    for (const row of [
      "Шушкевич Станислав Станиславович",
      "Шушкевич Станислав",
      "SHUSHKEVICH Stanislav Stanislavovich",
      "Станислав Станиславович Шушкевич",
    ]) {
      const entries = compiled(`person,${row},15.12.1934,\r\n`);
      expect([row, ids(entries, shushkevich, "1934-12-15")]).toEqual([row, ["list-1:1"]]);
      // Another birth date still clears it.
      expect([row, ids(entries, shushkevich, "1935-12-15")]).toEqual([row, []]);
    }
    // A declared principal with the -вич surname is bridged too.
    const principal = screenSubject(
      buildScreeningIndex(compiled(`person,Шушкевич Станислав Станиславович,1934,\r\n`)),
      {
        names: [],
        birthDate: null,
        parties: [],
        principals: [{ consentId: "c", text: "Шушкевіч Станіслаў" }],
      },
    );
    expect(principal.map((h) => h.entry.id)).toEqual(["list-1:1"]);
  });

  it("a Russian entry meets a Belarusian ў-for-л identity, and a Belarusian шч entry a Russian щ identity", () => {
    expect(
      ids(
        compiled(`person,Волков Иван,1970-03-03,\r\n`),
        [
          { script: "be", last: "Ваўкоў", first: "Іван" },
          { script: "lat", last: "VAUKOU", first: "IVAN" },
        ],
        "1970-03-03",
      ),
    ).toEqual(["list-1:1"]);
    expect(
      ids(
        compiled(`person,Шчарбакоў Сяргей,1971-04-04,\r\n`),
        [
          { script: "ru", last: "Щербаков", first: "Сергей" },
          { script: "lat", last: "SHCHERBAKOV", first: "SERGEI" },
        ],
        "1971-04-04",
      ),
    ).toEqual(["list-1:1"]);
  });
});

describe("C13: a declared principal is screened (free text, any word order, persons and organisations)", () => {
  const index = buildScreeningIndex([
    ...compiled(
      `person,ИВАНОВ Сергей Николаевич,01.05.1980,\r\n` + `org,"ООО Ромашка|Romashka LLC",,\r\n`,
    ),
  ]);
  const principal = (text: string) =>
    screenSubject(index, {
      names: [],
      birthDate: null,
      parties: [],
      principals: [{ consentId: "c-1", text }],
    });

  it("matches the person in either order, with a patronymic, in be or Latin, and an organisation; never on a birth date", () => {
    for (const text of [
      "Иванов Сергей",
      "Сергей Николаевич Иванов",
      "Іваноў Сяргей",
      "SIARHEI IVANOU, my father",
    ]) {
      const [hit, ...rest] = principal(text);
      expect([text, rest]).toEqual([text, []]);
      expect(hit.match).toEqual({
        basis: "principal",
        consentId: "c-1",
        entryName: "ИВАНОВ Сергей Николаевич",
        entryBirthDate: "1980-05-01",
        entryIds: [],
      });
    }
    expect(principal("Romashka LLC").map((h) => h.entry.id)).toEqual(["list-1:2"]);
    expect(principal("Петров Пётр")).toEqual([]);
    // Past four words the text is keyed as written (no permutations).
    expect(principalKeys("a b c d e f").fold).toEqual(["abcdef"]);
  });
});

describe("re-screen schedule and staleness", () => {
  const now = new Date("2026-10-19T12:00:00Z");
  const run = (
    daysAgo: number,
    status: "running" | "done" | "partial" | "failed",
    listIds = ["a", "b"],
  ) => ({
    startedAt: new Date(now.getTime() - daysAgo * DAY_MS),
    status,
    listIds,
  });
  const due = (
    lastDone: ReturnType<typeof run> | null,
    lastAttempt = lastDone,
    latest = ["a", "b"],
  ) => rescreenDue({ now, rescreenDays: 30, latestListIds: latest, lastDone, lastAttempt });

  it("is due when never run, after a new list version, after RAMP_RESCREEN_DAYS, and an hour after a failed attempt", () => {
    expect(due(null, null, [])).toBeNull();
    expect(due(null, null)).toBe("never");
    expect(due(run(1, "done"))).toBeNull();
    expect(due(run(1, "done"), run(1, "done"), ["a", "c"])).toBe("new_list");
    expect(due(run(29.9, "done"))).toBeNull();
    expect(due(run(30, "done"))).toBe("schedule");
    // A partial attempt after a good run: retried an hour later, not before; a run in progress is left alone.
    const partialRecent = {
      ...run(0, "partial"),
      startedAt: new Date(now.getTime() - HOUR_MS / 2),
    };
    expect(due(run(40, "done"), partialRecent)).toBeNull();
    expect(due(run(40, "done"), run(1, "partial"))).toBe("schedule");
    expect(due(null, run(1, "failed"))).toBe("retry");
    expect(due(null, { ...run(0, "running"), startedAt: now })).toBeNull();
  });

  it("screening_stale is amber without a complete re-screen in 90 days or a fresh freezing list", () => {
    const fresh = { by_terror: now, un: now, decree48: now };
    expect(
      screeningStaleness({ now, listMaxAgeDays: 30, lastDoneFullAt: now, latestImports: fresh }),
    ).toEqual({ status: "green", problems: [] });
    const stale = screeningStaleness({
      now,
      listMaxAgeDays: 30,
      lastDoneFullAt: new Date(now.getTime() - 91 * DAY_MS),
      latestImports: { by_terror: new Date(now.getTime() - 31 * DAY_MS), un: now },
    });
    expect(stale.status).toBe("amber");
    expect(stale.problems).toEqual([
      "last complete full re-screen 91 days ago",
      "by_terror last imported 31 days ago",
      "decree48 never imported",
    ]);
    // The foreign list is optional.
    expect(
      screeningStaleness({ now, listMaxAgeDays: 30, lastDoneFullAt: null, latestImports: fresh })
        .problems,
    ).toEqual(["no complete full re-screen yet"]);
  });
});
