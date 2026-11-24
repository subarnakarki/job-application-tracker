# API reference

Base path `/api`. JSON in and out. Writes must be same-origin and send `Content-Type: application/json`
(see [AUTH.md](AUTH.md)). Every response is `Cache-Control: no-store`. Response shapes are the strict zod
schemas in `shared/src/responses.ts`; input shapes are in `shared/src/schemas.ts`.

## Errors

`{ "error": "<code>", "message": "...", "issues"?: [{ "path": "salaryMax", "message": "..." }] }`

| Status | Code                     | When                                                                |
| ------ | ------------------------ | ------------------------------------------------------------------- |
| 400    | `validation_error`       | Input fails the schema; `issues` lists every problem                |
| 400    | `invalid_if_match`       | `If-Match` is present but not `"<version>"`                         |
| 401    | `unauthenticated`        | No valid session on a signed-in route                               |
| 403    | `cross_site_request`     | A write that is not same-origin                                     |
| 403    | `demo_restricted`        | Export or account deletion attempted by the shared demo account     |
| 404    | `not_found`              | Missing, someone else's, or malformed id (one answer for all three) |
| 409    | `limit_reached`          | 500 applications per user (30 for the demo account)                 |
| 412    | `version_conflict`       | `If-Match` is stale; the response `ETag` holds the current version  |
| 415    | `unsupported_media_type` | A request body that is not JSON                                     |
| 428    | `precondition_required`  | `PATCH` without `If-Match`                                          |
| 429    | `rate_limited`           | Too many attempts; see `Retry-After`                                |
| 5xx    | `internal_error`         | Anything unexpected; the body never carries details                 |

## Session

| Method | Path               | Auth   | Notes                                                             |
| ------ | ------------------ | ------ | ----------------------------------------------------------------- |
| POST   | `/api/auth/demo`   | public | Sign in as the shared demo account; 30/hour per address           |
| POST   | `/api/auth/logout` | public | 204, clears the cookie; idempotent                                |
| GET    | `/api/me`          | user   | `{ user }`                                                        |
| PATCH  | `/api/me`          | user   | `{ timeZone }` (IANA name)                                        |
| GET    | `/api/me/export`   | user   | Everything about the user as a JSON download (not for the demo)   |
| DELETE | `/api/me`          | user   | Body `{ "confirm": "delete my account" }`; 204 (not for the demo) |

## Applications

| Method | Path                    | Auth | Notes                                                                      |
| ------ | ----------------------- | ---- | -------------------------------------------------------------------------- |
| POST   | `/api/applications`     | user | 201, `Location`, `ETag: "1"`, the detail with its first history entry      |
| GET    | `/api/applications/:id` | user | The detail (application + `history`), `ETag: "<version>"`                  |
| PATCH  | `/api/applications/:id` | user | Requires `If-Match`. Absent field = unchanged, `null` = clear. A save that |
|        |                         |      | changes nothing returns 200 with the same version and does not reset the   |
|        |                         |      | follow-up clock. A status change appends one history entry.                |
| DELETE | `/api/applications/:id` | user | 204                                                                        |

### Job postings

| Method | Path                                     | Auth | Notes                                                                   |
| ------ | ---------------------------------------- | ---- | ----------------------------------------------------------------------- |
| POST   | `/api/postings/preview`                  | user | `{ url }`: reads a public job posting and returns what it found (job    |
|        |                                          |      | link, company, role, salary, location, work mode, posted on); saves     |
|        |                                          |      | nothing. 422 when the site cannot be read (sign-in sites, no details)   |
| POST   | `/api/applications/:id/suggestion/apply` | user | Requires `If-Match`. Fills only the empty fields from the posting found |
|        |                                          |      | on a job board, then removes the suggestion; 404 when there is none     |
| DELETE | `/api/applications/:id/suggestion`       | user | 204; removes the suggestion and changes nothing else                    |

`postingSuggestion` on the detail is a posting an import found on the company's public job board (Greenhouse,
Lever, Ashby, Rippling, SmartRecruiters, Breezy HR, Recruitee, Teamtailor or Personio) when the email had no
link (or that "Find posting" found), or `null`. It is never applied without the user.

