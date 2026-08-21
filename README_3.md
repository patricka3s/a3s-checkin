# A3S Survey Tool — deployment guide

A no-backend, no-hosting-cost survey tool for Advance 3 Spaces. Runs entirely
on Google Sheets + Apps Script (as the "backend") and GitHub Pages (as static
hosting) — no server to maintain, no monthly bill, deployable without a
developer once it's set up.

## What's in this folder

| File | Purpose | Who opens it |
|---|---|---|
| `survey.html` | Check-in (incl. behavior-policy acknowledgment) + the participant survey (interests, preferences, impact) | Every attendee, on their own device — this is what the door QR code should point to |
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

## Behavior policy acknowledgment

The first time someone checks in on a given device (the same "new/
unrecognized device" path that asks for name + email), they're shown the
full **Advance 3 Spaces Member Behavior Policy** and must check a box
acknowledging it before the "Check in" button enables — there's no skip for
this step. The policy text lives in `survey.html` as the `POLICY_SECTIONS`
constant; if you ever need to update the wording, edit it there and bump
`POLICY_VERSION` alongside it so old and new acknowledgments stay
distinguishable in the data.

- On the **"Welcome back" (recognized-device) path**, the policy isn't
  re-shown — there's a "View our behavior policy" link instead, which opens
  a read-only copy of the same text with no checkbox, for anyone who wants
  a refresher.
- Each acknowledgment is logged to its own append-only `PolicyAcknowledgments`
  sheet (timestamp, email, GUID, name, policy version) — never overwritten,
  so if the policy text changes and people re-acknowledge, you keep the full
  history rather than just the latest.
- `admin.html`'s **Individual preferences** table has a "Policy ack'd"
  column (most recent acknowledgment per person) and the stat row has a
  "Behavior policy acknowledged" percentage tile.
- Like the "Welcome back" recognition itself, this is a **per-device**
  heuristic, not a per-person guarantee — someone who acknowledges on their
  phone and later checks in from a different device (or a friend's phone)
  will be asked to acknowledge again. That's an intentional tradeoff (asking
  again is harmless; silently skipping it for someone who's never actually
  acknowledged would not be) — see "Known limitations" below.

## Photo consent

Right after the behavior-policy screen (same new/unrecognized-device path),
first-time attendees are asked a required Yes/No question: is it okay to
photograph them at events? There's no skip — but it's a genuine choice, not
a gate, so either answer lets them continue checking in immediately.

- Choosing **"No photos please"** shows a short confirmation screen telling
  them to grab a **"No photos please" lanyard at the check-in table** so
  it's visible at a glance during the event — make sure those lanyards are
  actually stocked at check-in, since the app now tells people they exist.
- The answer is stored on their profile (`PhotoConsent`, upsert-safe like
  the other preference fields) — it's whatever they most recently said, not
  an append-only log, since this is "current status," not a compliance
  record like the policy acknowledgment.
- **Silence defaults to "no."** Anyone who hasn't been asked (an
  already-returning device from before this feature existed, or any future
  edge case) shows as "No photos" in `admin.html`, never as a blank/unknown
  that could be misread as permission. Treat "no explicit yes" as "don't
  photograph them," full stop.
- `admin.html`'s preferences table has a "Photo OK?" column and the stat
  row has an "Opted out of photos" count, so whoever's taking photos at an
  event can check the dashboard beforehand.
- Same per-device limitation as the policy step: it's only asked on a
  new/unrecognized device, so there's currently no in-app way for someone
  to change their answer later short of checking in again from a device
  that doesn't recognize them. If that becomes a real need, a "change your
  photo preference" link (mirroring the policy step's read-only view link)
  would be a natural small addition.

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
   own `Profiles`, `CheckIns`, `ImpactLog`, and `PolicyAcknowledgments` tabs
   automatically on first submission. (If you're updating an **already-live**
   sheet to a newer `apps-script.gs` that adds a column to an existing tab —
   like `PhotoConsent` being added to `Profiles` — the script automatically
   extends that tab's header row to match on its next write; you don't need
   to add the column by hand.)
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
- **Policy acknowledgment is per-device, not per-person.** It rides on the
  same cookie heuristic as "Welcome back" — a new device means acknowledging
  again even for a longtime member. `PolicyAcknowledgments` is append-only,
  so this shows up as multiple rows per person over time rather than one
  authoritative "has this person ever agreed" flag; the admin "Policy ack'd"
  column shows the most recent one.
- **Photo consent is per-device too, and there's no in-app way to change it
  later.** Same tradeoff as the policy step, but the stakes are a bit
  different — since silence defaults to "no photos," the failure mode of
  this heuristic is "assumes no" rather than "assumes yes," which is the
  safer direction for a consent question to err in.

## If you ever want to reuse this pattern elsewhere

Sections 2–5 of the architecture (Google Sheets as a datastore, Apps Script
as the API, JSONP for cross-origin reads, fire-and-forget POSTs) generalize
to almost any "collect answers from a group, show results, no budget for a
real backend" tool. The things that would actually need to change: the
sheet schema, the question set, what counts as a "match," and the admin
gating model if the privacy needs are different.
