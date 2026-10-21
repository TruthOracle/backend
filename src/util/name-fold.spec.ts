import {
  bridgeKeys,
  bridgeWord,
  foldName,
  keysOverlap,
  latinFold,
  nameKeys,
  nameTokenKeys,
  personBridgeKeys,
  personKeys,
} from "./name-fold";

const match = (a: string, b: string): boolean => keysOverlap(nameKeys(a), nameKeys(b));

describe("name folding keys (SPEC §9.4, M2)", () => {
  it("folds Cyrillic: lower-case, ё→е, і→и, ў→у, punctuation and spaces stripped", () => {
    expect(foldName("Іваноў")).toBe("иваноу");
    expect(foldName("Семён")).toBe("семен");
    expect(foldName("Дар'я  Іванаўна-Пятрова")).toBe("даряиванаунапятрова");
    expect(foldName("ИВАНОВ, Сергей.")).toBe("ивановсергей");
  });

  it("folds Latin: lower-case, diacritics and punctuation stripped", () => {
    expect(latinFold("IVANOŬ")).toBe("ivanou");
    expect(latinFold("Łukašenka")).toBe("lukasenka");
    expect(latinFold("O'Neil-Smith Jr.")).toBe("oneilsmithjr");
  });

  it("pairs each Cyrillic form with its own Latin form: Іваноў ↔ Ivanou, Иванов ↔ Ivanov", () => {
    expect(nameKeys("Іваноў")).toEqual(expect.arrayContaining(["иваноу", "ivanou"]));
    expect(nameKeys("Иванов")).toEqual(expect.arrayContaining(["иванов", "ivanov"]));
    expect(match("Іваноў", "Ivanou")).toBe(true);
    expect(match("Іваноў", "IVANOŬ")).toBe(true);
    expect(match("Иванов", "Ivanov")).toBe(true);
    expect(match("Иванов", "IVANOV")).toBe(true);
    // The be and ru spellings are different words: an identity carries both forms, and a rule
    // compares against every verified form, so neither pairing is forced here.
    expect(match("Іваноў", "Иванов")).toBe(false);
    expect(match("Іваноў", "Ivanov")).toBe(false);
    expect(match("Иванов", "Ivanou")).toBe(false);
  });

  it("matches Belarusian names with their passport / national Latin spellings", () => {
    // Belarusian passports (ICAO with г→h, ё→io): SIARHEI, ALIAKSANDR, KAVALIOU.
    expect(match("Сяргей", "SIARHEI")).toBe(true);
    expect(match("Аляксандр", "ALIAKSANDR")).toBe(true);
    expect(match("Кавалёў", "KAVALIOU")).toBe(true);
    expect(match("Мікалаевіч", "MIKALAEVICH")).toBe(true);
    // The 2007 national table (diacritics dropped): Siarhiej, Kavalioŭ.
    expect(match("Сяргей", "Siarhiej")).toBe(true);
    expect(match("Кавалёў", "Kavalioŭ")).toBe(true);
    // BGN/PCGN applied to Belarusian text gives the usual press spelling.
    expect(match("Ціханоўская", "Tsikhanouskaya")).toBe(true);
  });

  it("matches Russian names under BGN/PCGN and ICAO alike (Sergey / Sergei, Yelena / Elena)", () => {
    expect(match("Сергей", "SERGEI")).toBe(true);
    expect(match("Сергей", "Sergey")).toBe(true);
    expect(match("Елена", "ELENA")).toBe(true);
    expect(match("Елена", "Yelena")).toBe(true);
    // ё written or not, transliterated or not.
    expect(match("Семён", "Семен")).toBe(true);
    expect(match("Семён", "Semën")).toBe(true);
    // The popular ё→"yo" spelling is in none of the tables (a known gap, left to the rule's review).
    expect(match("Семён", "Semyon")).toBe(false);
    expect(match("Семён", "Semen")).toBe(true);
    // The soft sign and the Belarusian apostrophe agree in Latin.
    expect(match("Дарья", "Дар'я")).toBe(true);
    expect(match("Дарья", "DARIA")).toBe(true);
  });

  it("keeps different people apart", () => {
    expect(match("Иванов", "Петров")).toBe(false);
    expect(match("Сяргей", "SIARHIEJEU")).toBe(false);
    expect(match("Ivanov", "Ivanova")).toBe(false);
    expect(nameKeys("")).toEqual([]);
    expect(nameKeys("  -- ")).toEqual([]);
    expect(nameKeys(null)).toEqual([]);
    expect(keysOverlap([], ["x"])).toBe(false);
  });

  it("gives surname keys and full keys in both orders, with and without the patronymic", () => {
    const be = personKeys({ last: "Іваноў", first: "Сяргей", middle: "Мікалаевіч" });
    expect(be.surname).toEqual(expect.arrayContaining(["ivanou", "иваноу"]));
    // A payer string in either order, with or without the patronymic.
    expect(keysOverlap(be.full, nameKeys("IVANOU SIARHEI"))).toBe(true);
    expect(keysOverlap(be.full, nameKeys("SIARHEI IVANOU"))).toBe(true);
    expect(keysOverlap(be.full, nameKeys("Іваноў Сяргей Мікалаевіч"))).toBe(true);
    expect(keysOverlap(be.full, nameKeys("IVANOU ALIAKSANDR"))).toBe(false);
    // A foreign resident without a patronymic.
    const foreign = personKeys({ last: "Kowalski", first: "Jan", middle: null });
    expect(foreign.full).toEqual(expect.arrayContaining(["kowalskijan", "jankowalski"]));
    expect(personKeys({ last: "Иванов" }).full).toEqual(nameKeys("Иванов"));
  });

  it("splits a free-text payer name into per-word keys (surname position unknown)", () => {
    const words = nameTokenKeys("IVANOU  SIARHEI");
    expect(words).toHaveLength(2);
    const surname = personKeys({ last: "Іваноў", first: "Сяргей" }).surname;
    expect(words.some((w) => keysOverlap(w, surname))).toBe(true);
    expect(nameTokenKeys("Петров Пётр").every((w) => !keysOverlap(w, surname))).toBe(true);
    expect(nameTokenKeys(undefined)).toEqual([]);
  });
});