Writes are limited to 600/hour per user (120/hour for the demo account). `needsFollowUp` and `isClosed` are
computed on every response, in the user's time zone (rules in [DOMAIN.md](DOMAIN.md)).

## Stats

`GET /api/stats` (user): for each of the six sources, in order, and in total: applications, applied, responded,
interviewing, offers, and `responseRate` (responded / applied, `null` when nothing was applied for). Counted over
each application's whole status history; rules in [DOMAIN.md](DOMAIN.md).

## Gmail import

Owner only: starting an import answers 404 unless the user is on `GMAIL_IMPORT_USER_IDS` (never the demo
account) and Google and the classifier (`ANTHROPIC_API_KEY`) are configured. The flow is in [AUTH.md](AUTH.md).

| Method | Path                            | Auth | Notes                                                                 |
| ------ | ------------------------------- | ---- | --------------------------------------------------------------------- |
| GET    | `/api/import/status`            | user | `{ available }`: whether this user may start an import                |
| GET    | `/api/import/gmail/start`       | user | 302 to Google for read-only Gmail access                              |
| GET    | `/api/import/gmail/callback`    | user | Runs the import, then 302 to `/import/<runId>` (or `/account?import=` |
|        |                                 |      | with a reason code)                                                   |
| GET    | `/api/import/runs`              | user | Your recent imports, newest first, with changed / to review / skipped |
| GET    | `/api/import/runs/:id`          | user | The run and each email's outcome (never the email body)               |
| POST   | `/api/import/items/:id/undo`    | user | Reverse a create or status change; 409 if the application was edited  |
|        |                                 |      | since                                                                 |
| POST   | `/api/import/items/:id/apply`   | user | Make a review item's proposed change                                  |
| POST   | `/api/import/items/:id/dismiss` | user | Hide a review item                                                    |

An import reads up to 50 job emails from the last 30 days (or since the last import). Claude classifies each one
on its own into a fixed shape (kind, company, role, confidence, summary) and the server decides the change:
a confident confirmation adds an application, a confident interview, assessment, offer or rejection moves the one
matching open application forward. Anything uncertain, ambiguous, backwards or closed goes to review.
When a confirmation creates an application, the server also reads the job posting the email links to (known job
boards only) and fills the empty fields; with no link, it looks for the role on the company's public job board
and saves a match as a suggestion. Imported changes are recorded with actor `gmail`. Item actions answer 409 `import_conflict` when not possible.

## Resume match

| Method | Path                                 | Auth | Notes                                                                   |
| ------ | ------------------------------------ | ---- | ----------------------------------------------------------------------- |
| GET    | `/api/resume`                        | user | `{ resume, analysisAvailable }`; `resume` is null when none is stored   |
| PUT    | `/api/resume`                        | user | `{ kind: "file", fileName, dataBase64 }` (PDF or DOCX, 2 MB, type from  |
|        |                                      |      | the bytes) or `{ kind: "text", text }`; replaces the one resume. 413,   |
|        |                                      |      | 415, 422 (`no_text` for a scanned PDF, `too_many_pages` over 10). Not   |
|        |                                      |      | for the demo. 20 an hour                                                |
| DELETE | `/api/resume`                        | user | 204; analyses are kept                                                  |
| GET    | `/api/resume/file`                   | user | The stored file (`application/pdf` or DOCX); 404 for pasted text        |
| POST   | `/api/resume/analyses`               | user | Claude reads the resume as a senior recruiter: 201 with up to 20 ranked |
|        |                                      |      | titles, each with keywords marked `found` by code. The same text within |
|        |                                      |      | a day answers 200 with the saved analysis. 409 `no_resume`, 404         |
|        |                                      |      | `not_available` (no Anthropic key), 502 `analysis_failed` (nothing      |
|        |                                      |      | saved). 1 a day per user (5 for the owner, `JOB_SEARCH_USER_IDS`),      |
|        |                                      |      | shared with resume checks; 200 a day in total                           |
| GET    | `/api/resume/analyses`               | user | The newest 5, each with its top three titles                            |
| GET    | `/api/resume/analyses/:id`           | user | One analysis                                                            |
| DELETE | `/api/resume/analyses/:id`           | user | 204                                                                     |
| POST   | `/api/applications/:id/resume-match` | user | Reads the job link, asks Claude for the keywords that posting asks for, |
|        |                                      |      | and marks each found or missing in the resume: `{ keywords, found,      |
|        |                                      |      | matchPercent }`. Saves nothing. 422 `no_job_link` or an unreadable      |
|        |                                      |      | posting. Counts against the link budget and the analysis limits         |

