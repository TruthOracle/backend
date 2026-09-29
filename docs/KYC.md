# KYC — provider-neutral design, with Sumsub as the production provider

**Status (2026-09-29): Sumsub is the chosen KYC vendor.** The vendor-neutral pipeline below is
built and tested against the mock provider (the default outside production) and the Sumsub
adapter implements the provider interface against Sumsub's current API: SDK tokens
(`POST /resources/accessTokens/sdk`, JSON body with `applicantIdentifiers`), app-token request
signing, webhook digests (`X-Payload-Digest` / `X-Payload-Digest-Alg`), applicant re-reads
(`GET /resources/applicants/{id}/one`) and the WebSDK in the account page. §5 is the setup
checklist; §6 the operator probe. What has **not** happened yet is a run against Sumsub's own
sandbox: the adapter is verified with locally computed vectors and a stubbed HTTP layer, so
the first sandbox session should be watched end to end (§5 step 8).

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
| `sumsub` | `kyc-provider-sumsub.service.ts` | **the production adapter**: request signing (`X-App-Token`, `X-App-Access-Ts`, `X-App-Access-Sig` = hex HMAC-SHA256 over `ts + METHOD + path + body`), SDK tokens keyed by our user id (`externalUserId`) with the account email as `applicantIdentifiers`, applicant lookup by `externalUserId`, webhook digest over the raw body (`x-payload-digest` + `x-payload-digest-alg`; SHA-256 / SHA-512, SHA-1 only with `SUMSUB_ALLOW_SHA1`), event normalisation (every `applicant*` type Sumsub documents; waiting states and partial resets keep the attempt in flight, `applicantWorkflowFailed` goes to the operator queue), applicant fetch, and the operator probe (§6). Unit-tested against locally computed vectors and a stubbed HTTP layer; the first sandbox run is still to be watched. |

## 4. Selection is one environment variable

`KYC_PROVIDER=mock | sumsub | <new>` picks the adapter through the `KYC_PROVIDER` factory in
`app.module.ts`. The frontend needs no change for a new provider unless it has a browser
widget; `KycPanel` switches on the `provider` field returned by `GET /kyc`.

## 5. Sumsub setup checklist (dashboard ↔ this backend)

1. **App token.** Sumsub dashboard → Dev space → App tokens → create a token with the *View
   applicants* permission (add *Create applicants* if levels are created through the API).
   Put the token in `SUMSUB_APP_TOKEN` and its secret in `SUMSUB_SECRET_KEY`. Sandbox tokens
   start with `sbx:`; the backend refuses one on mainnet at boot (§12 in ARCHITECTURE).
   `SUMSUB_BASE_URL` stays `https://api.sumsub.com` for sandbox and production alike.
2. **Level.** Create (or reuse) the verification level the platform requires — an identity
   document step plus a selfie / liveness step is the sensible minimum — and put its exact
   name in `KYC_REQUIRED_LEVEL` (default `basic-kyc-level`). An approval on any other level is
   ignored: `applyEvent` compares `review.levelName` with this value.
3. **Webhook.** Dashboard → Dev space → Webhooks → new webhook:
   - URL `https://<app-host>/__backend/api/v1/webhooks/kyc/sumsub` (the Vercel relay forwards
     `api/v1/**` and the two digest headers); the backend's own host works too;
   - types: at least `applicantCreated`, `applicantPending`, `applicantPrechecked`,
     `applicantReviewed`, `applicantOnHold`, `applicantReset`, `applicantWorkflowCompleted`;
     the adapter accepts every `applicant*` type and ignores the ones it does not act on;
   - **digest algorithm `HMAC_SHA256_HEX` or `HMAC_SHA512_HEX`** — Sumsub's default is SHA-1,
     which the backend rejects unless `SUMSUB_ALLOW_SHA1=true`; the secret goes in
     `SUMSUB_WEBHOOK_SECRET` (required with `KYC_PROVIDER=sumsub`, boot refusal otherwise).
4. **Duplicates.** Enable Sumsub's duplicate-applicant check on the level; its reject label
   (`DUPLICATE` by default, `SUMSUB_DUPLICATE_LABELS` to extend) maps to `blocked_duplicate`,
   on top of the backend's own fingerprint binding (§9.3).
5. **Backend env.** `KYC_PROVIDER=sumsub`, the four `SUMSUB_*` values above, `KYC_REQUIRED_LEVEL`,
   keep `KYC_ENFORCE_WITHDRAWALS=false` for the rollout (step 9). Restart: the boot refusals
   cover a missing webhook secret and a sandbox token on mainnet.
6. **Probe.** `npm run kyc:check` on the host (or `GET /admin/kyc/provider` with an operator
   session) must answer `probe OK (HTTP 404)`: the token and the request signature are
   accepted, the webhook secret is set, and the accepted digest algorithms are listed (§6).
7. **Frontend.** Nothing to configure: `KycPanel` loads the WebSDK when `GET /kyc` reports
   `provider: "sumsub"` and passes the account email to the widget. If the deployment ever
   sends a `Permissions-Policy` header, it must allow `camera` and `microphone` for
   `https://api.sumsub.com` (Sumsub's requirement for the iframe).
8. **First sandbox run.** Sign in, Account → Identity verification → Start, complete the
   sandbox flow; watch `to_kyc_webhook_events` fill (`applicantCreated`, `applicantPending`,
   `applicantReviewed`), the verification reach `approved`, `GET /me.capabilities.canWithdraw`
   flip, and `to_kyc_persons` gain one `doc` and one `person` row. Use the dashboard's
   webhook manager "resend" if a delivery was lost: redeliveries are idempotent on the body
   hash (`event_key`).
9. **Rollout.** Run with `KYC_ENFORCE_WITHDRAWALS=false` first so approvals accumulate, then
   flip it — a plain flag; money leaves only through this backend (ARCHITECTURE §18), so
   nothing has to be attested first.

### Adding another vendor later

Add its name to `KycProviderName` and the `KYC_PROVIDER` factory, implement §2 in
`kyc-provider-<name>.service.ts` (config block + boot refusals in `config.ts`), add
`POST /webhooks/kyc/<name>`, unit-test signing / webhook vectors / event normalisation /
`fetchApplicant`, and give `KycPanel` a branch if the vendor has a widget. The Sumsub adapter
is the worked example.

## 6. Operator probe

`GET /admin/kyc/provider` (admin session) and `npm run kyc:check` (shell, same code) answer
`{ provider, configured, levelName, enforceWithdrawals, webhookPath, health }`. For Sumsub the
health probe is a signed `GET /resources/applicants/-;externalUserId=health-<uuid>/one`: a
**404** means the app token and the signature were accepted (the applicant cannot exist), 401
means the token or the secret is wrong or the server clock drifts beyond Sumsub's one-minute
tolerance, 403 means the token lacks *View applicants*. `details` lists the base URL, whether
the token is a sandbox one, whether the webhook secret is set, the accepted digest algorithms
and the duplicate labels. No applicant data is read or returned.

## 7. Runbooks

- **Person transfer** (`POST /admin/kyc/persons/:fingerprint/transfer`): releases the binding
  from user A and binds user B; audited; the only way to move a verified person.
- **Pepper rotation**: set the new `KYC_FINGERPRINT_PEPPER`, boot with
  `KYC_PEPPER_ROTATION_ACK=<sha256 of the new pepper>`, then re-fetch applicant data for every
  bound person and recompute keys (`fingerprint_version` bumps). Without the ack the boot refuses.
- **Duplicate queue**: `GET /admin/kyc/duplicates`; user-facing copy never names the other account.
