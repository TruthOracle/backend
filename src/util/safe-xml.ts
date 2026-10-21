import { XMLParser, XMLValidator } from "fast-xml-parser";

import { ApiError } from "./errors";

/**
 * Hardened XML parsing for uploaded files (camt.053 statements, screening lists; SPEC §8, X16).
 * Before the parser sees a byte: DOCTYPE / ENTITY and every other `<!` declaration are refused
 * (no DTD, no entity expansion, no external references), nesting is capped at 32, elements at
 * 50 000, and `__proto__` / `constructor` / `prototype` element or attribute names are refused.
 * Then fast-xml-parser (pinned) validates and parses with entity processing off and values kept as
 * strings (amounts go through `parseAmount`, never through a float).
 */
export const SAFE_XML_MAX_DEPTH = 32;
export const SAFE_XML_MAX_ELEMENTS = 50_000;
/** Decoded text, in UTF-16 code units (the route body limit bounds the upload itself). */
export const SAFE_XML_MAX_LENGTH = 5 * 1024 * 1024;
/** One tag from `<` to `>`, quoted values included (a camt.053 tag is a few hundred at most). */
export const SAFE_XML_MAX_TAG_LENGTH = 8 * 1024;

const FORBIDDEN_NAMES = new Set(["__proto__", "constructor", "prototype"]);
// Sticky: it matches at lastIndex or not at all, so it never re-scans a run (C24: the unanchored
// /name\s*=/g it replaces was quadratic on a long run with no '=').
const NAME_RE = /[A-Za-z_:][\w.:-]*/y;

export interface SafeXmlLimits {
  maxDepth?: number;
  maxElements?: number;
  maxLength?: number;
  maxTagLength?: number;
}

function refuse(why: string): ApiError {
  return new ApiError(400, "validation_failed", `XML refused: ${why}`);
}

function checkName(name: string): void {
  const local = name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
  if (FORBIDDEN_NAMES.has(name) || FORBIDDEN_NAMES.has(local))
    throw refuse(`the name ${local} is not allowed`);
}

/**
 * One linear pass over the markup (comments, CDATA and processing instructions skipped, quoted
 * attribute values honoured): declarations, depth, element count, tag length and reserved names.
 * Every name-like token outside quotes in a start tag is checked; in a well-formed tag those are
 * exactly the attribute names (anything else the validator refuses after this scan).
 */
export function scanXml(xml: string, limits: SafeXmlLimits = {}): void {
  const maxDepth = limits.maxDepth ?? SAFE_XML_MAX_DEPTH;
  const maxElements = limits.maxElements ?? SAFE_XML_MAX_ELEMENTS;
  const maxTagLength = limits.maxTagLength ?? SAFE_XML_MAX_TAG_LENGTH;
  if (/<!DOCTYPE/i.test(xml)) throw refuse("DOCTYPE is not allowed");
  if (/<!ENTITY/i.test(xml)) throw refuse("ENTITY is not allowed");
  let depth = 0;
  let elements = 0;
  let i = xml.indexOf("<");
  while (i >= 0) {
    if (xml.startsWith("<!--", i)) {
      const end = xml.indexOf("-->", i + 4);
      if (end < 0) throw refuse("an unterminated comment");
      i = xml.indexOf("<", end + 3);
      continue;
    }
    if (xml.startsWith("<![CDATA[", i)) {
      const end = xml.indexOf("]]>", i + 9);
      if (end < 0) throw refuse("an unterminated CDATA section");
      i = xml.indexOf("<", end + 3);
      continue;
    }
    if (xml.startsWith("<!", i)) throw refuse("declarations are not allowed");
    if (xml.startsWith("<?", i)) {
      const end = xml.indexOf("?>", i + 2);
      if (end < 0) throw refuse("an unterminated processing instruction");
      i = xml.indexOf("<", end + 2);
      continue;
    }
    const closing = xml[i + 1] === "/";
    NAME_RE.lastIndex = i + (closing ? 2 : 1);
    const name = NAME_RE.exec(xml)?.[0];
    if (!name) throw refuse("a malformed tag");
    if (!closing) checkName(name);
    let j = NAME_RE.lastIndex;
    while (j < xml.length && xml[j] !== ">") {
      if (j - i > maxTagLength) throw refuse(`a tag longer than ${maxTagLength} characters`);
      const c = xml[j];
      if (c === '"' || c === "'") {
        const close = xml.indexOf(c, j + 1);
        if (close < 0) throw refuse("an unterminated attribute value");
        j = close + 1;
        continue;
      }
      if (!closing) {
        NAME_RE.lastIndex = j;
        const attr = NAME_RE.exec(xml)?.[0];
        if (attr) {
          checkName(attr);
          j = NAME_RE.lastIndex;
          continue;
        }
      }
      j += 1;
    }
    if (j >= xml.length) throw refuse("an unterminated tag");
    if (j - i > maxTagLength) throw refuse(`a tag longer than ${maxTagLength} characters`);
    if (closing) {
      depth -= 1;
      if (depth < 0) throw refuse("an unbalanced closing tag");
    } else {
      elements += 1;
      if (elements > maxElements) throw refuse(`more than ${maxElements} elements`);
      if (xml[j - 1] !== "/") {
        depth += 1;
        if (depth > maxDepth) throw refuse(`nesting deeper than ${maxDepth}`);
      }
    }
    i = xml.indexOf("<", j + 1);
  }
}

const PREDEFINED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * Entity processing is off, so parsed values keep `&amp;` etc. literally. This decodes only the
 * five predefined entities and numeric references (`&#1040;`, `&#x410;`) of ONE value: nothing
 * can expand, the result is never longer than the input.
 */
export function decodeXmlText(value: string): string {
  return value.replace(
    /&(amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});/g,
    (match, ref: string) => {
      if (ref[0] !== "#") return PREDEFINED_ENTITIES[ref];
      const code = ref[1] === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return match;
      return String.fromCodePoint(code);
    },
  );
}

/**
 * Scan, validate, parse. Attributes are kept under `@_<name>`, namespace prefixes dropped, every
 * value a string (see `decodeXmlText`); `400 validation_failed` for anything refused or malformed.
 */
export function parseSafeXml(xml: string, limits: SafeXmlLimits = {}): Record<string, unknown> {
  if (typeof xml !== "string") throw refuse("not text");
  if (xml.length > (limits.maxLength ?? SAFE_XML_MAX_LENGTH)) throw refuse("the file is too large");
  scanXml(xml, limits);
  const valid = XMLValidator.validate(xml, { allowBooleanAttributes: false });
  if (valid !== true) throw refuse(`malformed at line ${valid.err.line}`);
  const parser = new XMLParser({
    processEntities: false,
    htmlEntities: false,
    ignoreDeclaration: true,
    ignorePiTags: true,
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    maxNestedTags: limits.maxDepth ?? SAFE_XML_MAX_DEPTH,
  });
  return parser.parse(xml) as Record<string, unknown>;
}
