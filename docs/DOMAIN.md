# Domain rules

These rules are implemented once in `shared/` (pure functions, no I/O) and covered by tests there. The API, the
SQL filter and the UI all reuse them. If a rule changes, change it here, in the code, and in the tests together.

## Statuses

`Saved`, `Applied`, `Screening`, `Interviewing`, `Offer`, `Rejected`, `Withdrawn`.
**Closed** = `Rejected` or `Withdrawn`. Closed applications stay in the default list, shown muted.

Any status may move to any other status (a Rejected application can be reopened).

## Needs follow-up (`needsFollowUp`)

Flagged when **all** of these hold:

1. status is `Applied`, `Screening` or `Interviewing`;
2. **7 or more calendar days** have passed since the last activity;
3. there is **no upcoming next step**: `nextStepDate` is empty or before today.

"Days" are calendar days in the **user's time zone**, compared as dates (not 24-hour spans), so activity at 23:59
a week ago counts the same as activity at 00:00 that day. A next-step date of **today counts as upcoming**.

| Last activity (today = 2026-11-05, UTC) | Days | Flagged (Applied, no next step) |
| --------------------------------------- | ---- | ------------------------------- |
| 2026-11-05 14:00                        | 0    | no                              |
| 2026-10-30 23:59                        | 6    | no                              |
| 2026-10-29 23:59                        | 7    | **yes**                         |
| 2026-10-29 00:00                        | 7    | **yes**                         |
| 2026-10-28                              | 8    | **yes**                         |
| 2026-11-06 (clock skew)                 | -1   | no                              |

| `nextStepDate` (today = 2026-11-05) | Flagged (stale Applied) |
| ----------------------------------- | ----------------------- |
| none                                | **yes**                 |
| 2026-11-04 (yesterday)              | **yes**                 |
| 2026-11-05 (today)                  | no                      |
| 2026-11-06 or later                 | no                      |

Statuses: `Applied`, `Screening`, `Interviewing` can be flagged. `Saved`, `Offer`, `Rejected`, `Withdrawn` never.

**The follow-up clock** is `lastActivityAt`: any real user edit resets it. A save that changes nothing does not
(`changedFields` returns no keys), and neither do system writes such as imports.

**Time zone:** an IANA name (for example `America/New_York`) set at first login and editable in settings, never
sent per request. Default `UTC`. Offsets like `+05:00` are rejected (Postgres reads them with flipped signs).

## History and `dateApplied`

- Creating an application writes one history row `null -> initial status`.
- A change of status writes one row `from -> to`. Saving the same status writes nothing.
- History is append-only. No back-dating in the MVP: rows use the time of the change.
- `dateApplied` is filled with **today** when the application first reaches `Applied`, `Screening`,
  `Interviewing`, `Offer` or `Rejected` (including being created directly in one of them) **and** the field is
  empty. It never overwrites a date and is not refilled on moves within that group. `Withdrawn` does not fill it,
  because an application can be withdrawn before it was sent. Moving `Withdrawn -> Applied` does fill it.

## Input rules (zod, `shared/src/schemas.ts`)

- Create needs `company` and `role`; everything else defaults (`status: Saved`, `source: Other`, `notes: ''`,
  other fields `null`). Unknown keys are rejected, so clients cannot set `id`, `userId`, timestamps, `version`.
- Patch: every field optional. **Absent = leave unchanged, `null` = clear.** `company`, `role`, `status`,
  `source` and `notes` cannot be `null` (clear notes with `''`).
- Single-line text (`company`, `role`, `contact`, `nextStep`) is trimmed and may not contain control characters.
  An empty optional text is stored as `null`. `notes` keeps newlines and is not trimmed.
- `dateApplied` / `nextStepDate`: a real date as `YYYY-MM-DD`.
- `jobLink`: `http` or `https` only, no embedded credentials, so it is safe to render as a link.
- Salary: `salaryMin` / `salaryMax` whole numbers >= 0; max must not be below min; any amount needs a 3-letter
  upper-case `salaryCurrency`. Pairing against stored values is checked by the API on the merged record
  (`findSalaryIssues`).
- Limits (`LIMITS` in `shared/src/constants.ts`): 500 applications per user (30 for the demo user), company and
  role 200, contact 200, next step 500, link 2000, notes 10,000, search 200.

## Defined later

- Search: case-insensitive over company, role, contact and notes; each word must match somewhere; `%`, `_`, `\` escaped.
- CSV export: respects the current filters; UTF-8 BOM; UTC ISO-8601 timestamps; cells starting with `=`, `+`, `-`,
  `@`, tab or CR are neutralised.
- "Responded" (stats): ever reached `Screening` or beyond, or `Rejected` after `Applied`.
