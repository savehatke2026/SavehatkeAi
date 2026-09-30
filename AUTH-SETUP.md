# SaveHatke AI — Authentication & Access Setup

Google Sign-In only. Access is gated by a Google Sheet whitelist, checked on
the server. Sessions are signed HttpOnly cookies, and the chatbot API is
protected independently of the UI.

This document is the complete handover: files, environment variables, Google
setup, Vercel deployment, how to grant/revoke access, the full flow, the
security review, and what changed in the existing code.

---

## 1. Files

### Server (never sent to the browser)

| File | Role |
| ---- | ---- |
| `api/auth/login.js` | `GET /api/auth/login` — mints `state` + `nonce` + PKCE verifier into a signed HttpOnly cookie, redirects to Google |
| `api/auth/callback.js` | `GET /api/auth/callback` — validates state, exchanges the code, verifies the ID token, checks the whitelist, issues the session. **The only place a session is ever created.** |
| `api/auth/session.js` | `GET /api/auth/session` — who am I, and am I currently authorized? |
| `api/auth/logout.js` | `POST /api/auth/logout` — clears the session cookie |
| `api/auth/config.js` | `GET /api/auth/config` — is sign-in configured? (no secrets returned) |
| `api/chat.js` | `POST /api/chat` — the protected chatbot endpoint |
| `middleware.js` | Edge gate for `/chat.html`, `/dashboard.html`, `/profile.html` |
| `lib/config.js` | Reads and validates environment variables |
| `lib/oauth.js` | Authorization-code + PKCE flow |
| `lib/google.js` | Google ID-token verification (JWKS, RS256, aud/iss/exp/nonce) |
| `lib/googleAuth.js` | Service-account JWT-bearer tokens for Sheets |
| `lib/whitelist.js` | Reads the Sheet, normalizes emails, short-TTL cache |
| `lib/authorize.js` | Identity check + authorization check for API routes |
| `lib/session.js` | Session token creation/verification, cookie names |
| `lib/cookies.js` | base64url, HMAC signing, cookie attributes |
| `lib/http.js` | JSON responses, origin check, method guard |
| `lib/ratelimit.js` | Per-user request throttling for `/api/chat` |
| `lib/preview.js` | Built-in reply engine used when no model endpoint is configured |

### Browser (`public/`)

| File | Role |
| ---- | ---- |
| `login.html` | The login page — **Continue with Google** only |
| `access-restricted.html` | "Access restricted" page + **Sign Out** |
| `auth.js` | Wires the Google button to `/api/auth/login`; shows friendly error codes |
| `restricted.js` | Renders the denial reason, re-confirms it with the server |
| `core.js` | Shared session reader, navbar state, sign-out, `/api/chat` client |
| `chat.html` / `chat.js` | The chatbot UI |
| `dashboard.html` / `profile.html` | Account pages (also gated) |

### Config & tooling

| File | Role |
| ---- | ---- |
| `vercel.json` | Security headers (incl. CSP), no-store on `/api/*` |
| `.env.example` | Every variable, documented |
| `.gitignore` | Ignores `.env`, `.env.local`, service-account keys |
| `dev-server.mjs` | Local server emulating Vercel routing (dev only) |
| `tests/backend.test.mjs` | 105 backend security checks (Google mocked) |
| `verify.mjs` | 51 end-to-end browser checks |

---

## 2. Environment variables

### Required

| Variable | Where the value comes from |
| -------- | -------------------------- |
| `GOOGLE_CLIENT_ID` | Google Cloud → APIs & Services → Credentials → your OAuth client. Ends in `.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | Shown once when that OAuth client is created (`GOCSPX-…`) |
| `SESSION_SECRET` | You generate it. `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `GOOGLE_SHEET_ID` | The whitelist spreadsheet URL: `docs.google.com/spreadsheets/d/`**`<this part>`**`/edit` |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Service-account JSON → `client_email` |
| `GOOGLE_PRIVATE_KEY` | Service-account JSON → `private_key` (keep the `\n` escapes if single-line) |

**Alternative to the last two:** set `GOOGLE_SERVICE_ACCOUNT_JSON` to the whole
downloaded key file, either raw JSON or base64
(`node -e "console.log(require('fs').readFileSync('key.json').toString('base64'))"`).
If both forms are present, `GOOGLE_SERVICE_ACCOUNT_JSON` wins.

