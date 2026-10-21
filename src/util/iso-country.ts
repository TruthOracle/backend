/**
 * ISO 3166-1 country codes (SPEC §11.3, S7a): the KYC provider names countries in alpha-3 (`BLR`),
 * the configuration in alpha-2 (`BY`). The officially assigned codes plus Kosovo (`XKX` / `XK`, the
 * user-assigned pair KYC vendors use). Anything else maps to null — a country the rules cannot
 * place, which the eligibility rules treat as not allowed (fail closed).
 */
const PAIRS =
  "AFG AF|ALA AX|ALB AL|DZA DZ|ASM AS|AND AD|AGO AO|AIA AI|ATA AQ|ATG AG|ARG AR|ARM AM|ABW AW|" +
  "AUS AU|AUT AT|AZE AZ|BHS BS|BHR BH|BGD BD|BRB BB|BLR BY|BEL BE|BLZ BZ|BEN BJ|BMU BM|BTN BT|" +
  "BOL BO|BES BQ|BIH BA|BWA BW|BVT BV|BRA BR|IOT IO|BRN BN|BGR BG|BFA BF|BDI BI|CPV CV|KHM KH|" +
  "CMR CM|CAN CA|CYM KY|CAF CF|TCD TD|CHL CL|CHN CN|CXR CX|CCK CC|COL CO|COM KM|COG CG|COD CD|" +
  "COK CK|CRI CR|CIV CI|HRV HR|CUB CU|CUW CW|CYP CY|CZE CZ|DNK DK|DJI DJ|DMA DM|DOM DO|ECU EC|" +
  "EGY EG|SLV SV|GNQ GQ|ERI ER|EST EE|SWZ SZ|ETH ET|FLK FK|FRO FO|FJI FJ|FIN FI|FRA FR|GUF GF|" +
  "PYF PF|ATF TF|GAB GA|GMB GM|GEO GE|DEU DE|GHA GH|GIB GI|GRC GR|GRL GL|GRD GD|GLP GP|GUM GU|" +
  "GTM GT|GGY GG|GIN GN|GNB GW|GUY GY|HTI HT|HMD HM|VAT VA|HND HN|HKG HK|HUN HU|ISL IS|IND IN|" +
  "IDN ID|IRN IR|IRQ IQ|IRL IE|IMN IM|ISR IL|ITA IT|JAM JM|JPN JP|JEY JE|JOR JO|KAZ KZ|KEN KE|" +
  "KIR KI|PRK KP|KOR KR|KWT KW|KGZ KG|LAO LA|LVA LV|LBN LB|LSO LS|LBR LR|LBY LY|LIE LI|LTU LT|" +
  "LUX LU|MAC MO|MDG MG|MWI MW|MYS MY|MDV MV|MLI ML|MLT MT|MHL MH|MTQ MQ|MRT MR|MUS MU|MYT YT|" +
  "MEX MX|FSM FM|MDA MD|MCO MC|MNG MN|MNE ME|MSR MS|MAR MA|MOZ MZ|MMR MM|NAM NA|NRU NR|NPL NP|" +
  "NLD NL|NCL NC|NZL NZ|NIC NI|NER NE|NGA NG|NIU NU|NFK NF|MKD MK|MNP MP|NOR NO|OMN OM|PAK PK|" +
  "PLW PW|PSE PS|PAN PA|PNG PG|PRY PY|PER PE|PHL PH|PCN PN|POL PL|PRT PT|PRI PR|QAT QA|REU RE|" +
  "ROU RO|RUS RU|RWA RW|BLM BL|SHN SH|KNA KN|LCA LC|MAF MF|SPM PM|VCT VC|WSM WS|SMR SM|STP ST|" +
  "SAU SA|SEN SN|SRB RS|SYC SC|SLE SL|SGP SG|SXM SX|SVK SK|SVN SI|SLB SB|SOM SO|ZAF ZA|SGS GS|" +
  "SSD SS|ESP ES|LKA LK|SDN SD|SUR SR|SJM SJ|SWE SE|CHE CH|SYR SY|TWN TW|TJK TJ|TZA TZ|THA TH|" +
  "TLS TL|TGO TG|TKL TK|TON TO|TTO TT|TUN TN|TUR TR|TKM TM|TCA TC|TUV TV|UGA UG|UKR UA|ARE AE|" +
  "GBR GB|USA US|UMI UM|URY UY|UZB UZ|VUT VU|VEN VE|VNM VN|VGB VG|VIR VI|WLF WF|ESH EH|YEM YE|" +
  "ZMB ZM|ZWE ZW|XKX XK";

const ALPHA3_TO_ALPHA2: ReadonlyMap<string, string> = new Map(
  PAIRS.split("|").map((pair) => {
    const [alpha3, alpha2] = pair.split(" ");
    return [alpha3, alpha2] as const;
  }),
);
const ALPHA2_CODES: ReadonlySet<string> = new Set(ALPHA3_TO_ALPHA2.values());

/** Every alpha-2 code known here (tests, config refusals). */
export function alpha2Codes(): string[] {
  return [...ALPHA2_CODES];
}

/** Is `code` an assigned ISO 3166-1 alpha-2 code (upper-case)? */
export function isAlpha2(code: string): boolean {
  return ALPHA2_CODES.has(code);
}

/** `BLR` / `blr` / `BY` / `by` → `BY`; blank or unknown → null. */
export function toAlpha2(code: string | null | undefined): string | null {
  const c = (code ?? "").trim().toUpperCase();
  if (c.length === 2) return ALPHA2_CODES.has(c) ? c : null;
  if (c.length === 3) return ALPHA3_TO_ALPHA2.get(c) ?? null;
  return null;
}
