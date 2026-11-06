# Smatid KYC

KYC checks for Smatid as a small Express service, laid out like `smatpay_whatsapp`
(route → controller → a helper per data source).

| Check | Endpoint | Status |
| --- | --- | --- |
| Company registration (CIPZ) | `GET /api/kyc/company/:number` | done |
| National ID extraction | | planned |
| Passport scan (Flutter SDK, MRZ) | `POST /api/kyc/passport` | done |
| Passport chip (NFC, passive authentication) | `POST /api/kyc/passport/:id/chip` | done |
| Passport extraction from a photo | | planned |
| Face match (passport photo vs liveness) | `POST /api/kyc/passport/:id/face-match` | done |
| Liveness (hosted page) | `POST /api/kyc/liveness` | done |
| Sanctions and PEPs (OpenSanctions) | `POST /api/kyc/sanctions` | done |

## Setup

```bash
npm install
cp .env.example .env   # then set DB_*, and CORS_ORIGINS for the admin site
npm run db:create
npm run db:migrate
npm run admin:create -- --email you@smatid.com --name "Your Name"   # first admin; asks for a password
npm start              # listens on PORT (8011)
npm test
npm run models:download   # the face match model (38 MB), once per install
```

## Clients and access tokens

Every `/api/kyc` call needs a client access token: `Authorization: Bearer kyc_...`. Without one, or with
a revoked one, the answer is `401`. Admins manage clients through `/api/admin`, usually from the admin
site (`smatid_kyc_web`). Scripts can send `ADMIN_API_KEY` as the `X-Admin-Key` header instead; if
`ADMIN_API_KEY` isn't set, that header gets a `503`.

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

## Admin API

The admin site signs in with `POST /api/admin/login` (`{email, password}`) and gets back a session token
(`adm_...`), which it sends as `Authorization: Bearer`. Sessions last `ADMIN_SESSION_HOURS` (12 by default).
Passwords are stored as scrypt hashes, and session tokens as SHA-256 only. After 10 failed sign-ins from one
IP in 15 minutes, sign-in answers `429` for the rest of that window.

| Endpoint | What it does |
| --- | --- |
| `POST /api/admin/login`, `POST /api/admin/logout`, `GET /api/admin/me` | Sign in, sign out, who am I |
| `GET /api/admin/clients`, `POST /api/admin/clients` | List clients (with request counts), create one |
| `GET /api/admin/clients/:id`, `PATCH /api/admin/clients/:id`, `POST /api/admin/clients/:id/revoke` | One client, change its default `webhook_url`, revoke its token |
| `GET /api/admin/modules`, `POST /api/admin/modules`, `PATCH /api/admin/modules/:id` | List, create and edit modules (`name`, `description`, `status`) |
| `GET /api/admin/requests` | The request log, newest first. Filters: `client_id`, `check_type`, `outcome` (`ok` or `error`), `from` and `to` (`YYYY-MM-DD`, UTC), `q` (searches what was sent), `page`, `per_page` (up to 100) |
| `GET /api/admin/requests/:id` | One request with its full request and response |
| `GET /api/admin/stats` | Totals, per check, per day and top 10 clients. Same filters; the last 30 days by default |

`npm run admin:create` adds an admin, or sets a new password for an existing one and signs them out
everywhere. The admin site is on its own origin, so put its address in `CORS_ORIGINS`.

## Modules

Each check is a module in the `modules` table, which an admin can switch `enabled` or `disabled`. While a
module is disabled, or missing from the table, its endpoint answers every client with
`403 {"error": "module_disabled", "module": "<key>"}`. Those calls still go in the request log.

| Module key | Endpoint |
| --- | --- |
| `companies-check` | `GET /api/kyc/company/:number` |
| `sanctions-check` | `POST /api/kyc/sanctions` |
| `liveness-check` | `POST /api/kyc/liveness`, `GET /api/kyc/liveness/:id` and the hosted page |
| `passport-check` | `POST /api/kyc/passport`, `GET /api/kyc/passport/:id` (2 credits) |
| `passport-chip` | `POST /api/kyc/passport/:id/chip`, `GET /api/kyc/passport/:id/chip/photo` (2 credits) |
| `face-match` | `POST /api/kyc/passport/:id/face-match` (1 credit) |

