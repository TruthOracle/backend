import { ApiError } from "./errors";

/**
 * CSV per RFC 4180 (SPEC §8, X16): CRLF records, EVERY cell quoted, `"` doubled.
 * - `human` — exports an operator opens in a spreadsheet (compliance, operations): a text cell
 *   starting with `= + - @ TAB CR` gets a leading `'`, so text others control (KYC names, PSP
 *   strings, reasons) is never evaluated as a formula. A plain signed decimal ("-12.50") is not
 *   a formula and stays a number.
 * - `bank` — files a bank system ingests: cells verbatim (the bank needs exact names and amounts;
 *   callers validate names first). Control characters are refused: they would split a record.
 */
export type CsvMode = "human" | "bank";
export type CsvValue = string | number | bigint | boolean | Date | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_DECIMAL = /^[+-]?\d+(\.\d+)?$/;
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

export function csvCell(value: CsvValue, mode: CsvMode): string {
  let text: string;
  if (value === null || value === undefined) text = "";
  else if (value instanceof Date) text = value.toISOString();
  else if (typeof value === "number" && !Number.isFinite(value))
    throw new Error("csv: a cell must not be a non-finite number");
  else text = String(value);
  if (mode === "bank") {
    if (CONTROL_CHAR.test(text))
      throw new Error("csv (bank): control characters are not allowed in a cell");
  } else if (FORMULA_START.test(text) && !PLAIN_DECIMAL.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

/** Whole file: optional header row, then rows; every record ends with CRLF. */
export function toCsv(
  rows: readonly (readonly CsvValue[])[],
  mode: CsvMode,
  header?: readonly string[],
): string {
  const records = header ? [header, ...rows] : rows;
  return records.map((r) => `${r.map((cell) => csvCell(cell, mode)).join(",")}\r\n`).join("");
}

/**
 * RFC 4180 reader for uploaded files (statement CSVs; decode with util/charset first): quoted
 * fields with `""` escapes and embedded line breaks, CRLF or LF records, `,` or `;` delimiters.
 * A quote inside an unquoted field, text after a closing quote or an unterminated quote is
 * refused; blank lines are skipped; callers check row widths.
 */
export function parseCsv(
  text: string,
  opts: { delimiter?: "," | ";"; maxRows?: number } = {},
): string[][] {
  const delimiter = opts.delimiter ?? ",";
  const maxRows = opts.maxRows ?? 50_000;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let wasQuoted = false;
  const bad = (why: string): ApiError =>
    new ApiError(400, "validation_failed", `CSV record ${rows.length + 1}: ${why}`);
  const endRecord = (): void => {
    row.push(field);
    if (!(row.length === 1 && row[0] === "" && !wasQuoted)) rows.push(row);
    if (rows.length > maxRows) throw bad(`more than ${maxRows} records`);
    row = [];
    field = "";
    wasQuoted = false;
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = false;
        const next = text[i + 1];
        if (next !== undefined && next !== delimiter && next !== "\r" && next !== "\n")
          throw bad("text after a closing quote");
      }
    } else if (c === '"') {
      if (field !== "" || wasQuoted) throw bad("a quote inside an unquoted field");
      quoted = true;
      wasQuoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
      wasQuoted = false;
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      endRecord();
    } else field += c;
  }
  if (quoted) throw bad("an unterminated quote");
  if (field !== "" || wasQuoted || row.length > 0) endRecord();
  return rows;
}
