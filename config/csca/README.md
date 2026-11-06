# CSCA certificates

Country Signing CA certificates, used to check who signed a passport chip (see `helpers/passport/chipHelper.js`).
Every `.ml` (CSCA master list), `.pem`, `.crt`, `.cer` or `.der` file here is loaded when the first chip is
checked, or after `POST /api/admin/csca/reload`.

- `DE_ML_*.ml`: the German BSI master list (CSCA certificates the German CSCA has checked, 117 countries,
  including Zimbabwe). Download the latest from
  https://www.bsi.bund.de/SharedDocs/Downloads/DE/BSI/ElekAusweise/CSCA/GermanMasterList.html and replace
  the old file. Its usage conditions allow commercial use, but not in advertising or in a way that suggests
  cooperation with the BSI.
- A country that isn't in the list (e.g. South Africa) can be added as its own certificate file, from the
  ICAO PKD or the issuing authority.

A chip whose country has no certificate here comes back `unverified`, not `failed`.