### Optional (defaults shown)

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `GOOGLE_SHEET_RANGE` | `A:B` | Pin a tab, e.g. `Whitelist!A:B` |
| `SESSION_MAX_AGE_SECONDS` | `604800` (7 days) | How long a signed-in user stays signed in |
| `WHITELIST_CACHE_TTL_SECONDS` | `60` | How long a whitelist read is cached |
| `WHITELIST_STALE_GRACE_SECONDS` | `120` | How long a recent snapshot may still be trusted if Google is briefly down |
| `LOGIN_NONCE_MAX_AGE_SECONDS` | `600` | How long a started sign-in attempt stays valid |
| `SAVEHATKE_MODEL_API_URL` | *(unset)* | OpenAI-compatible `/chat/completions` endpoint |
| `SAVEHATKE_MODEL_API_KEY` | *(unset)* | Bearer token for that endpoint |
| `SAVEHATKE_MODEL_NAME` | *(unset)* | Model name to request |

> If `SAVEHATKE_MODEL_API_URL` is unset, the chatbot answers with the built-in
> preview engine. The whole authorization flow still works end to end, which is
> useful for testing before you pay for a model provider.

### ⚠️ Your current `.env` is incomplete

The existing `.env` has real-looking values for the client ID, session secret,
sheet ID and service-account email, but:

- `GOOGLE_PRIVATE_KEY` is a **truncated placeholder** (its base64 body is 4
  characters, so it cannot sign anything), and
- `GOOGLE_CLIENT_SECRET` looks too short for a real Google secret.

Until those are replaced, Google sign-in and the whitelist read will both fail.
Local sign-in will report *"Authorization is temporarily unavailable."*

---

## 3. Google OAuth setup

1. Go to <https://console.cloud.google.com/> and create (or pick) a project.
2. **APIs & Services → OAuth consent screen** — choose *External*, fill in the
   app name and support email. While in *Testing*, add each whitelist user
   under **Test users** (or publish the app to avoid that step).
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   → application type **Web application**.
4. Add **Authorized redirect URIs** — these must match byte for byte:
   - Production: `https://<your-domain>/api/auth/callback`
   - Local dev: `http://127.0.0.1:8931/api/auth/callback`
5. Copy the **Client ID** and **Client secret** into `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET`.
6. **APIs & Services → Library** → enable **Google Sheets API** (needed for the
   whitelist; unrelated to sign-in but required by the same project).

Scopes requested: `openid email profile` — nothing more. No Google account data
beyond the verified email, name and `sub` is read or stored.

---

## 4. Google Sheet setup

1. Create a spreadsheet. Column A = email, column B = status (see §5).
2. **Enable the Sheets API** (step 6 above).
3. Create the service account: **IAM & Admin → Service accounts → Create**.
4. On that account: **Keys → Add key → Create new key → JSON**. Download it.
5. From the JSON, set `GOOGLE_SERVICE_ACCOUNT_EMAIL` (`client_email`) and
   `GOOGLE_PRIVATE_KEY` (`private_key`).
6. **Share the spreadsheet** with the service-account email address, exactly as
   you would share it with a person. **Viewer** is enough.

   This is the step people miss. The sheet stays private — the service account
   is the only identity that can read it, and its key never leaves the server.

7. Set `GOOGLE_SHEET_ID` to the ID from the spreadsheet URL.

---

## 5. Required Sheet columns

| Column | Header (not required, but ignored if present) | Values |
| ------ | --------------------------------------------- | ------ |
| **A** | `Email` | The Google account email |
| **B** | `Status` | `active` → allowed. Anything else (`disabled`, blank, …) → refused |

Rules the code enforces:

- Email is trimmed and lower-cased before matching.
- A header row in the first three rows is skipped automatically.
- A row whose column A is not an email address is ignored.
- A row with **no** status is treated as **not authorized** (fails closed).
- `active` is the only value that grants access. `Active`, ` ACTIVE ` also work
  (normalized). `enabled`, `yes`, `1` do **not**.

Example:

| Email | Status |
| ----- | ------ |
| you@gmail.com | active |
| colleague@gmail.com | active |
| former@gmail.com | disabled |

---

## 6. Vercel deployment

1. Push the repository to GitHub. Confirm `.env` is **not** in the commit
   (it is already in `.gitignore`).
2. **Vercel → Add New → Project → import the repo.**
3. Framework preset: **Other**. Leave the build command empty and the output
   directory as `public` — `vercel.json` already sets both.
4. **Settings → Environment Variables** — add every variable from §2 for
   *Production*, *Preview* and *Development*. Paste `GOOGLE_PRIVATE_KEY`
   verbatim, keeping its `\n` escapes, or use `GOOGLE_SERVICE_ACCOUNT_JSON`
   instead.
5. Add the production redirect URI from §3 step 4 to the Google OAuth client.
6. Deploy. Then check `https://<your-domain>/api/auth/config` — it should
   return `{"configured":true,...}`. If it lists `missing`, that names exactly
   which variables Vercel has not picked up.