The resume file and its text are kept until the user replaces or deletes them (or the account); the JSON export
describes the resume and includes every analysis, never the text. Logs hold only outcomes, sizes and timings.

## Job search (owner only)

Open to the users in `JOB_SEARCH_USER_IDS` when `ANTHROPIC_API_KEY` is set; every route below answers 404
`not_available` to anyone else (and to the demo account).

| Method | Path                               | Auth   | Notes                                                                  |
| ------ | ---------------------------------- | ------ | ---------------------------------------------------------------------- |
| GET    | `/api/job-search/profile`          | user   | `{ available, profile, confirmedAt, hasResume }`                       |
| PUT    | `/api/job-search/profile`          | user   | The confirmed setup (`JobSearchProfileSchema`); fills waiting jobs     |
| POST   | `/api/job-search/runs`             | user   | Runs now: search, read, sort, draft for up to 240 s; 201 with the run  |
|        |                                    |        | and its jobs. 409 `not_set_up`, `no_resume` or `run_in_progress`.      |
|        |                                    |        | 10 a day by hand; 50 runs a day in total                               |
| GET    | `/api/job-search/runs`             | user   | The latest 10 runs with counts                                         |
| GET    | `/api/job-search/runs/:id`         | user   | One run and every job it found                                         |
| GET    | `/api/job-search/queue`            | user   | `{ ready, needsYou, finishYourself, keywordOnly, olderMatches,`        |
|        |                                    |        | `notDrafted, checks: { lastCheckedAt, closedThisWeek } }`              |
|        |                                    |        | Ready and Needs you are sorted by `fit` (best first); the page shows   |
|        |                                    |        | them newest posting first unless asked for best fit. Each job's        |
|        |                                    |        | `fit` is `{ percent, found, missing }` against the current resume,     |
|        |                                    |        | from the posting keywords its draft kept (null before that)            |
| POST   | `/api/job-search/queue/check`      | user   | Reads each waiting job again (up to 60); a board that says it is gone  |
|        |                                    |        | closes it; one whose pay tops out under the salary floor is skipped.   |
|        |                                    |        | `{ checked, closed, unknown, belowFloor }`. 6 a day; the hourly        |
|        |                                    |        | schedule also checks each job about once a day                         |
| POST   | `/api/job-search/hits/:id/track`   | user   | Saves a queue job in the tracker as Saved (or links the match)         |
| POST   | `/api/job-search/hits/:id/applied` | user   | Moves its Saved application to Applied, or creates one (once)          |
| POST   | `/api/job-search/hits/:id/blocked` | user   | `{ reason }`                                                           |
| POST   | `/api/job-search/hits/:id/skip`    | user   |                                                                        |
| POST   | `/api/job-search/hits/:id/closed`  | user   | The job's page says it is closed (only while it is waiting)            |
| POST   | `/api/job-search/hits/:id/tailor`  | user   | Suggested edits of existing resume lines that add the posting's        |
|        |                                    |        | missing keywords, checked by code (an invented line is dropped, a      |
|        |                                    |        | number or name not in the resume is listed in `unverified`); stored    |
|        |                                    |        | as the job's `tailoring`. 409 `no_keywords` (redraft first), 502,      |
|        |                                    |        | 10 a day                                                               |
| POST   | `/api/job-search/hits/:id/queue`   | user   | A keyword-only job becomes a target and is drafted (30 drafts a day)   |
| POST   | `/api/job-search/hits/:id/redraft` | user   | Drafts again                                                           |
| PUT    | `/api/job-search/hits/:id/draft`   | user   | `{ answers: [{ question, answer }], coverLetter }`; answers sent back  |
|        |                                    |        | count as the user's; ready once every required one has an answer       |
| GET    | `/api/resume/text`                 | user   | The stored resume text, for forms without a file upload                |
| POST   | `/api/cron/job-search`             | public | Needs `x-cron-secret` = `JOB_SEARCH_CRON_SECRET` (32+ characters),     |
|        |                                    |        | else 404. Starts each due scheduled run (once per local day; a failed  |
|        |                                    |        | run is tried again on later knocks, at most 3 tries a day), then       |
|        |                                    |        | keeps drafting; a job whose draft failed 3 times moves to Needs you.   |
|        |                                    |        | Also deletes expired sessions and rate-limit windows. One user's       |
|        |                                    |        | error is logged and the rest still run. On a knock with no run due,    |
|        |                                    |        | every watched board is read for new jobs (the hourly sweep, below).    |
|        |                                    |        | `{ started, drafted, failed, found }`. Called four times an hour       |
|        |                                    |        | (minutes 2, 17, 32, 47) by the "Job search schedule" workflow          |
| GET    | `/api/job-search/boards`           | user   | The companies watched: `{ items, total }`, read longest ago first      |
| POST   | `/api/job-search/boards`           | user   | `{ link }`: a careers board (Greenhouse, Lever, Ashby, Workday) or any |
|        |                                    |        | job on a readable board. The list is read once to check it. 201; 422   |
|        |                                    |        | `unsupported_board` or `board_unreadable`; 409 at 500; 40 a day        |
| DELETE | `/api/job-search/boards/:id`       | user   | Stops watching (jobs already found stay). 204                          |

