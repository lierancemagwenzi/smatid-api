# To do

## Passport chip: clone detection

**Why.** Passive authentication (what `helpers/passport/chipHelper.js` does now) proves the chip's data is
what the issuing country signed. It doesn't prove the chip is the original: anyone who reads a passport
can copy its files, EF.SOD included, onto a blank chip, and the copy passes. Every chip result says
`clone_check: "not_done"` until this is built.

A genuine chip holds a private key that can't be read out. Clone detection asks the chip to prove it has
that key. The matching public key is in a data group whose hash is in EF.SOD, so passive authentication
already vouches for it. ICAO 9303 part 11 has two ways of doing this, and a passport supports one, both, or
neither:

| | Active Authentication (AA) | Chip Authentication (CA) |
| --- | --- | --- |
| Public key in | DG15 | DG14 (`ChipAuthenticationPublicKeyInfo`, plus `ChipAuthenticationInfo` with the protocol OID) |
| How it works | We send an 8-byte challenge (INTERNAL AUTHENTICATE); the chip signs it | Key agreement (DH/ECDH) with the chip's static key; the session's secure messaging is re-keyed with the result |
| Proof | A signature we can check anywhere, including on the server | Implicit: if the chip didn't have the private key, nothing after it decrypts |
| Server can check it alone? | **Yes**, if the server picks the challenge | **No**, unless the server does the key agreement itself (see below) |
| Lee's Zimbabwean passport | No DG15 | **Has DG14** (SOD lists DG 1, 2, 3, 11, 13, 14) |

Zimbabwe uses CA, so AA alone doesn't cover the passports we see most.

### Result shape (both methods)

Replace `clone_check: "not_done"` with:

```json
"clone_check": {
  "status": "passed | failed | not_supported | not_done",
  "method": "active_authentication | chip_authentication",
  "checked_by": "server | device",
  "detail": "…"
}
```

- `not_supported`: the chip has neither DG14 nor DG15 (older passports).
- `checked_by: "device"` means the app says it worked and the server couldn't confirm it. The API key is in
  the app, so a modified app could lie. Treat `device` as weaker than `server`, and say so in the docs.
- `status: "verified"` for the whole chip should stay as it is. Add a separate top-level `genuine_chip`
  flag (`verified` **and** clone check `passed` by the server), so clients can choose how strict to be.

### 1. Active Authentication, checked on the server

For passports with DG15. This is the smaller job, and it's fully server-verifiable.

- [ ] **Challenge endpoint.** `POST /api/kyc/passport/:scanId/chip/challenge` → `{challenge: <8 random bytes, hex>, expires_at}`.
      Store it on the scan (`chip_challenge`, `chip_challenge_expires_at`), single use, valid ~2 minutes.
      Without a server-chosen challenge, a recorded answer from the real chip could be replayed.
- [ ] **SDK: fetch the challenge before the NFC read**, and pass it to the chip.
  - iOS: NFCPassportReader already supports this: `readPassport(mrzKey:tags:aaChallenge:)` with `.DG15` in
    `tags`. Return `passport.activeAuthenticationSignature` (raw bytes) with the files. **Catch AA errors
    separately**: the library runs AA by itself whenever DG15 is read, and an AA failure currently fails
    the whole read (`doActiveAuthenticationIfNeccessary` in `PassportReader.swift` throws). Either wrap it, or
    read DG15 and do INTERNAL AUTHENTICATE ourselves.
  - Android: JMRTD `service.doAA(publicKey, digestAlgorithm, signatureAlgorithm, challenge)` returns an
    `AAResult` (`getResponse()`), or send INTERNAL AUTHENTICATE with `sendInternalAuthenticate`. Do it after
    reading DG15, inside the same session.
  - Add `aa_signature` (base64) to `POST …/chip`.
- [ ] **Server: check the signature** in `chipHelper.js`:
  - Parse DG15 (tag `6F`): a `SubjectPublicKeyInfo`. DG15's hash must be in EF.SOD and match (already done for any DG sent).
  - **RSA** (most AA passports): ISO/IEC 9796-2 signature scheme 1 with message recovery. `crypto.publicDecrypt`
    with `RSA_NO_PADDING`. Then check the header nibble `6` / `0x6A`, and the trailer `0xBC` (SHA-1) or
    `<hash id> 0xCC` (e.g. `0x34CC` SHA-256, `0x36CC` SHA-384, `0x35CC` SHA-512). Take M1 (the recovered
    part) and the hash D, and check that `H(M1 ‖ challenge) == D`.
  - **ECDSA**: plain (r ‖ s) signature over the challenge. The hash comes from DG14's
    `ActiveAuthenticationInfo` (`signatureAlgorithm` OID) if present, else from the key size. `crypto.verify(…, {dsaEncoding: 'ieee-p1363'})`.
  - Mark the challenge used whatever the outcome.