**Frontend / backend separation:** everything in `public/` is public; everything
in `api/`, `lib/` and `middleware.js` is server-only. No server module is
imported by any file in `public/`, and no secret is ever read outside
`lib/config.js`.

---

## 7. Adding and removing users

There is no admin dashboard by design — the Sheet *is* the admin panel.

**Add:** add a row with the email and `Status = active`. Access works within
`WHITELIST_CACHE_TTL_SECONDS` (60s by default). No redeploy.

**Remove / suspend:** change `Status` to `disabled` (or delete the row).
Access is blocked within the same window — including for a user who already has
a valid session cookie.

Nothing is cached permanently: the cache is re-read after the TTL, and a cold
start always re-reads the Sheet.

---

## 8. How the flow works

```
1.  Browser      →  GET /api/auth/login
2.  Server       →  mints state + nonce + PKCE verifier
                    stores them in a signed, HttpOnly, 10-minute cookie
                    redirects to accounts.google.com
3.  Google       →  user picks an account and consents
4.  Google       →  redirects to /api/auth/callback?code=…&state=…
5.  Server       →  validates `state` against the signed cookie   (CSRF)
6.  Server       →  exchanges `code` for tokens using the client secret
                    AND the PKCE verifier                          (proves it is us)
7.  Server       →  verifies the Google ID token:
                      RS256 signature against Google's JWKS
                      aud  == our client id      (blocks replay from another app)
                      iss  == accounts.google.com
                      exp  / iat  valid
                      email_verified == true
                      nonce == the one we issued  (blocks replay)
8.  Server       →  normalizes the email (trim + lower-case)
9.  Server       →  reads the Google Sheet (service account, cached ≤60s)
10. Decision     →  active  → issue session cookie, redirect to the chatbot
                    missing → access-restricted.html?reason=not_listed
                    disabled→ access-restricted.html?reason=disabled
                    Sheets down → 503, or a recent snapshot within the grace window
11. Every protected request afterwards:
                    middleware (pages) and lib/authorize.js (APIs) both
                    re-verify the cookie AND re-check the Sheet
12. Sign out     →  POST /api/auth/logout clears the cookies
```

Two deliberate properties:

- **The browser never decides anything.** It never sees the client secret, the
  PKCE verifier, the nonce or a raw Google token, and it never reads the Sheet.
- **Authentication ≠ authorization.** The cookie proves *who* you are. The Sheet
  decides *whether you may enter*, and is re-checked on every protected request.

---

## 9. Security review

Every item below was checked; the fixes are noted.

| Area | Result |
| ---- | ------ |
| **Authentication bypass** | No path creates a session except `callback.js`, after state + PKCE + ID-token verification. |
| **Authorization bypass** | `lib/authorize.js` re-checks the Sheet on every protected API call. A valid cookie alone is never enough. |
| **Direct API access without login** | `POST /api/chat` returns 401 with no session and 403 when revoked — verified by test. |
| **Frontend-only authorization** | The UI hiding is cosmetic. `middleware.js` gates the pages and every API re-authorizes independently. |
| **Session manipulation** | HMAC-SHA256 signed, constant-time compared, expiry enforced. Forged/tampered/expired cookies return 401 (tested). |
| **Token validation** | Signature, `aud`, `iss`, `exp`, `iat`, `email_verified` and `nonce` all verified. `alg: none` and algorithm substitution rejected. |
| **CSRF** | OAuth `state` is signed and compared in constant time; `SameSite=Lax`; explicit `Origin` check on `POST /api/chat` and `POST /api/auth/logout`. |
| **CORS** | No CORS headers are set anywhere, so browsers enforce same-origin. No wildcard. |
| **Credential exposure** | No secret appears in `public/`, HTML or client JS (scanned). `lib/config.js` is the only reader of `process.env`, and only server modules import it. |
| **OAuth misconfiguration** | The redirect URI is derived from the request, so it cannot drift from the registered one. `/api/auth/config` reports missing variables without revealing values. |
| **Sheet credential exposure** | Service-account key is used server-side only, to sign a short-lived JWT assertion. The Sheet is shared with that account and stays private. |
| **API abuse** | `/api/chat` is rate-limited per authenticated user (30/60s) and caps message, turn and total prompt size. |
| **Information leakage** | Errors return `{ error, code }` only. Stack traces and provider responses go to the server log, never the browser. |
| **Session cookie** | `HttpOnly`, `SameSite=Lax`, `Secure` on https, `Path=/`, `Max-Age` set, `no-store` on all auth responses. |
| **No credentials in `localStorage`** | The session is a cookie JS cannot read. `localStorage` holds only placeholder account/API-key data, namespaced per email, and is never used for an authorization decision. |
| **Open redirect** | `?next=` is restricted to a same-site `*.html` path on both the client and the server. |
| **Fail closed** | Missing config → 500, not "allow". Missing status → denied. Sheets unreachable → 503 unless a recent snapshot is within the grace window. |
| **XSS** | Fixed during this review — see below. |

