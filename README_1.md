# A3S Survey Tool — deployment guide

A no-backend, no-hosting-cost survey tool for Advance 3 Spaces. Runs entirely
on Google Sheets + Apps Script (as the "backend") and GitHub Pages (as static
hosting) — no server to maintain, no monthly bill, deployable without a
developer once it's set up.

## What's in this folder

| File | Purpose | Who opens it |
|---|---|---|
| `survey.html` | Check-in + the participant survey (interests, preferences, impact) | Every attendee, on their own device — this is what the door QR code should point to |
| `results-public.html` | Shared-interest matching view (board games only) | Anyone — safe to share the link widely |
| `admin.html` | Attendance + preferences + impact dashboard, secret-key gated | Organizers only |
| `apps-script.gs` | The backend logic — lives inside the Google Sheet | Nobody directly; it's infrastructure |

## How it works

- **`survey.html`** opens on check-in. If it recognizes the device (a
  cookie from a previous visit), it shows a one-tap "Welcome back" screen;
  otherwise it asks for name + email. The instant identity is confirmed —
  before any question is answered — it fires a lightweight check-in POST
  that logs attendance immediately. The questions come after, but they're
  optional: a "I'm checked in — skip the rest" link is always available, and
  attendance is already recorded either way.
- Two kinds of POST land on the backend:
  1. **`checkin`** — fired the moment identity is confirmed. Appends a row
     to `CheckIns` (the attendance record) and creates/touches a minimal
     stub in `Profiles` if this is a new person.
  2. **`survey`** — fired if/when they finish or skip out of the questions,
     carrying whatever they answered. **Upserts** `Profiles` (interests and
     preferences always reflect the *latest* answers — but only for fields
     actually answered; a partial submission never blanks out earlier
     answers) and, if any impact question was answered, **appends** a row to
     `ImpactLog` (impact data is never overwritten, so you can see trends
     across events over time).
- First-time vs. returning is **not** self-reported — `CheckIns` records it
  based on whether that email already had a `Profiles` row at the moment of
  check-in, which is what feeds the `ImpactLog` "AttendeeStatus" column too.
- **`results-public.html`** fetches only the interest fields (never
  preferences, email, attendance, or impact data — the backend itself
  withholds those fields unless the request includes the correct admin key,
  so there's nothing sensitive to find even by inspecting network traffic)
  and draws a force-directed graph per question, clustering people who share
  an answer.
- **`admin.html`** requires `?key=<your secret>` in the URL (or typing it
  into the unlock screen, which remembers it for that browser tab only). It
  then gets the full dataset: attendance (check-ins, first-time rate, a
  check-ins-by-date chart), per-person preferences, and the full impact log
  with charts and sortable/filterable/exportable tables.

## Using it for event check-in

Point a QR code at the door straight at `survey.html`. Each person scans
with their own phone (not a shared device — see the limitation below),
confirms who they are, and they're checked in. The questions that follow
are optional and can be answered later from the same link — attendance
doesn't wait on them.

## Current question set

As of 2026-08-14, the impact questions (felt-more-connected, belonging,
would-return-if-isolated, what-almost-kept-you-away) are **commented out**
in `survey.html` — they didn't fit the check-in flow. They're not deleted:
they're sitting in a clearly-marked comment block right after the
`BreakPref` question in the `QUESTIONS` array, ready to uncomment. Nothing
else needs to change to bring them back — `apps-script.gs` and `admin.html`
already handle an empty `ImpactLog` gracefully and will pick real data back
up automatically once the questions return.

The survey currently asks 10 questions total: 5 board-game interest
questions (public matching) and 5 sensory/interaction preference questions
(organizer-only).

## Branding

The A3S logo is embedded directly in each HTML file as a base64 image (no
separate image file to keep track of — the source PNG lives in `assets/`
in case you need to re-export it at a different size). Brand colors were
sampled from the logo itself:

| Role | Hex | Used for |
|---|---|---|
| Teal | `#077b92` | Buttons, links, active states |
| Navy | `#023648` | Headings, brand wordmark |
| Tan | `#a88360` | (sampled, not currently used in UI — reserved for future accents) |

These are kept as separate `--brand-*` CSS variables from the chart/graph
colors used in `results-public.html` and `admin.html` — the graphs use a
validated, colorblind-safe categorical palette that's a different concern
from brand color and shouldn't be swapped casually (mixing the two risks
breaking the contrast/distinguishability guarantees that palette was
checked against).

## Deployment steps

1. **Create a Google Sheet.** Any blank sheet works — the script creates its
   own `Profiles`, `CheckIns`, and `ImpactLog` tabs automatically on first
   submission.