The migration creates both as enabled. An admin can create more, e.g. `liveness-check`, ahead of the code:
the list shows `connected: false` until an endpoint checks that key with
`modules.requireModule('liveness-check')` in `routes/kycRoutes.js`. A module's key can't be changed after it's
created, because the code refers to it.

## Liveness

A hosted page on this service checks that a real person is in front of the camera. It's built here, with
no outside provider, so it costs nothing per check, but it's proof-of-concept strength: it stops printed
photos, still pictures and a photo held up to the camera, not a skilled attacker with prepared video.

```bash
# 1. Open a session for the person. Both fields are optional.
curl -X POST localhost:8011/api/kyc/liveness -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"reference": "cust-42", "redirect_url": "https://acme.co.zw/kyc/done"}'
# → 201 {"session_id": "lv_...", "url": "https://dev-api.smatid.com/liveness/lv_...", "status": "pending", ...}

# 2. Send the person to `url` (link, SMS, QR code). On a phone is best.
# 3. They come back to redirect_url?session_id=lv_...&status=passed|failed|expired. Then get the result:
curl localhost:8011/api/kyc/liveness/lv_... -H "Authorization: Bearer $TOKEN"
```

Don't trust the `status` in the redirect: anyone can type it. Always get the result from the API.

### Getting the result back

