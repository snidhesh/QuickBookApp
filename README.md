# Journal import for QuickBooks Online

Upload an Excel file of journal entries, check every entry against your QuickBooks
company, and post the valid ones as Journal Entries through the QuickBooks Online
Accounting API.

## What it checks before posting

- Each entry's debits equal its credits (to the cent).
- Every line has an amount in either Debits or Credits, never both.
- All lines of an entry share one date.
- Each account exists in QuickBooks. Accounts can be matched by name (any capitalisation),
  full name (`Parent:Child`) or account number. Typos get a "did you mean" suggestion.
- Names (customer, vendor, employee), classes and locations exist.
- Lines on Accounts Receivable have a customer, and lines on Accounts Payable have a vendor
  (QuickBooks requires this).
- The file's currency (from a Currency column or a header like `DEBITS (AED)`) matches the
  company's currency, unless multicurrency is on.
- Entries that seem to be in QuickBooks already are flagged and skipped unless you tick the box
  to post them anyway. With a Journal No, that means the same number. Without one, it means
  the same date, accounts and amounts.

Only entries that pass every check are posted. Each post uses a QuickBooks `requestid`, so a
retry after a network failure can't create the same entry twice. Uploading the same file twice
is caught by the duplicate check.

## Setup

1. **Intuit developer app.** At [developer.intuit.com](https://developer.intuit.com), open
   your app from the Dashboard, or create one with the **Accounting** scope.
2. **Keys.** Under *Keys & credentials* (Development/sandbox), copy the **Client ID** and
   **Client Secret**. Under *Redirect URIs*, add exactly:
   `http://localhost:5055/callback`
3. **Configure.**
   ```sh
   cp .env.example .env    # then paste the Client ID and Secret into .env
   npm install
   npm start
   ```
4. Open <http://localhost:5055>, click **Connect to QuickBooks**, and pick your sandbox company.

## Hosting on Vercel

The app runs on Vercel as a single Express function. `public/` is served by Vercel's CDN.
Hosted mode differs from local mode in three ways:

- **Storage:** the QuickBooks connection and uploaded batches live in **Upstash Redis**
  (Vercel Marketplace), because Vercel functions don't keep files or memory between requests.
- **Sign-in:** people sign in with `APP_PASSWORD`. Hosted, the app refuses to run until it is set.
- **Uploads:** files are limited to 4 MB (Vercel's request limit is 4.5 MB). Posting runs in
  rounds of about 45 seconds, so large batches never hit the function time limit.

One-time setup:

1. `vercel link` (creates the project), then `vercel deploy --prod` to get the production URL.
2. In the Vercel dashboard, open the project, go to **Storage**, and connect **Upstash for Redis**.
   This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
3. Add environment variables (Production): `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`,
   `QBO_ENVIRONMENT`, `APP_PASSWORD`. `QBO_REDIRECT_URI` is optional and defaults to
   `https://<production domain>/callback`.
4. On developer.intuit.com, add `https://<production domain>/callback` to the app's Redirect URIs.
5. `vercel deploy --prod` again, open the site, sign in, and click **Connect to QuickBooks**.

`.vercelignore` keeps `.env`, `data/` and company `.xls` files out of uploads to Vercel.

### Going live (production)

Intuit's production settings ask for these addresses (replace the domain if yours differs):

| Intuit field | Address |
| --- | --- |
| Host domain | `quickbooks-journal-import.vercel.app` |
| Launch URL | `https://quickbooks-journal-import.vercel.app/` |
| Disconnect URL | `https://quickbooks-journal-import.vercel.app/disconnected.html` |
| End-user licence agreement | `https://quickbooks-journal-import.vercel.app/terms.html` |
| Privacy policy | `https://quickbooks-journal-import.vercel.app/privacy.html` |
| Redirect URI | `https://quickbooks-journal-import.vercel.app/callback` |

Set `QBO_ENVIRONMENT=production` and use the app's **Production** keys. Intuit only issues
these after the app's production questionnaire is complete, and production redirect URIs must
be HTTPS, so the app has to run behind an HTTPS address, with `QBO_REDIRECT_URI` set to match.

## File format

The first sheet with a recognisable header row is used. Rows above the header, blank rows
and "Total" rows are ignored. [Download the template](http://localhost:5055/template.xlsx) from
the app to start from a working example.

| Column | Required | Notes |
| --- | --- | --- |
| Journal No | no | Lines with the same number form one entry. Blank cells carry the number down from the line above. Max 21 characters. Also recognised as *JE No*, *Voucher No*, *Entry No*, *Doc Number*. **Without this column**, lines are grouped in order until debits equal credits (a new entry also starts when the date changes), and QuickBooks numbers the entries itself. |
| Journal Date | yes | Real Excel dates work in any locale. For dates typed as text, choose month-first or day-first in the app. `YYYY-MM-DD` always works. |
| Account Name | yes | Name, `Parent:Child` full name, or account number. |
| Debits / Credits | yes | Positive amounts. `$`, `Rs.`, commas and currency codes are allowed. A currency in the header, like `DEBITS (AED)`, is checked against the QuickBooks company's currency. |
| Description | no | Line description. |
| Name | no | Customer, vendor or employee display name. |
| Class, Location | no | Needs class or location tracking turned on in QuickBooks. |
| Currency, Exchange Rate | no | For multicurrency companies, e.g. `USD`. |
| Journal Memo | no | Saved as the entry's private note. |
| Tax | no | Not supported yet: a line with a value here is held back rather than posted without its tax. |

## How it's built

- `server.js`: Express routes for connecting, previewing an upload and posting (results stream back entry by entry).
- `src/parse.js`: reads `.xlsx` / `.xls` / `.csv` with SheetJS, finds the header row, groups lines into entries and validates amounts, dates and balance.
- `src/resolve.js`: loads accounts, names, classes and locations from QuickBooks, matches them and builds the `JournalEntry` payloads.
- `src/qbo.js`: OAuth 2.0 (connect, refresh, revoke) and API calls, with retry on rate limits.
- `public/`: the web page.

## Error log

Every error is recorded with what failed, when, and the context (journal number, date, file):
QuickBooks API errors with Intuit's full fault details and `intuit_tid`, connection and token
errors, unexpected server errors, and failed sign-ins (as warnings, with the IP address).
Passwords, tokens and keys are never recorded.

- Each entry goes to the hosting logs (Vercel runtime logs) and to storage (Upstash, or
  `data/store.json` locally). Storage keeps the latest 2,000 entries for up to 90 days.
- Signed-in users can open **Error log** (`/errors.html`, linked in the footer) and click
  **Download log** for a JSON file to send to Intuit support.

## Notes

- One QuickBooks company is connected at a time, and everyone using this app posts to it.
  The tokens are kept in Upstash Redis when hosted, or `data/store.json` locally (git-ignored),
  and refresh automatically. QuickBooks asks you to reconnect after about 100 days without use.
- Locally the app listens on `127.0.0.1` only, and `APP_PASSWORD` is optional.
