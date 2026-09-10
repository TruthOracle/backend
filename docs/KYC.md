# KYC — provider-neutral design, and how to plug a vendor in later

**Status: the KYC vendor has not been chosen.** Everything below that is vendor-neutral is
built and tested against the mock provider, which is the default outside production. A
Sumsub adapter exists as a *reference implementation* of the provider interface so the
integration shape is proven; it is not a commitment to Sumsub. Choosing and wiring the real
provider is a later, self-contained step (§5).

## 1. What is vendor-neutral (built now)

| Concern | Where | Notes |
|---|---|---|
| Verification lifecycle | `KycService`, `to_kyc_verifications` | `none → initiated → pending → approved \| rejected_retry \| rejected_final \| needs_review \| blocked_duplicate`, `approved → expired` (ARCHITECTURE §9.2) |
| One person, one account | `KycService`, `to_kyc_persons` | peppered `doc` + `person` fingerprints; binding survives expiry/closure; audited admin transfer (§9.3) |
| Withdrawal gate | `KycService.withdrawalGate`, `PayoutService` | only external `withdraw` payouts are gated; `KYC_ENFORCE_WITHDRAWALS=false` by default (§9.4) |
| Attachment to the login method | `initiated_identity_id` | that identity is locked while the approval stands (§6.5, §9.5) |
| Admin tooling | `AdminService` | override (`provider = admin`), duplicates / needs-review queues, person transfer |
| Data minimisation | everywhere | applicant data lives in memory for one call; only fingerprints and provider ids persist (§9.7) |
| Pepper versioning | `to_settings.kyc_pepper_hash` | boot refuses on mismatch without `KYC_PEPPER_ROTATION_ACK` (§9.6) |
| Frontend | `KycPanel`, `/account` | renders whatever `GET /kyc` reports; the vendor widget is loaded only when the backend names that provider |

None of this changes when the vendor is chosen.

## 2. The provider interface (what a vendor adapter must implement)

`src/types.ts`:

```ts
interface KycProvider {
  readonly name: KycProviderName;                       // add the new name to the union
  createSession(user, applicantId | null, level): Promise<{ accessToken; expiresAt; applicantId? }>;
  verifyWebhook(rawBody: Buffer, headers): KycEvent | null;   // null = signature rejected
  fetchApplicant(applicantId): Promise<ApplicantSummary>;     // the approval decision reads THIS, never the webhook body
}
```

- `createSession` must reuse the user's existing applicant (`to_users.kyc_applicant_id`) so
  retries and renewals do not create a second applicant.
- `verifyWebhook` must verify a signature over the **raw body**, require every signature
  header, and normalise the payload into `KycEvent { kind, answer, rejectType, labels,
  occurredAt, sandbox, eventKey }`. `eventKey` must be stable per delivery so redeliveries
  are idempotent.
- `fetchApplicant` must return the person fields and identity documents needed for the
  fingerprints (§9.3): `documents: [{ docType, country, number, dob }]`,
  `person: { firstName, lastName, dob, country }`, plus `answer`, `rejectType`, `labels`,
  `levelName`, `sandbox`.
- Sandbox / test-mode events must be flagged so production ignores them
  (`APP_NETWORK=mainnet` never applies a `sandbox: true` event).
- A vendor's own duplicate-applicant rejection should map to `blocked_duplicate` (see
  `SUMSUB_DUPLICATE_LABELS` for the pattern).

## 3. Providers in the repository

| Provider | File | Role |
|---|---|---|
| `mock` | `kyc-provider-mock.service.ts` + `KycMockController` | default in dev/test; `POST /kyc/mock/submit` drives the identical pipeline with synthetic events. Refused at boot in `prod` or on `mainnet`; the controller is not even registered unless `KYC_PROVIDER=mock`. |
| `sumsub` | `kyc-provider-sumsub.service.ts` | reference adapter: request signing (`X-App-Token`, `X-App-Access-Ts`, `X-App-Access-Sig`), SDK token reuse, webhook digest (`x-payload-digest` + `x-payload-digest-alg`, SHA-256/512, SHA-1 only with `SUMSUB_ALLOW_SHA1`), applicant fetch. Unit-tested against locally computed vectors; not exercised against Sumsub's servers. |

## 4. Selection is one environment variable

`KYC_PROVIDER=mock | sumsub | <new>` picks the adapter through the `KYC_PROVIDER` factory in
`app.module.ts`. The frontend needs no change for a new provider unless it has a browser
widget; `KycPanel` switches on the `provider` field returned by `GET /kyc`.

## 5. Checklist for integrating the chosen vendor (later)

1. Add `<name>` to `KycProviderName` in `src/types.ts` and a `KYC_PROVIDER=<name>` branch in
   the factory.
2. Implement `src/services/kyc-provider-<name>.service.ts` against §2; add its config block to
   `config.ts` + `.env.example` (token/secret validation, sandbox-token refusal on mainnet).
3. Add `POST /webhooks/kyc/<name>` to `WebhooksController` (raw body, store, ack, publish
   `truthoracle.kyc.webhook.<name>`).
4. Unit tests: signing, webhook verification vectors, event normalisation, `fetchApplicant`
   mapping to `ApplicantSummary` (documents + person fields present, or `needs_review`).
5. Frontend: if the vendor has a web widget, add a loader in `frontend/lib/kyc.ts` and a
   branch in `KycPanel` keyed on `provider`; the mock and Sumsub branches show the pattern.
6. Vendor dashboard: webhook URL `https://<app-host>/__backend/api/v1/webhooks/kyc/<name>`,
   webhook secret, and (if offered) the vendor's own duplicate-applicant restriction.
7. Rollout: run with `KYC_ENFORCE_WITHDRAWALS=false` first so approvals accumulate; flip it
   only after `LEGACY_WALLET_ENDPOINTS_RETIRED=true` (ARCHITECTURE §18).

## 6. Runbooks

- **Person transfer** (`POST /admin/kyc/persons/:fingerprint/transfer`): releases the binding
  from user A and binds user B; audited; the only way to move a verified person.
- **Pepper rotation**: set the new `KYC_FINGERPRINT_PEPPER`, boot with
  `KYC_PEPPER_ROTATION_ACK=<sha256 of the new pepper>`, then re-fetch applicant data for every
  bound person and recompute keys (`fingerprint_version` bumps). Without the ack the boot refuses.
- **Duplicate queue**: `GET /admin/kyc/duplicates`; user-facing copy never names the other account.