| Way | How | Use it for |
| --- | --- | --- |
| **Webhook** | Set a default with `PUT /api/kyc/webhook` (or an admin sets it on the client's page), or give `webhook_url` when opening a session, which wins. When the session ends (`passed`, `failed` or `expired`), the result is POSTed there, signed. | Your server learning the result without waiting or asking |
| **Ask** | `GET /api/kyc/liveness/:session_id` | The source of truth, any time |
| **Redirect** | `redirect_url` gets `?session_id=…&status=…` added. It can be a website (https) or a mobile app link such as `acmebank://kyc/done`, which reopens your app. | Taking the person back to where they came from |
| **Popup** | If your site opened the page with `window.open`, it gets `postMessage({type: 'smatid.liveness', session_id, status})`. | Desktop web flows |
| **Picture** | `GET /api/kyc/liveness/:session_id/image`: the straight-on frame (JPEG) from the latest try. | Comparing with an ID document's photo |

The redirect, popup message and webhook all tell you *that* it finished. Read the result from the API
(or from a webhook whose signature checks out) before acting on it.

**Webhooks.** The body is `{"id": "evt_…", "event": "liveness.completed", "created_at": "…", "data": {…}}`,
where `data` is the same as `GET /api/kyc/liveness/:session_id`. Any 2xx reply counts as received.
Otherwise it's sent again after 30 seconds, 5 minutes and 30 minutes; redirects aren't followed. Its
progress shows in the session's `webhook` field. Webhook URLs must be public https: addresses on this
machine or private networks are refused, including when the name only resolves to one at sending time.
For local testing, `WEBHOOK_ALLOW_PRIVATE=true` allows `http://localhost`.

Setting the default webhook (it applies to sessions opened from then on; each session keeps the URL it started with):

```bash
curl -X PUT localhost:8011/api/kyc/webhook -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"webhook_url": "https://acme.co.zw/hooks/smatid"}'      # null or "" removes it
curl localhost:8011/api/kyc/webhook -H "Authorization: Bearer $TOKEN"
```

Admins: `PATCH /api/admin/clients/:id` with `{"webhook_url": ...}`, or the Webhook box on the client's page.

Each webhook carries `Smatid-Signature: t=<unix time>,v1=<hex>`, an HMAC-SHA256 of `<t>.<raw body>` with
the client's signing secret. Get it, or replace it, with your token:

```bash
curl localhost:8011/api/kyc/webhook-secret -H "Authorization: Bearer $TOKEN"              # {"webhook_secret": "whsec_..."}
curl -X POST localhost:8011/api/kyc/webhook-secret/rotate -H "Authorization: Bearer $TOKEN"
```

Checking it, in Node (use the raw body, before any JSON parsing):

```js
const crypto = require('crypto');
function isFromSmatid(rawBody, header, secret) {
    const {t, v1} = Object.fromEntries(header.split(',').map((p) => p.split('=')));
    if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // older than 5 minutes
    const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
    return v1.length === expected.length && crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}
```

### The page on different devices

- **Computer:** shows a QR code to carry on with a phone, and keeps following the session, so it shows the
  result (and redirects) when the phone finishes. The computer's own camera can still be used.
- **In-app browsers** (Facebook, Instagram, LinkedIn, TikTok and similar), which often can't use the
  camera: asks to open the link in the phone's browser, with a copy-link button and, on Android, a link
  straight into Chrome.
- **Camera blocked:** step-by-step help for iPhone Safari, Android Chrome, Samsung Internet, desktop Chrome
  and Edge, Firefox and Safari. Camera access is asked for before a try starts, so a blocked camera doesn't
  use one up.
- **During the check:** says when it's too dark or too bright, when the face is off-centre, too close or too
  far, or when the phone is on its side, and gives a tip if a step takes a while. It keeps the screen on,
  vibrates as each step is done, and pauses if the person switches apps, then carries on at the same step.
- **Older devices:** falls back from WebGL to WebAssembly, and from the front camera to any camera.

| `status` | Meaning |
| --- | --- |
| `pending` | Not taken yet, or a try failed and they can try again (`attempts` says how many so far) |
| `started` | On the camera screen now |
| `passed` | A live person was confirmed |
| `failed` | Every try (`LIVENESS_MAX_ATTEMPTS`, 3) failed; `failure_reason` says why the last one did |
| `expired` | Not finished within `LIVENESS_SESSION_MINUTES` (30) |

**How it works.** The page only renders for a real session, from a client that's still active, while the
`liveness-check` module is on. The session ID in the link is the key, so the client's own token never goes
near the person. When they press Start, the server picks the steps: look straight ahead, then turn left,
turn right and open your mouth, in a random order. The page shows the live camera, tracks the face in the
browser (Human, on WebGL), and takes one picture when each step is held. The server then runs the face
models again on those pictures (Human on WebAssembly, in `helpers/liveness/`) and decides:

- one face per picture, close enough, and each step actually done, in the asked-for order;
- the same person in every picture (face descriptors);
- the anti-spoof model's average score is high enough;
- no two pictures identical, and a believable time taken.

The page's own result isn't trusted. Limits are in `livenessHelper.thresholds()` and can be set through
`LIVENESS_*` settings; they're starting points, to be tuned with real people and phones. Pictures are kept
in `storage/liveness/<session>/` and admins can see them next to each liveness call in Usage. They're
biometric data: decide how long to keep them.

Expired sessions are marked every 30 seconds, which also sends their webhook.

The face models need about 300 MB of memory once loaded, the first time a check is taken after a restart.

## Passport scan

The Smatid Flutter SDK (`smatid_kyc_flutter`) reads a passport's photo page with the phone camera. It reads
the MRZ (the two lines of `<<<` text at the bottom) on the phone, and once two reads in a row agree and
every check digit matches, it takes a picture and sends both here with the client's token:

```bash
curl -X POST localhost:8011/api/kyc/passport -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
  "mrz": ["P<ZWEMOYO<<TARIRO<GRACE<<<<<<<<<<<<<<<<<<<<<", "FN12345672ZWE9003129F3101012<<<<<<<<<<<<<<<0"],
  "image": "<base64 JPEG of the photo page>",
  "reference": "cust-42"
}'
```

`mrz` can be the two lines, or all the text read off the page (as a list of lines or one string); the
server finds the two lines in it. `reference` is optional; `device` (SDK version, platform, time taken)
is filled in by the SDK. The picture can be up to `PASSPORT_MAX_IMAGE_KB` (2048) and must be a JPEG.

| Status | Body |
| --- | --- |
| 201 | The scan: `{scan_id, reference, status, passed, failure_reason, document, checks, mrz, has_image, created_at}` |
| 422 | `{error: "mrz_unreadable", problems: [...], mrz}`: the MRZ wasn't found, or a check digit didn't match. Scan again. Not charged |
| 400 | `mrz_required`, `invalid_image`, `invalid_reference`. Not charged |

```json
{
  "scan_id": "ps_…", "reference": "cust-42", "status": "passed", "passed": true, "failure_reason": null,
  "document": {
    "document_type": "P", "issuing_country": "ZWE", "surname": "MOYO", "given_names": "TARIRO GRACE",
    "name_truncated": false, "document_number": "FN1234567", "nationality": "ZWE",
    "birth_date": "1990-03-12", "birth_date_partial": false, "sex": "F", "expiry_date": "2031-01-01", "expired": false, "personal_number": null
  },
  "checks": {"document_number": true, "birth_date": true, "expiry_date": true, "personal_number": true, "composite": true},
  "mrz": ["P<ZWEMOYO<<TARIRO<GRACE<<<<<<<<<<<<<<<<<<<<<", "FN12345672ZWE9003129F3101012<<<<<<<<<<<<<<<0"],
  "has_image": true, "created_at": "…"
}
```

- `status` is `passed` when the MRZ reads cleanly and the passport is in date, and `failed` with
  `failure_reason: "document_expired"` when it has expired. A failed scan was still read, so it's charged.
- **What the server checks.** `helpers/passport/mrzHelper.js` parses the lines itself (it doesn't trust the
  phone's parse), fixes the usual OCR mix-ups (`O`/`0`, `I`/`1`, `S`/`5`, `B`/`8`, …) only where the
  character type is fixed, and requires every ICAO 9303 check digit to match. Check digits catch misreads,
  not forgeries: anyone can compute them. The server doesn't read the picture yet, so it can't yet tell
  whether the MRZ sent matches the photo page. That's the next phase (reading details from the photo).
- Birth years in the future are taken as last century (`300101` → 1930). Names that fill the whole field
  are flagged `name_truncated`.
- **Unknown birth dates.** Some passports don't give the whole date of birth: ICAO 9303 fills the unknown
  day, month or year with `<`, and some countries use `X`. These are accepted, with `birth_date` as far as
  it's known (`1990-03`, `1990`, or `null` when even the year isn't) and `birth_date_partial: true`. The
  check digit still has to match. Those forms are the ones `POST /api/kyc/sanctions` takes, so the date can
  be passed straight on. Expiry dates must always be complete.
- Get a scan again with `GET /api/kyc/passport/:scan_id`, and its picture with
  `GET /api/kyc/passport/:scan_id/image`. Only the client that made it can.
- Pictures are kept in `storage/passport/<scan>.jpg` (or `PASSPORT_STORAGE_DIR`). Admins can see a scan
  with `GET /api/admin/passport/:scan_id` and its picture at `…/image`; usage rows link to it
  (`passport_scan_id`). The picture is never written to the request log, only its size.
- The token is in the app, so anyone with the app can extract it. Give each app its own client and
  token, so a leaked one can be revoked without breaking anything else.

## Passport chip

Most passports issued since about 2006 (Zimbabwe's since late 2021) have a chip holding the MRZ details
(DG1), the holder's photo (DG2), and EF.SOD: a hash of each of those, signed by the issuing country. The
SDK reads the chip over NFC after the photo page scan (the MRZ is the key that opens it) and sends the raw
files here, for that scan:

```bash
curl -X POST localhost:8011/api/kyc/passport/ps_.../chip -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
  "files": {"sod": "<base64>", "dg1": "<base64>", "dg2": "<base64>", "dg14": "<base64, if the chip has it>"},
  "access": "pace"
}'
```

The reply is the scan, with `chip`:

```json
"chip": {
  "status": "verified", "verified": true,
  "checks": {"data_intact": true, "signature_valid": true, "issuer_trusted": true, "matches_scan": true, "signer_certificate_current": true},
  "problems": [], "differences": [],
  "document": {"surname": "MOYO", "given_names": "TARIRO GRACE", "document_number": "FN1234567", "…": "…"},
  "signer": {"country": "ZW", "subject": "…", "serial": "…", "valid_from": "…", "valid_to": "…"},
  "csca": {"country": "ZW", "subject": "…"},
  "signature_algorithm": "ecdsa-sha256", "data_groups": {"dg1": true, "dg2": true, "hash_algorithm": "sha256", "listed": [1, 2, 14]},
  "photo": {"format": "jpeg", "original_format": "jp2", "width": 480, "height": 640, "bytes": 44402}, "has_photo": true,
  "clone_check": "not_done", "access": "pace", "read_at": "…"
}
```

What `helpers/passport/chipHelper.js` checks (ICAO 9303 part 11, "passive authentication"):

1. **`data_intact`**: every file sent is listed in EF.SOD and hashes to its entry, and EF.SOD's own digest holds.
2. **`signature_valid`**: the Document Signer's signature over that list (RSA, RSA-PSS, ECDSA, and BSI "plain"
   ECDSA on NIST or brainpool curves).
3. **`issuer_trusted`**: the Document Signer's certificate was issued by a CSCA in `config/csca/` (see the
   README there). `null` when there's no CSCA for that country at all.