**The hourly sweep.** Web search returns pages indexed days ago; a company's own board lists a job the day it is
posted. So every board a search finds (and every company added by hand) is kept in `job_search_boards`, and each
hourly knock without a due run reads them all, the ones read longest ago first, for at most 60 seconds: the public
list APIs of Greenhouse, Lever, Ashby, Rippling, SmartRecruiters, Breezy HR, Recruitee, Teamtailor and Personio,
and each Workday site's own job-list request (a guarded JSON POST, newest postings first, up to three pages). A
new job whose title matches is read, sorted and saved under a run with trigger `sweep` (no run is recorded when
nothing is new), then drafted on the same knock. No model is called unless a new job matches. A wanted title
matches in any word order ("QA automation engineer" matches "Automation QA Engineer").

**Boards.** Searched and filled: Greenhouse, Lever, Ashby, Rippling, SmartRecruiters, Breezy HR, Recruitee,
Teamtailor, Personio, Workable and Jobvite. Searched and listed to finish by hand (they need an account): Workday,
iCIMS, Taleo and SuccessFactors. A query without `site:` searches them all. When a job's page cannot be read
(Workable often refuses, some pages are drawn by script), the job is kept from its search result's title and age.

**Search model.** The search call uses `JOB_SEARCH_SEARCH_MODEL` when it is set to a model id (for example
`claude-haiku-5-5`), else the job search model; a Haiku model gets the basic web search tool and no server-side
fallback, which it does not support. `model_usage` records the model of each call, so a trial can be compared with
the weeks before it. Each search turn is cached, so a paused turn sent again reads its search results from the
cache, and the search stops starting turns once the run's deadline is near.

**United States only** (on by default): a job is skipped when its country, or else its location, is clearly
outside the US (`locationVerdict` in `shared/`); a job in several places counts when any is in the US, and one
that only says "Remote" is kept with a note to check it. The search itself is also asked for US jobs.

**Commute area** (`commuteArea` on the profile; empty means no such rule): a remote job can be anywhere, a hybrid
or on-site job is kept only when its location names a place in the area, in the user's state or with no state
given (`commuteVerdict`); elsewhere, or with a location that cannot be placed, it is skipped with the reason. With
hybrid or on-site wanted, each run adds one search near home (the first titles plus "Charlotte, NC"). When the
board does not say how a job is worked, a clear statement in the posting's text counts (`workModeInText`), and the
draft call returns the work mode and location it read in the posting: a waiting job that turns out to be ruled out
is skipped, "(read in the posting)", instead of drafted. A job whose mode nothing states is kept.

**Who answers what.** Contact details, work authorization, sponsorship, salary, relocation, start date, how you
heard, age and every demographic or EEO question are answered from the profile by code
(`profileQuestionKind` in `shared/`); the model never sees them. The model drafts the rest from the resume
only, and anything it cannot support is marked `needs_you`.