- [ ] **Tests:** generate an RSA and an EC AA key in the test, build DG15 and sign challenges the way a chip does
      (9796-2 for RSA), and cover a good signature, a wrong challenge, a replayed challenge, an expired challenge,
      and a DG15 not in EF.SOD.

### 2. Chip Authentication on the phone (`checked_by: "device"`)

A quick win for Zimbabwe and other CA-only passports, at "the app says so" strength.

- [ ] iOS: `skipCA: false` in `SmatidKycPlugin.swift`. NFCPassportReader then does CA after reading DG14, and
      falls back to BAC if it fails. Report `passport.chipAuthenticationStatus` (`success` / `failed` / `notDone`).
      Note that CA re-keys the session, and the library re-does BAC if CA fails, so check the files still read cleanly afterwards.
- [ ] Android: after reading DG14, parse it with JMRTD (`DG14File`), take the `ChipAuthenticationPublicKeyInfo`
      and `ChipAuthenticationInfo`, and call `service.doEACCA(keyId, oid, publicKeyOID, publicKey)`. Read the
      remaining files (DG2 at least) **after** CA, so a clone fails visibly instead of after the data is in.
- [ ] Send `ca: "success" | "failed" | "not_supported"`; the server records it as `checked_by: "device"`.
- [ ] Test on Lee's passport: it should report `success`.

### 3. Chip Authentication through the server (`checked_by: "server"`)

The strong version. The server does the terminal's side of CA, and the phone only passes messages between
the server and the chip.

- [ ] **Flow:**
  1. After PACE/BAC, the phone reads DG14 and EF.SOD and sends them to `POST …/chip/ca/start`.
  2. The server checks DG14 against EF.SOD and makes an ephemeral key pair on the chip's domain parameters.
  3. The server returns the APDUs to send: MSE:Set AT (for AES) or MSE:Set KAT (for 3DES), and
     GENERAL AUTHENTICATE with its ephemeral public key. These are wrapped in the **current** secure
     messaging, so the server needs the PACE/BAC session keys. See the problem below.
  4. The phone sends them and returns the chip's responses.
  5. The server derives the new session keys (KDF from ICAO 9303 part 11 §9.7) and builds a SELECT + READ
     BINARY of a few bytes of DG1 under the **new** keys.
  6. The phone relays it. The server checks the MAC and decrypts the reply. If the chip had no private key,
     the MAC fails.
- [ ] **The problem to solve first:** steps 3–6 need the secure-messaging keys from PACE/BAC, which are made
      on the phone. Options:
  - (a) The phone sends its session keys to the server. That's simple, and the keys are only good for this one
        NFC session, but it gives a modified app the same power it already has.
  - (b) The server also does PACE/BAC through the relay, so it holds every key itself. This is the most
        robust option, but needs more round-trips.
  - Either way the server needs ISO 7816 secure messaging (3DES-CBC + retail MAC for BAC and older CA;
    AES-CBC + CMAC for PACE and CA-AES). JMRTD's `SecureMessagingWrapper` / NFCPassportReader's
    `SecureMessaging.swift` are the references.
- [ ] **Time budget:** iOS ends an NFC session after about 20 s, and every relay step is a network round-trip
      (phone ↔ server, about 100–300 ms) plus the NFC exchange. CA is about 3–4 relayed APDUs, so it fits, but
      DG2 (the slow part) should be read *before* CA starts. Reconnects need care: after a reconnect the
      session keys are gone, and CA must restart.
- [ ] **Tests:** a simulated chip in Node (static ECDH key, our own SM implementation), tested against JMRTD or
      NFCPassportReader-recorded APDU traces if we can capture one from Lee's passport.

### Not in scope

- **Terminal Authentication / Extended Access Control** (fingerprints in DG3, iris in DG4). This needs
  terminal certificates from each issuing country's CVCA, which are only given to border agencies.
  Lee's passport lists DG3, and it will stay unreadable.

### Related, smaller

- [x] **Convert JPEG 2000 chip photos to JPEG** on the server (`helpers/passport/photoHelper.js`). Done 2026-11-06.
- [ ] **Show the chip error code on the SDK's chip screen** (small text under the message). Today an unknown
      failure just says "The chip couldn't be read", which made the first failed attempt on Lee's passport impossible to diagnose.
- [ ] **Make Lee's chip read a regression fixture:** the raw files are in
      `storage/passport/ps_qRKVC6Q7EYwGC0h5pynkk4HmQH62NCuN/`. Only with consent; it's real personal data. A
      synthetic chip from another country, or the ICAO test passports, would do instead.
