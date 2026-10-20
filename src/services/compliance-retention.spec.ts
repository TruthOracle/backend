import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Retention (SPEC §11.6, R4: ≥ 5 years after the relationship ends): no code path deletes ramp,
 * journal, token, approval, consent, identity, screening or compliance rows — only
 * `to_ramp_events.payload` is nulled after 30 days (RampService.purgeEventPayloads). A tripwire over
 * the sources (migrations and specs aside): raw `DELETE FROM` / `TRUNCATE` of a retained table, and
 * TypeORM `delete / remove / softDelete / softRemove / clear` on a retained entity's repository.
 * The e2e side (test/screening.e2e-spec.ts) runs every housekeeping loop over years-old rows.
 */

const SRC = join(__dirname, "..");
const RETAINED_TABLE =
  /^(to_ramp_\w+|to_token_\w+|to_admin_approvals|to_kyc_identit\w+|to_compliance_\w+|to_screening_\w+)$/;
const DESTRUCTIVE = "(?:delete|remove|softDelete|softRemove|clear)";

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "migrations") sources(path, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".spec.ts")) out.push(path);
  }
  return out;
}

/** Entity class → table, from `@Entity({ name: "…" }) … export class X`. */
function retainedEntities(files: Map<string, string>): Set<string> {
  const out = new Set<string>();
  for (const text of files.values()) {
    const re = /@Entity\(\{\s*name:\s*"([a-z_0-9]+)"[\s\S]*?export class (\w+)/g;
    for (let m = re.exec(text); m; m = re.exec(text)) if (RETAINED_TABLE.test(m[1])) out.add(m[2]);
  }
  return out;
}

/** Every place a source would delete retained rows: `file: snippet`. */
export function retentionViolations(files: Map<string, string>): string[] {
  const entities = retainedEntities(files);
  const found: string[] = [];
  const sqlDelete = /(?:DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+"?(to_[a-z_0-9]+)"?/gi;
  for (const [file, text] of files) {
    for (let m = sqlDelete.exec(text); m; m = sqlDelete.exec(text))
      if (RETAINED_TABLE.test(m[1])) found.push(`${file}: ${m[0]}`);
    // Repository fields of retained entities, then destructive calls on them.
    const fields = new Set<string>();
    const inject =
      /@InjectRepository\((\w+)\)\s*(?:private|protected|public)?\s*(?:readonly)?\s*(\w+)/g;
    for (let m = inject.exec(text); m; m = inject.exec(text))
      if (entities.has(m[1])) fields.add(m[2]);
    for (const field of fields) {
      const call = new RegExp(`this\\.${field}\\s*\\.\\s*${DESTRUCTIVE}\\s*\\(`, "g");
      for (let m = call.exec(text); m; m = call.exec(text)) found.push(`${file}: ${m[0]}`);
    }
    for (const entity of entities) {
      const viaRepo = new RegExp(
        `getRepository\\(\\s*${entity}\\s*\\)\\s*\\.\\s*${DESTRUCTIVE}\\s*\\(`,
        "g",
      );
      const viaManager = new RegExp(`\\.\\s*${DESTRUCTIVE}\\s*\\(\\s*${entity}\\b`, "g");
      for (const re of [viaRepo, viaManager])
        for (let m = re.exec(text); m; m = re.exec(text)) found.push(`${file}: ${m[0]}`);
    }
  }
  return found;
}

describe("retention of ramp, token, approval, identity, screening and compliance rows (SPEC §11.6, R4)", () => {
  const files = new Map(
    sources(SRC).map((path) => [relative(SRC, path), readFileSync(path, "utf8")] as const),
  );

  it("finds the retained entities it guards", () => {
    const entities = retainedEntities(files);
    for (const name of [
      "RampOrderEntity",
      "RampJournalEntity",
      "RampEventEntity",
      "TokenCommandEntity",
      "AdminApprovalEntity",
      "ComplianceFreezeEntity",
      "ScreeningHitEntity",
      "ScreeningListEntity",
    ])
      expect(entities).toContain(name);
  });

  it("no source deletes or truncates a retained table", () => {
    expect(retentionViolations(files)).toEqual([]);
  });

  it("the tripwire catches each way of deleting", () => {
    const entity = `@Entity({ name: "to_screening_hits" })\nexport class ScreeningHitEntity {}`;
    const bad = new Map([
      ["entities/hit.ts", entity],
      ["a.ts", `await q.query(\`DELETE FROM "to_ramp_orders" WHERE id = $1\`);`],
      ["b.ts", `await q.query("TRUNCATE TABLE to_token_commands");`],
      [
        "c.ts",
        `constructor(@InjectRepository(ScreeningHitEntity) private readonly hits: Repository<X>) {}\nawait this.hits.delete({ id });`,
      ],
      ["d.ts", `await manager.getRepository(ScreeningHitEntity).remove(row);`],
      ["e.ts", `await manager.delete(ScreeningHitEntity, { id });`],
      // Not retained: sessions may go.
      ["f.ts", `await q.query("DELETE FROM to_sessions WHERE expires_at < now()");`],
    ]);
    expect(retentionViolations(bad).map((v) => v.split(":")[0])).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
      "d.ts",
      "e.ts",
    ]);
  });
});