2. **Extensions → Apps Script.** Delete the placeholder code and paste in
   the full contents of `apps-script.gs`.
3. **Set your admin key.** At the top of the script, change:
   ```js
   const ADMIN_KEY = 'REPLACE_WITH_A_LONG_RANDOM_ADMIN_PHRASE';
   ```
   to something long and hard to guess (a passphrase like
   `a3s-quiet-tuesday-owl-42` is plenty — it doesn't need to be memorable,
   just unguessable). **The dashboard will refuse to unlock until you change
   this from the placeholder.**
4. **Deploy → New deployment → Web app.**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click Deploy, authorize the permissions it asks for, and copy the
     resulting URL ending in `/exec`.
5. **Wire the URL into all three HTML files.** In `survey.html`,
   `results-public.html`, and `admin.html`, find the line near the top of
   the `<script>` block:
   ```js
   const SCRIPT_URL = "PASTE_YOUR_APPS_SCRIPT_EXEC_URL_HERE";
   ```
   and replace it with the `/exec` URL from step 4, in all three files.
6. **Push to GitHub Pages.** Create a repo, add these files (you don't need
   `README.md` or `apps-script.gs` published, but it's fine if they are —
   nothing in this repo besides the `/exec` URL itself is sensitive, and the
   Web App URL by itself can't expose preference or impact data without the
   admin key). Settings → Pages → Deploy from branch → `main` / root.
7. **Share the links:**
   - `survey.html` — the form, share widely (QR code at events works well)
   - `results-public.html` — the shared-interest view, safe to share/display
   - `admin.html?key=<your admin key>` — bookmark this one yourself; don't
     post it publicly. Once you visit it with the key in the URL, it'll stay
     unlocked for that browser tab (via `sessionStorage`) without the key
     needing to stay in the address bar.

No build step, no `npm install`, no CI — just static files.

## Known limitations (worth knowing, not necessarily worth fixing now)

- **Admin gate is a shared secret, not a login system.** Anyone who has the
  key can see preferences and impact data — there's no per-organizer
  identity or audit log of who viewed what. This was a deliberate tradeoff
  to keep the whole thing backend-free; if A3S ever needs real accounts
  (e.g. multiple staff with different access levels), that's a bigger
  rebuild, not a tweak.
- **Returning-person recognition is by email, per browser.** Interests and
  preferences upsert by *email*, which is reliable across devices. The
  cookie GUID is stored alongside each submission mainly as a convenience
  (auto-filling the form next time) and an audit trail — it is **not**
  required for the upsert to work correctly.
- **The "Welcome back" check-in screen is device recognition, not identity
  verification.** It's a cookie check, not a lookup against who's actually
  attended before — it works well because check-in happens on each
  person's own phone, so the common case (same phone across events) is
  exactly what it's built for. It doesn't stop someone from checking in
  under any name/email they type, and a new phone means typing in details
  again even for a longtime attendee. The **admin-facing** first-time/
  returning stat is more rigorous — it's computed server-side from whether
  the typed email already has a profile, regardless of device — but the
  door-side "welcome back" experience itself is just a convenience, not a
  security or accuracy feature.
- **No hard link between a check-in and whether the survey got finished.**
  `CheckIns` and `ImpactLog` are independent append-only logs, correlated
  loosely by email and roughly-matching timestamps — there's no explicit
  "this check-in led to this impact submission" foreign key. The "check-ins
  that answered impact Qs" stat tile is a same-day approximation, not a
  guaranteed 1:1 match.
- **Public repo = public source, if using GitHub Pages' free tier.** The
  repo (and therefore the `/exec` URL) is visible to anyone who looks. This
  is fine because the URL alone can't retrieve preference/impact data
  without the admin key — but if that ever feels insufficient, moving to a
  private repo with Pages (GitHub Pro/Team) or another static host closes
  that gap.
- **Last-write-wins, no transactions.** Each person only ever writes their
  own profile row, so this isn't a real risk in practice — just noting that
  Sheets isn't a transactional database.
- **Polling, not push.** The public results page refreshes every ~90
  seconds; not true real-time, which is fine for an ongoing tool that isn't
  a live projected session.
- **Duplicate real names are fine** — matching/display uses whatever name
  someone types, so two "Sam"s will just show as two separate dots. Only
  *email* is used as the identity key for upserting.

## If you ever want to reuse this pattern elsewhere

Sections 2–5 of the architecture (Google Sheets as a datastore, Apps Script
as the API, JSONP for cross-origin reads, fire-and-forget POSTs) generalize
to almost any "collect answers from a group, show results, no budget for a
real backend" tool. The things that would actually need to change: the
sheet schema, the question set, what counts as a "match," and the admin
gating model if the privacy needs are different.
