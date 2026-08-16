/**
 * A3S Survey Tool — backend
 * ==========================
 * Deploy this inside a Google Sheet: Extensions → Apps Script, paste this
 * file in as Code.gs, then Deploy → New deployment → Web app
 * (Execute as: Me, Who has access: Anyone). Copy the resulting /exec URL
 * into SCRIPT_URL at the top of survey.html, results-public.html, and
 * admin.html.
 *
 * Three sheets, created automatically on first submit:
 *   - "Profiles"  — one row PER PERSON, upserted by email. Holds their
 *                   current interests + preferences. Always reflects the
 *                   most recent submission for that person. Upserts are
 *                   MERGE-safe: a partial payload (e.g. a check-in with no
 *                   question answers yet) only touches the fields it
 *                   actually includes, never blanks out the rest.
 *   - "CheckIns"  — one row PER CHECK-IN EVENT, appended (never
 *                   overwritten). This is the attendance record — it's
 *                   written the moment someone confirms their identity at
 *                   the door, independent of whether they go on to answer
 *                   any questions. IsReturning is computed server-side from
 *                   whether a Profile already existed for that email at
 *                   that moment — not self-reported.
 *   - "ImpactLog" — one row PER SURVEY SUBMISSION, appended (never
 *                   overwritten). Lets you see trends over time and each
 *                   person's history. Its AttendeeStatus column is copied
 *                   from that visit's CheckIns row rather than recomputed
 *                   (recomputing at submit time would always say "existing"
 *                   since the check-in for this same visit already touched
 *                   the profile a moment earlier).
 *   - "PolicyAcknowledgments" — one row EACH TIME someone checks the
 *                   behavior-policy box, appended (never overwritten). This
 *                   is a compliance record, not a profile field — it's kept
 *                   as its own append-only log (like CheckIns/ImpactLog) so
 *                   there's a timestamped history if the policy text ever
 *                   changes and people need to re-acknowledge.
 *
 * The client sends two kinds of POST, distinguished by body.type:
 *   - "checkin" — fired the instant someone confirms who they are at the
 *     door, before any question is answered. Creates/touches a minimal
 *     Profile stub and appends a CheckIns row.
 *   - "survey" (default) — fired when someone finishes or skips out of the
 *     question flow, with whatever they answered. Merges into their
 *     Profile and, if any impact question was answered, appends an
 *     ImpactLog row.
 *
 * doGet has two modes, decided entirely server-side (the public caller
 * never receives preference/impact/attendance data over the network, not
 * just a hidden-in-the-UI trick):
 *   - no ?key=, or wrong key  → public payload: display name + the 5
 *     interest questions only.
 *   - ?key=<ADMIN_KEY>        → full payload: everything in Profiles
 *     (including preferences + email), all of ImpactLog, and all of
 *     CheckIns.
 */

// ====== CONFIG — change before deploying ======
// Pick a long, hard-to-guess phrase. This is the only thing standing
// between the public and the preferences/impact data, so don't reuse a
// password from elsewhere and don't leave it as the placeholder below.
const ADMIN_KEY = 'REPLACE_WITH_A_LONG_RANDOM_ADMIN_PHRASE';

const PROFILES_SHEET = 'Profiles';
const IMPACT_SHEET = 'ImpactLog';
const CHECKINS_SHEET = 'CheckIns';
const POLICY_SHEET = 'PolicyAcknowledgments';

// Fields participants never see reflected back to them and that are
// only ever returned in admin mode.
const PUBLIC_PROFILE_FIELDS = [
  'DisplayName', 'LastUpdated', 'Genre', 'PaceStyle', 'FavoriteReplayGame', 'TeachStyle', 'CompetitiveStyle'
];

const PROFILE_COLUMNS = [
  'Email', 'GUID', 'DisplayName', 'LastUpdated',
  // Interests (public — feed the shared-interest matching view)
  'Genre', 'PaceStyle', 'FavoriteReplayGame', 'TeachStyle', 'CompetitiveStyle',
  // Preferences (private — organizer-only, accommodation planning)
  'SocialStyle', 'NoiseTolerance', 'LightSensitivity', 'GroupSizePref', 'BreakPref'
];