### Fixed during this review

1. **`GOOGLE_CLIENT_SECRET` was never read.** `lib/oauth.js` sent
   `client_secret: undefined`, so real sign-in would have failed with
   `invalid_client`, and a deploy missing the secret still reported as
   "configured". Added to `lib/config.js` (both `getConfig()` and
   `missingConfig()`). The existing test missed it because its mocked token
   endpoint only checked that the substring `client_secret=` was present — which
   `client_secret=undefined` satisfies. The mock now asserts real values.
2. **No Content-Security-Policy.** Added to `vercel.json`:
   `script-src 'self'` (no inline scripts, no third-party scripts),
   `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`,
   `form-action 'self'`. `style-src` keeps `'unsafe-inline'` because the
   existing pages use inline `style` attributes; removing that would mean
   rewriting the styling, which was out of scope. Verified that all nine pages
   still render and load `styles.css` with no violations.
3. **`server.cjs` was a second, diverging dev server.** It read only
   `.env.local` and could not stub the whitelist. Reduced to a thin alias for
   `dev-server.mjs`, so `node server.cjs` still works.
4. **`.env` multi-line values were mis-parsed.** `dev-server.mjs` split `.env`
   line by line, which truncates a multi-line quoted PEM private key to its
   `-----BEGIN PRIVATE KEY-----` header. It now uses Node's own `loadEnvFile`
   (with a documented fallback) and still lets the shell environment win.

### Known, accepted limitations

- **Rate limiting is per warm serverless instance**, so it is a speed bump, not
  a hard limit. Real volumetric protection belongs at the edge/platform layer.
  Authorization is enforced separately and unconditionally.
- **Sessions are stateless**, so "Sign Out" clears the cookie on that browser
  but does not server-side revoke a copied token before it expires. To cut
  access immediately, set the Sheet status to `disabled` — that takes effect
  within the cache TTL regardless of the cookie.
- **`/api/auth/config` reports the *names* of missing variables** to anonymous
  callers. Names only, never values; it exists to make a bad deploy obvious.
- **The dashboard's API keys are placeholders** held in `localStorage`. No
  server endpoint validates them, and they are not an authorization factor.

---

## 10. Existing code that changed, and why

Nothing about the chatbot UI, styling or AI behaviour was rewritten. The
changes were limited to correctness and safety:

| File | Change | Why |
| ---- | ------ | --- |
| `lib/config.js` | Added `googleClientSecret`; added it to `missingConfig()` | It was never read, so the OAuth code exchange could not work |
| `tests/backend.test.mjs` | Mock now requires real `client_secret`/`code_verifier`/`client_id` values; extracted a `startLogin()` helper | The old substring check let the bug above pass; the helper makes a misconfigured deploy fail cleanly instead of crashing the suite |
| `dev-server.mjs` | Whitelist stub seam; `.env.local` support; Node-parser-based `.env` loading | The end-to-end harness could not control authorization (it was injecting into its own process); multi-line private keys were being truncated |
| `verify.mjs` | Loads `.env`; starts/stops its own server; drives the whitelist via the stub; null-safe navbar assertion; deterministic restricted-page section; Windows-safe teardown | The suite could not run at all before: it read no `SESSION_SECRET`, targeted the wrong process, and leaked its server |
| `package.json` | `dev` → `dev-server.mjs`; added `test`, `test:backend`, `test:e2e` | `test` pointed at a non-existent `verify.cjs`; the backend suite's documented `test:backend` script did not exist |
| `server.cjs` | Reduced to an alias for `dev-server.mjs` | Two dev servers had drifted apart |
| `vercel.json` | Added `Content-Security-Policy` | No CSP was set |
| `.gitignore` | Ignore `tests/.whitelist.stub.json` | Test artefact |
| `public/core.js` | Corrected a comment | It described a `POST /api/auth/google` route that does not exist |

---

## 11. Running it locally

```bash
npm run dev        # http://127.0.0.1:8931
npm test           # 105 backend checks + 51 end-to-end checks
npm run test:backend
npm run test:e2e
```

The backend suite mocks Google's endpoints, so it needs no credentials. The
end-to-end suite starts its own server and stubs the whitelist, so it needs no
Google access either. Both pass without any real credentials configured.

To exercise **real** Google sign-in locally, fill in `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `GOOGLE_SHEET_ID` and the service-account values, and
register `http://127.0.0.1:8931/api/auth/callback` as a redirect URI.