**More answers (optional).** The profile's `more` answers (company history, clearance, export control,
"U.S. Person", legal name, W2, SMS consent, travel, pronouns and others) answer their questions the same way,
with the option picked by meaning (`profileFill`); one left blank leaves its question to the model, as before.
Saving the setup fills the needs-you answers those answers now cover on every drafted job still in the queue
(`refillDraft`, no model call), never touching answers the user typed, and moves a job with no required
question left to Ready. Greenhouse publishes each form's questions
(`questions=true`); Lever and Ashby do not, so their jobs carry the profile, standard answers, a cover letter
and "why this job".

## LinkedIn messages to a lead (owner only)

| Method | Path                                      | Auth | Notes                                                                |
| ------ | ----------------------------------------- | ---- | -------------------------------------------------------------------- |
| POST   | `/api/applications/:id/lead-message`      | user | `{ leadId, kind, steer? }`: drafts a connection note (at most 200    |
|        |                                           |      | characters) and a message (at most 1,000) from the job, the lead and |
|        |                                           |      | their newest notes, and the resume. Stores nothing. 30 a day; 409    |
|        |                                           |      | `no_resume`; 502 `draft_failed`                                      |
| POST   | `/api/applications/:id/lead-message/sent` | user | `{ leadId, text }`: logs the message as a dated note on the lead,    |
|        |                                           |      | links the lead to the application and counts as activity. The same   |
|        |                                           |      | text twice on one day is saved once                                  |

Open to the same users as the job search (`JOB_SEARCH_USER_IDS`), never the demo account. The app cannot send
LinkedIn messages: the owner copies one, opens the lead's profile and sends it. A lead from another account, in
the path or the body, gets 404.

## A resume tailored to an application (owner only)