const IMPACT_COLUMNS = [
  'Timestamp', 'Email', 'GUID', 'DisplayName',
  'FeltMoreConnected', 'BelongingAgreement', 'WouldReturnIfIsolated',
  'AttendeeStatus', 'WhatAlmostKeptYouAway'
];

const CHECKIN_COLUMNS = ['Timestamp', 'Email', 'GUID', 'DisplayName', 'IsReturning'];

const POLICY_COLUMNS = ['Timestamp', 'Email', 'GUID', 'DisplayName', 'PolicyVersion'];

// Impact fields that count as "this submission actually answered something
// impact-related" — used to decide whether a 'survey' POST should append a
// row to ImpactLog at all, so skipping straight through without answering
// any impact question doesn't leave a near-empty row behind.
const IMPACT_ANSWER_FIELDS = ['FeltMoreConnected', 'BelongingAgreement', 'WouldReturnIfIsolated', 'WhatAlmostKeptYouAway'];

const RETURNING_LABEL = "I've been before";
const FIRST_TIME_LABEL = 'First time';

// ====== Write path ======

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const type = body.type || 'survey';

  if (type === 'checkin') {
    const existedBefore = profileExists(ss, body.email);
    upsertProfile(ss, body); // creates/touches a minimal stub if new
    appendCheckIn(ss, body, existedBefore);
    if (body.policyAcknowledged) appendPolicyAcknowledgment(ss, body);
  } else {
    upsertProfile(ss, body); // merges full answers into their profile
    if (hasImpactAnswer(body)) appendImpact(ss, body);
  }

  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

function hasImpactAnswer(body) {
  return IMPACT_ANSWER_FIELDS.some(function (k) {
    return (body[k] || '').toString().trim() !== '';
  });
}

function profileExists(ss, email) {
  const sheet = ss.getSheetByName(PROFILES_SHEET);
  if (!sheet) return false;
  const data = sheet.getDataRange().getValues();
  const emailCol = PROFILE_COLUMNS.indexOf('Email');
  const target = normalizeEmail(email);
  for (let i = 1; i < data.length; i++) {
    if (normalizeEmail(data[i][emailCol]) === target) return true;
  }
  return false;
}

// Merge-safe upsert: a column is only overwritten when the incoming
// payload actually includes it (and it's non-empty). A check-in-only
// payload (email/guid/displayName, nothing else) will never blank out
// interests/preferences a fuller submission already set.
function upsertProfile(ss, body) {
  const sheet = getOrCreateSheet(ss, PROFILES_SHEET, PROFILE_COLUMNS);
  const data = sheet.getDataRange().getValues();
  const emailCol = PROFILE_COLUMNS.indexOf('Email');
  const email = normalizeEmail(body.email);

  let rowIndex = -1; // 1-based sheet row
  let existingRow = null;
  for (let i = 1; i < data.length; i++) {
    if (normalizeEmail(data[i][emailCol]) === email) {
      rowIndex = i + 1;
      existingRow = data[i];
      break;
    }
  }

  const row = PROFILE_COLUMNS.map(function (col, idx) {
    switch (col) {
      case 'Email': return email;
      case 'GUID': return body.guid || (existingRow ? existingRow[idx] : '');
      case 'DisplayName': return body.displayName || (existingRow ? existingRow[idx] : '');
      case 'LastUpdated': return new Date();
      default:
        if (Object.prototype.hasOwnProperty.call(body, col) && body[col] !== '') return body[col];
        return existingRow ? existingRow[idx] : '';
    }
  });

  if (rowIndex === -1) {
    sheet.appendRow(row);
  } else {
    sheet.getRange(rowIndex, 1, 1, row.length).setValues([row]);
  }
}

function appendCheckIn(ss, body, existedBefore) {
  const sheet = getOrCreateSheet(ss, CHECKINS_SHEET, CHECKIN_COLUMNS);
  const row = CHECKIN_COLUMNS.map(function (col) {
    switch (col) {
      case 'Timestamp': return new Date();
      case 'Email': return normalizeEmail(body.email);
      case 'GUID': return body.guid || '';
      case 'DisplayName': return body.displayName || '';
      case 'IsReturning': return existedBefore ? RETURNING_LABEL : FIRST_TIME_LABEL;
      default: return '';
    }
  });
  sheet.appendRow(row);
}

