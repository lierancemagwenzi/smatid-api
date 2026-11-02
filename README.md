# smatpay_kyc

KYC checks for SmatPay as a small Express service, laid out like `smatpay_whatsapp`
(route → controller → a helper per data source).

| Check | Endpoint | Status |
| --- | --- | --- |
| Company registration (CIPZ) | `GET /api/kyc/company/:number` | done |
| National ID extraction | | planned |
| Passport extraction | | planned |
| Photo identification | | planned |
| Liveness | | planned |
| Sanctions and PEPs (OpenSanctions) | `POST /api/kyc/sanctions` | done |

## Setup

```bash
npm install
cp .env.example .env   # then set DB_* and ADMIN_API_KEY
npm run db:create
npm run db:migrate
npm start              # listens on PORT (8011)
npm test
```

## Clients and access tokens

Every `/api/kyc` call needs a client access token: `Authorization: Bearer kyc_...`. Without one, or with
a revoked one, the answer is `401`. An admin creates clients through `/api/admin`, sending
`ADMIN_API_KEY` as the `X-Admin-Key` header. If `ADMIN_API_KEY` isn't set, the admin API answers `503`.

```bash
# Create a client. The access_token in the reply is shown this once and never again.
curl -X POST localhost:8011/api/admin/clients -H "X-Admin-Key: $ADMIN_API_KEY" \
  -H 'Content-Type: application/json' -d '{"name": "Acme Bank", "email": "it@acme.co.zw"}'

curl localhost:8011/api/admin/clients -H "X-Admin-Key: $ADMIN_API_KEY"                    # list
curl -X POST localhost:8011/api/admin/clients/1/revoke -H "X-Admin-Key: $ADMIN_API_KEY"    # revoke
```

- **The token is emailed to the client** through SendGrid (`SENDGRID_API_KEY`, `MAIL_FROM_EMAIL`), so
  `email` is required. If the email fails, the client is still created and the reply says
  `"email_sent": false`. The admin then has the token in that reply to pass on another way.
- **Only the token's SHA-256 is stored**, in `clients.token_hash`. A lost token can't be recovered:
  revoke that client and create a new one.
- **`token_prefix`** (e.g. `kyc_aA9gK91Y`) is the token's first 12 characters, so you can tell which
  client a token belongs to without having the secret.
- **`last_used_at`** is updated on every authenticated call.

## Company registration

```bash
curl localhost:8011/api/kyc/company/38043A0242025 -H "Authorization: Bearer $TOKEN"
```

| Status | Body |
| --- | --- |
| 200 | `{found: true, name, number, address, status, verified, source, checked_at}` |
| 404 | `{found: false, number}`: CIPZ has no company with that number |
| 400 | `{error: "invalid_registration_number"}` |
| 502 | `{error: "registry_unavailable" \| "registry_mismatch"}`: CIPZ is down, timed out, changed its page, or answered for a different number |

CIPZ has no API. `helpers/cipz/cipzHelper.js` reads its public "check a company" page
(`/Info/Checkacompany?=<number>`). A few things to know about that page:

- The name's suffix shows up on the number line (`Number: 38043A0242025 (PRIVATE) LIMITED`), and the
  helper moves it back onto the name.
- An unknown number gets a "Something went wrong" page, still with HTTP 200.
- `verified` is true only when the status line reads exactly `Verified`.

If CIPZ changes its layout, the parser throws instead of guessing, and the endpoint answers 502.
The tests in `test/cipz.test.js` run against copies of the real pages saved in `test/fixtures/`.

## Sanctions and PEP screening

`helpers/sanctions/yenteHelper.js` sends the person or company to the `/match` endpoint of
[yente](https://www.opensanctions.org/docs/on-premise/), the OpenSanctions matching API. Point
`YENTE_URL` at either of these:

- **Self-hosted:** run `docker/yente/docker-compose.yml` and use `http://localhost:8000`. No API key.
  Commercial use needs an OpenSanctions bulk data licence and its delivery token.
- **Hosted:** use `https://api.opensanctions.org` and put your key in `YENTE_API_KEY`.

```bash
curl -X POST localhost:8011/api/kyc/sanctions -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
  "type": "person", "first_name": "John", "last_name": "Doe",
  "birth_date": "1980-03-12", "nationality": "zw", "id_number": "63-123456X42"
}'

curl -X POST localhost:8011/api/kyc/sanctions -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
  "type": "company", "name": "EXPRESS SMATPAY (PRIVATE) LIMITED",
  "registration_number": "38043A0242025", "country": "zw"
}'
```

| Field | Applies to |
| --- | --- |
| `type` (`person` or `company`) | both, required |
| `name`, `aliases`, `country` | both |
| `first_name`, `middle_name`, `last_name` | person (give `name`, or both first and last name) |
| `birth_date` (`YYYY`, `YYYY-MM` or `YYYY-MM-DD`), `nationality`, `id_number`, `passport_number` | person |
| `registration_number`, `jurisdiction` | company |

A birth date and a nationality make a big difference to false positives, so send them when you have them.

```json
{
  "hit": true, "sanctioned": true, "pep": false,
  "matches": [{"id": "...", "name": "...", "score": 0.93, "match": true, "topics": ["sanction"],
               "sanctioned": true, "pep": false, "datasets": ["us_ofac_sdn"], "url": "https://www.opensanctions.org/entities/.../"}],
  "near_matches": [],
  "dataset": "default", "threshold": 0.7, "source": "OpenSanctions", "checked_at": "..."
}
```

- `hit`: at least one candidate scored at or above `YENTE_THRESHOLD`.
- `sanctioned` / `pep`: a hit carries the `sanction` or `role.pep*` topic. `sanction.linked`
  (a relative or associate of a sanctioned party) doesn't count as sanctioned, but it stays in `topics`.
- `near_matches`: candidates that scored below the threshold. A person may want to look at them,
  but they aren't hits.
- A score measures how sure yente is that this is the same person or company. It is not a risk score.
- A 502 `screening_unavailable` means yente is down, or is still building its index after its first start.