describe("be / ru / Latin bridge keys (C12)", () => {
  const same = (a: string, b: string): boolean => bridgeWord(a) === bridgeWord(b);

  it("bridges a Belarusian surname, its Russian form and their passport / press Latin spellings", () => {
    for (const [be, ru, ...latin] of [
      ["Іваноў", "Иванов", "IVANOU", "IVANOV", "Ivanov"],
      ["Лукашэнка", "Лукашенко", "LUKASHENKA", "Lukashenko"],
      ["Ціханоўская", "Тихановская", "TSIKHANOUSKAYA", "Tikhanovskaya"],
      ["Каваленка", "Коваленко", "KAVALENKA", "Kovalenko"],
      ["Пятроў", "Петров", "PIATROU", "Petrov"],
      ["Казлоў", "Козлов", "KAZLOU", "Kozlov"],
      ["Шаўчэнка", "Шевченко", "SHAUCHENKA", "Shevchenko"],
      ["Новік", "Новик", "NOVIK"],
      ["Сяргееў", "Сергеев", "SIARHEYEU", "Sergeev"],
    ])
      for (const other of [ru, ...latin])
        expect([be, other, same(be, other)]).toEqual([be, other, true]);
  });

  it("bridges given names, the table carrying the pairs a skeleton cannot (Вольга / Ольга, Уладзімір / Владимир)", () => {
    for (const [be, ...others] of [
      ["Сяргей", "Сергей", "SIARHEI", "Sergey", "Sergei"],
      ["Аляксандр", "Александр", "ALIAKSANDR", "Alexander"],
      ["Дзмітрый", "Дмитрий", "DZMITRY", "Dmitriy"],
      ["Таццяна", "Татьяна", "TATSTSIANA", "Tatiana"],
      ["Людміла", "Людмила", "LIUDMILA"],
      ["Вольга", "Ольга", "VOLHA", "Olga"],
      ["Мікалай", "Николай", "MIKALAI", "Nikolay"],
      ["Уладзімір", "Владимир", "ULADZIMIR", "Vladimir"],
      ["Ганна", "Анна", "HANNA", "Anna"],
      ["Рыгор", "Григорий", "RYHOR"],
    ])
      for (const other of others) expect([be, other, same(be, other)]).toEqual([be, other, true]);
  });

  it("R2b-6: bridges шч to щ and the Belarusian ў to the Russian л before a consonant", () => {
    for (const [be, ...others] of [
      ["Шчарбакоў", "Щербаков", "SHCHARBAKOU", "Shcherbakov", "Ščarbakoŭ"],
      ["Ваўкоў", "Волков", "VAUKOU", "VOLKOV", "Wołkow"],
      ["Воўк", "Волк", "VOUK", "Volk"],
      ["Доўгі", "Долгий", "DOUHI", "Dolgiy"],
    ])
      for (const other of others) expect([be, other, same(be, other)]).toEqual([be, other, true]);
    // An l before l, a vowel or nothing stays l: Алла / ALA still meet, Павел keeps its l.
    expect(same("Алла", "ALA")).toBe(true);
    expect(bridgeWord("Павел")).toBe("pvl");
    expect(same("Волков", "Воронов")).toBe(false);
  });

  it("gives a person surname + first name in both orders, no patronymic, and keeps different people apart", () => {
    const be = personBridgeKeys({ last: "Іваноў", first: "Сяргей", middle: "Мікалаевіч" });
    const ru = personBridgeKeys({ last: "Иванов", first: "Сергей", middle: "Николаевич" });
    const lat = personBridgeKeys({ last: "IVANOU", first: "SIARHEI" });
    expect(be.surname).toBe(ru.surname);
    expect(keysOverlap(be.full, ru.full)).toBe(true);
    expect(keysOverlap(lat.full, ru.full)).toBe(true);
    expect(keysOverlap(be.full, bridgeKeys("Сергей Иванов"))).toBe(true);
    expect(personBridgeKeys({ last: "Иванов" }).full).toEqual([]);
    expect(keysOverlap(ru.full, personBridgeKeys({ last: "Петров", first: "Сергей" }).full)).toBe(
      false,
    );
    expect(
      keysOverlap(ru.full, personBridgeKeys({ last: "Иванов", first: "Александр" }).full),
    ).toBe(false);
    expect(same("Иванов", "Петров")).toBe(false);
    expect(bridgeWord("  --")).toBe("");
  });
});