// Only called when body.policyAcknowledged is truthy — i.e. the survey's
// policy checkbox screen (shown on the new/unrecognized-device check-in
// path). One row per acknowledgment, not deduped, so re-acknowledging on a
// new device (or after the policy text changes) just adds another row
// rather than overwriting history.
function appendPolicyAcknowledgment(ss, body) {
  const sheet = getOrCreateSheet(ss, POLICY_SHEET, POLICY_COLUMNS);
  const row = POLICY_COLUMNS.map(function (col) {
    switch (col) {
      case 'Timestamp': return new Date();
      case 'Email': return normalizeEmail(body.email);
      case 'GUID': return body.guid || '';
      case 'DisplayName': return body.displayName || '';
      case 'PolicyVersion': return body.policyVersion || '';
      default: return '';
    }
  });
  sheet.appendRow(row);
}

function appendImpact(ss, body) {
  const sheet = getOrCreateSheet(ss, IMPACT_SHEET, IMPACT_COLUMNS);
  const attendeeStatus = lookupLatestCheckInStatus(ss, body.email);
  const row = IMPACT_COLUMNS.map(function (col) {
    switch (col) {
      case 'Timestamp': return new Date();
      case 'Email': return normalizeEmail(body.email);
      case 'GUID': return body.guid || '';
      case 'DisplayName': return body.displayName || '';
      case 'AttendeeStatus': return attendeeStatus;
      default: return body[col] || '';
    }
  });
  sheet.appendRow(row);
}

// The ImpactLog's AttendeeStatus mirrors whatever this visit's CheckIns
// row already determined, rather than re-deriving it — by survey-submit
// time the check-in for this same visit has already touched the profile,
// so re-checking "does a profile exist" here would incorrectly say
// "returning" even for a brand-new person. Scans from the most recent row
// backwards since that's the check-in this submission belongs to.
function lookupLatestCheckInStatus(ss, email) {
  const sheet = ss.getSheetByName(CHECKINS_SHEET);
  if (!sheet) return '';
  const data = sheet.getDataRange().getValues();
  const emailCol = CHECKIN_COLUMNS.indexOf('Email');
  const statusCol = CHECKIN_COLUMNS.indexOf('IsReturning');
  const target = normalizeEmail(email);
  for (let i = data.length - 1; i >= 1; i--) {
    if (normalizeEmail(data[i][emailCol]) === target) return data[i][statusCol];
  }
  return '';
}

function getOrCreateSheet(ss, name, columns) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(columns);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function normalizeEmail(email) {
  return (email || '').toString().trim().toLowerCase();
}

// ====== Read path ======

function doGet(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const params = e.parameter || {};
  const isAdmin = params.key && ADMIN_KEY !== 'REPLACE_WITH_A_LONG_RANDOM_ADMIN_PHRASE' && params.key === ADMIN_KEY;

  let payload;
  if (isAdmin) {
    payload = {
      ok: true,
      admin: true,
      profiles: readSheetAsObjects(ss, PROFILES_SHEET, PROFILE_COLUMNS),
      impact: readSheetAsObjects(ss, IMPACT_SHEET, IMPACT_COLUMNS),
      checkins: readSheetAsObjects(ss, CHECKINS_SHEET, CHECKIN_COLUMNS),
      policyAcknowledgments: readSheetAsObjects(ss, POLICY_SHEET, POLICY_COLUMNS)
    };
  } else {
    const allProfiles = readSheetAsObjects(ss, PROFILES_SHEET, PROFILE_COLUMNS);
    payload = {
      ok: true,
      admin: false,
      profiles: allProfiles.map(function (p) {
        const filtered = {};
        PUBLIC_PROFILE_FIELDS.forEach(function (f) { filtered[f] = p[f]; });
        return filtered;
      })
    };
  }

  const callback = params.callback;
  if (callback) {
    return ContentService
      .createTextOutput(callback + '(' + JSON.stringify(payload) + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function readSheetAsObjects(ss, name, columns) {
  const sheet = ss.getSheetByName(name);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  const rows = data.slice(1);
  return rows
    .filter(function (r) { return r.some(function (cell) { return cell !== '' && cell !== null; }); })
    .map(function (r) {
      const obj = {};
      columns.forEach(function (col, i) {
        obj[col] = r[i] instanceof Date ? r[i].toISOString() : r[i];
      });
      return obj;
    });
}