4. **`matches_scan`**: the chip's document number, birth date and expiry date are the scan's (`differences`
   lists any that aren't). The chip only opens with a key made from those three, so they can't differ on the
   same passport. Names, nationality and sex have no check digit on the photo page and the camera can misread
   them (a `<` read as `K` after a name happened on a real Zimbabwean passport); those differences are listed in
   `scan_corrections` (`{field, scan, chip}`) and don't fail the check. Use the chip's `document` for them.

| `status` | Meaning |
| --- | --- |
| `verified` | All four hold: the data is what the issuing country signed, and it's this passport |
| `unverified` | Intact and signed, but there's no CSCA for that country, so who signed it is unknown |
| `failed` | Something didn't hold; `problems` says what (`dg1_hash_mismatch`, `signature_invalid`, `signer_not_issued_by_csca`, `chip_differs_from_scan`, …) |

- A chip check that ran is charged, whatever it found. Missing or broken files are a `400` or a `422
  chip_data_invalid` and aren't charged.
- **Not checked yet: copies.** A cloned chip carries a valid signature too. Chip authentication (DG14) and
  active authentication (DG15) catch that; `clone_check` stays `not_done` until they're added.
- The raw files are kept in `storage/passport/<scan>/chip-*.bin`, so a scan can be checked again (e.g. after
  adding a country's CSCA).
- **The face picture is always served as JPEG** (`chip-photo.jpg`). Many chips, Zimbabwe's included, store it
  as JPEG 2000, which browsers and Flutter can't show. `helpers/passport/photoHelper.js` decodes it with
  OpenJPEG (`@cornerstonejs/codec-openjpeg`, WebAssembly) and re-encodes it with jpeg-js, in about 100 ms. The
  original is kept as `chip-photo-original.jp2`. If one can't be decoded, `photo.conversion_error` says why,
  and the original is what's served.
- `GET /api/admin/csca` lists the certificates loaded, by country; `POST /api/admin/csca` reloads
  `config/csca/` after adding files.

## Face match

Is the person who took a liveness check the passport's holder? After a passport scan (ideally with its
chip read) and a liveness check the person passed:

```bash
curl -X POST localhost:8011/api/kyc/passport/ps_.../face-match -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"liveness_session_id": "lv_..."}'
```

The reply is the scan, with `face_match`:

```json
"face_match": {
  "status": "match", "matched": true, "similarity": 0.62, "thresholds": {"match": 0.4, "review": 0.25},
  "model": "sface-2021dec", "passport_photo": "chip", "chip_verified": true,
  "liveness_session_id": "lv_…", "liveness_passed": true, "identity_verified": true, "checked_at": "…"
}
```

- **`status`**: `match`, `review` (for a person to look at both pictures), or `no_match`.
- **`identity_verified`**: the whole chain held. The chip was verified (signed by the issuing country), the
  liveness check passed, and the faces match.
- **Which passport photo**: the chip's (`passport_photo: "chip"`) when it was read, since it's signed and
  clean. Otherwise the photo page scan, where the printed photo is small and often has glare, so a face
  isn't always found there (`422 no_face_in_passport`).
- The liveness check has to be this client's and `passed` (`409 liveness_not_passed` otherwise). Its
  straight-on frame from the passing try is the one compared.
- **How it compares**: Human (the liveness face models) finds each face and its eyes, nose and mouth
  corners. The face is aligned onto a 112×112 template, and **SFace** (OpenCV model zoo, Apache 2.0, 99.4%
  on LFW) turns it into a descriptor. `similarity` is the cosine of the two descriptors.
- **The bars**, `FACE_MATCH_MIN_MATCH` (0.4) and `FACE_MATCH_MIN_REVIEW` (0.25), were set on 2026-11-06 from
  one person's chip photo and 7 liveness checks (0.31–0.78 against each other, median 0.62) against 8 other
  people (at most 0.18). OpenCV's own bar for SFace is 0.363. Tune them as real checks come in.
- Errors that mean no comparison was made (`400`, `404`, `409`, `422`) aren't charged.

## Verification sessions (the Smatid Verify app)

A client's app doesn't run the checks itself: it opens a **verification session** with its token, sends
the person to the **Smatid Verify** app, and reads the result. Smatid Verify holds no token; the session
is its key, and the session says what to check.

```bash
# 1. The client opens a session. type: liveness | passport | passport_chip | full
curl -X POST localhost:8011/api/kyc/verifications -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type": "full", "reference": "cust-42", "return_url": "acmewallet://kyc/done"}'
# → 201 {"verification_id": "vs_…", "code": "K7QM-4P2X", "app_link": "smatid-verify://verify?id=vs_…", "status": "pending", …}

# 2. The client app opens app_link (or shows the code to type into Smatid Verify).
# 3. The person does the checks. Smatid Verify sends them back to return_url?verification_id=…&status=completed.
# 4. The client reads the result:
curl localhost:8011/api/kyc/verifications/vs_… -H "Authorization: Bearer $TOKEN"
```

| `type` | Steps, in order |
| --- | --- |
| `liveness` | liveness |
| `passport` | passport (photo page) |
| `passport_chip` | passport, chip |
| `full` | passport, chip, liveness, face_match |

The result has `status` (`pending`, `in_progress`, `completed`, `cancelled`, `expired`), each step
(`passed`, `review`, `failed`, `skipped`, `not_done`), and, once completed, `outcome`:

- `verified`: every step passed;
- `review`: none failed, but one needs a person (a face match `review`, a chip that's `unverified`) or the chip
  was skipped (no NFC on the phone, or no chip in the passport);
- `failed`: a step failed;
- `incomplete`: the app finished without doing every step.

`passport` and `liveness` hold the checks' full results, as `GET /api/kyc/passport/:id` and
`GET /api/kyc/liveness/:id` give them. If the client has a default webhook, `verification.completed` is
sent there once (signed as usual); otherwise, or as well, read the result with the GET above.

**The app's side** (`/api/verify/...`, no token): `POST /api/verify/claim {code}` turns a typed code into the
session's ID (20 tries per IP per 15 minutes). `GET /api/verify/:id` says who's asking and what to do, and
marks the session in progress. The checks go through `/api/verify/:id/passport`, `…/passport/:scan/chip`,
`…/liveness` and `…/passport/:scan/face-match`, the same as their `/api/kyc` versions, and are logged and
charged to the client. Only the session type's steps are allowed, only on the session's own scan and
liveness check, and only while it's open. The session sets the `reference`; the app can't set a webhook.
`POST …/complete {skipped: {chip: "no_nfc"}}` closes it, and `POST …/cancel` cancels it. Sessions last
`VERIFICATION_SESSION_MINUTES` (30).

## Payment settings

The SmatPay merchant that receives credit top-ups is set by an admin in the admin site (**Settings**), not
in `.env`: sandbox or production, the API address, merchant ID, merchant account ID, payment profile
number, and the sandbox and production keys.

- Saved in the `settings` table. Keys are encrypted with AES-256-GCM using `SETTINGS_ENCRYPTION_KEY`
  (32 bytes, base64) from `.env`; without it, keys can't be saved. Never change that key once keys are
  saved, or they can't be read.
- Keys are never sent back: the admin site only sees whether each is set and its last 4 characters.
  Leaving a key blank keeps it; **Remove saved key** clears it.
- **Check connection** signs in to SmatPay with the details (saved or still in the form), shows the
  merchant's name and approval, and lists its payment profiles to pick from.
- Anything not saved falls back to the `SMATPAY_*` settings in `.env`, marked *from .env* in the admin site.

| Endpoint | Does |
| --- | --- |
| `GET /api/admin/settings/payments` | The settings, with keys shown only as set or not |
| `PUT /api/admin/settings/payments` | Save: a value sets it, `null` clears it; a key left out or `""` is kept |
| `POST /api/admin/settings/payments/test` | Check the connection, with optional unsaved values |

## Request log

Every authenticated `/api/kyc` call is saved in `api_requests`: who called (`client_id`), which check
(`check_type`: `company` or `sanctions`), the `method` and `path`, what was searched for (`request`: route
params, query string and body), the HTTP `status` and full `response`, `duration_ms`, the caller's `ip`,
and the time (`created_at`). Calls rejected for a missing or bad token aren't logged, since there's no client.

The row is written after the reply has gone out. If the write fails, it's logged to the console and the
client's reply is unaffected. Deleting a client deletes its log rows too.

The log holds personal data from searches (names, ID and passport numbers, dates of birth), so treat the
table like the rest of your KYC records.

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