| Method | Path                                       | Auth | Notes                                                        |
| ------ | ------------------------------------------ | ---- | ------------------------------------------------------------ |
| GET    | `/api/applications/:id/tailoring`          | user | `{ tailoring, keywords, hasPostingText, saved }`: the last   |
|        |                                            |      | suggestions and the version saved for this job               |
|        |                                            |      | (`resumeChanged` when the resume was replaced since)         |
| POST   | `/api/applications/:id/tailor`             | user | `{ postingText? }`: reads the job link (or the stored or     |
|        |                                            |      | pasted posting) and asks Claude once for the keywords and    |
|        |                                            |      | edits. 422 `no_job_link` or `posting_unreadable`: paste it.  |
|        |                                            |      | 10 a day, shared with the queue's tailoring                  |
| PUT    | `/api/applications/:id/tailored-resume`    | user | `{ text }`: saves this job's version and its changes from    |
|        |                                            |      | the resume, line by line                                     |
| DELETE | `/api/applications/:id/tailored-resume`    | user | Removes the saved version; the suggestions stay              |
| POST   | `/api/job-search/hits/:id/tailored-resume` | user | `{ text }`: from the queue; tracks the job as Saved if       |
|        |                                            |      | needed, then saves the version (and the queue's suggestions) |
|        |                                            |      | on its application                                           |

Stored in `application_tailorings`, deleted with the application and included in the data export (posting text
too).

## A cover letter for an application (owner only)

| Method | Path                                       | Auth | Notes                                                           |
| ------ | ------------------------------------------ | ---- | --------------------------------------------------------------- |
| GET    | `/api/applications/:id/cover-letter`       | user | `{ coverLetter, hasPostingText }`: the letter (text, length,    |
|        |                                            |      | tone, steer, `draftedAt`, `savedAt` null while a draft,         |
|        |                                            |      | `resumeChanged` when the resume was replaced since), or null    |
| POST   | `/api/applications/:id/cover-letter/draft` | user | `{ postingText?, steer?, length?, tone? }` (defaults: standard, |
|        |                                            |      | professional): the posting is the pasted one, else the one      |
|        |                                            |      | stored with the letter, else the one stored by Tailor my        |
|        |                                            |      | resume, else the job link read. The greeting comes from the     |
|        |                                            |      | contact when it starts with a name, else "Dear Hiring           |
|        |                                            |      | Manager,". Asked once more when it runs long, then cut at 5,000 |
|        |                                            |      | characters. Replaces the letter as an unsaved draft. 409        |
|        |                                            |      | `no_resume`, 422 `no_job_link` or `posting_unreadable`, 20 a    |
|        |                                            |      | day, 502 `draft_failed`                                         |
| PUT    | `/api/applications/:id/cover-letter`       | user | `{ text }` (at most 5,000 characters): saves it as edited; also |
|        |                                            |      | a letter written by hand with no draft                          |
| DELETE | `/api/applications/:id/cover-letter`       | user | Removes the letter and the posting stored with it               |

Tones: `professional`, `warm`, `enthusiastic`, `direct`, each a fixed instruction in the prompt; lengths: `short`
(about 150 words) and `standard` (about 300). Stored in `application_cover_letters` (migration 0019), apart from
the application (its `version` and follow-up clock do not change), deleted with it and included in the data
export.

Tracking a queue job (Track it, Mark applied, or saving its resume from the queue) copies the queue's drafted
letter to the application as a saved, short, professional letter with no resume behind it, unless the
application already has a letter (drafted or saved), which is never replaced.

## When Anthropic's limits are reached

Any route that calls Claude answers **503** when Anthropic declines for capacity or money rather than for the
request (`server/src/anthropic/limits.ts`, told apart by the SDK's error type and `error.details.error_code`):

| Anthropic says                                                                                    | Code                   | `retry-after`                         |
| ------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------- |
| 429 rate or ramp limit                                                                            | `claude_busy`          | Anthropic's, else 60 s                |
| 529 overloaded                                                                                    | `claude_busy`          | Anthropic's, else 120 s               |
| 429 `enforced_spend_limit_reached`, 400 "You have reached your specified … API usage limits", 402 | `claude_limit_reached` | None: it lasts until the limit resets |

A scheduled or manual job search stops at the first one: the run is marked failed with the reason, the jobs it
found are kept, and no job loses a draft attempt (the next run or hourly knock drafts them). The hourly knock
stops for every user, since the limit is the whole account's. A Gmail import stops and leaves its emails for the
next import. Any other API error (a 500, a dropped connection) stays a soft failure, as before. The app's own
daily allowances are still spent by a call Anthropic declines.

## Model usage

**Token efficiency.** Drafting, tailoring and lead messages send the resume as the first block of the request,
marked for prompt caching: with the system prompt before it, it is the same in every request a user makes, so
the next one within five minutes (the next draft in a run) reads it at a tenth of the input price. Posting
text has its legal boilerplate removed before it is sent (`server/src/postings/trim.ts`: equal-opportunity,
accommodation, E-Verify, privacy and agency notices). The job search is not cached: in real runs (2026-11-09)
each query finished in one turn, so nothing is resent, and caching would only add the cache-write cost to its
search results.

Every Claude call records one row in `model_usage` (migration 0013): the kind of call (`job_search`, `draft`,
`tailor`, `classify_email`, `posting_keywords`, `resume_analysis`, `lead_message`,
`cover_letter`), the model that answered, and its input,
cache-write, cache-read and output tokens and web searches. No user and no text are stored. A failed write is
logged and never fails the call. Cost per kind of call, at Claude Haiku 5.5 prices for prompts up to 100K tokens ($0.10 input,
$0.125 cache write, $0.01 cache read, $0.50 output per million tokens; web search $10 per 1,000):

```sql
select call, count(*) as calls,
  round(sum(input_tokens * 0.1 + cache_write_tokens * 0.125 + cache_read_tokens * 0.01 + output_tokens * 0.5)
    / 1e6 + sum(web_searches) * 0.01, 2) as usd,
  round(avg(input_tokens)) as avg_in, round(avg(output_tokens)) as avg_out, sum(web_searches) as searches
from model_usage where created_at > now() - interval '7 days'
group by call order by usd desc;
```

## Health

`GET /api/health` (never touches the database) and `GET /api/health/db` (proves the database answers).

**One import at a time:** a user can have only one import running. The check and the new run are made together
under a per-user database lock, so two requests at the same moment cannot both start. While one runs, `start`
and the callback redirect to `/account?import=import_running` without asking Google or Gmail for anything. A run
still marked running after 10 minutes is taken as dead (the function limit is 300 s) and marked failed, so a
crash cannot block imports for ever.
