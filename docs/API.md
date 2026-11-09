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
|        |                                      |      | saved). 5 a day per user, 200 a day in total                            |
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

| Method | Path                               | Auth   | Notes                                                                 |
| ------ | ---------------------------------- | ------ | --------------------------------------------------------------------- |
| GET    | `/api/job-search/profile`          | user   | `{ available, profile, confirmedAt, hasResume }`                      |
| PUT    | `/api/job-search/profile`          | user   | The confirmed setup (`JobSearchProfileSchema`); fills waiting jobs    |
| POST   | `/api/job-search/runs`             | user   | Runs now: search, read, sort, draft for up to 240 s; 201 with the run |
|        |                                    |        | and its jobs. 409 `not_set_up`, `no_resume` or `run_in_progress`.     |
|        |                                    |        | 10 a day by hand; 50 runs a day in total                              |
| GET    | `/api/job-search/runs`             | user   | The latest 10 runs with counts                                        |
| GET    | `/api/job-search/runs/:id`         | user   | One run and every job it found                                        |
| GET    | `/api/job-search/queue`            | user   | `{ ready, needsYou, finishYourself, keywordOnly, olderMatches,`       |
|        |                                    |        | `notDrafted, checks: { lastCheckedAt, closedThisWeek } }`             |
|        |                                    |        | Ready and Needs you are sorted by `fit` (best first). Each job's      |
|        |                                    |        | `fit` is `{ percent, found, missing }` against the current resume,    |
|        |                                    |        | from the posting keywords its draft kept (null before that)           |
| POST   | `/api/job-search/queue/check`      | user   | Reads each waiting job again (up to 60); a board that says it is gone |
|        |                                    |        | closes it; one whose pay tops out under the salary floor is skipped.  |
|        |                                    |        | `{ checked, closed, unknown, belowFloor }`. 6 a day; the hourly       |
|        |                                    |        | schedule also checks each job about once a day                        |
| POST   | `/api/job-search/hits/:id/track`   | user   | Saves a queue job in the tracker as Saved (or links the match)        |
| POST   | `/api/job-search/hits/:id/applied` | user   | Moves its Saved application to Applied, or creates one (once)         |
| POST   | `/api/job-search/hits/:id/blocked` | user   | `{ reason }`                                                          |
| POST   | `/api/job-search/hits/:id/skip`    | user   |                                                                       |
| POST   | `/api/job-search/hits/:id/closed`  | user   | The job's page says it is closed (only while it is waiting)           |
| POST   | `/api/job-search/hits/:id/tailor`  | user   | Suggested edits of existing resume lines that add the posting's       |
|        |                                    |        | missing keywords, checked by code (an invented line is dropped, a     |
|        |                                    |        | number or name not in the resume is listed in `unverified`); stored   |
|        |                                    |        | as the job's `tailoring`. 409 `no_keywords` (redraft first), 502,     |
|        |                                    |        | 10 a day                                                              |
| POST   | `/api/job-search/hits/:id/queue`   | user   | A keyword-only job becomes a target and is drafted (30 drafts a day)  |
| POST   | `/api/job-search/hits/:id/redraft` | user   | Drafts again                                                          |
| PUT    | `/api/job-search/hits/:id/draft`   | user   | `{ answers: [{ question, answer }], coverLetter }`; answers sent back |
|        |                                    |        | count as the user's; ready once every required one has an answer      |
| GET    | `/api/resume/text`                 | user   | The stored resume text, for forms without a file upload               |
| POST   | `/api/cron/job-search`             | public | Needs `x-cron-secret` = `JOB_SEARCH_CRON_SECRET` (32+ characters),    |
|        |                                    |        | else 404. Starts each due scheduled run (once per local day), then    |
|        |                                    |        | keeps drafting. Called hourly by the "Job search schedule" workflow   |

**Boards.** Searched and filled: Greenhouse, Lever, Ashby, Rippling, SmartRecruiters, Breezy HR, Recruitee,
Teamtailor, Personio, Workable and Jobvite. Searched and listed to finish by hand (they need an account): Workday,
iCIMS, Taleo and SuccessFactors. A query without `site:` searches them all. When a job's page cannot be read
(Workable often refuses, some pages are drawn by script), the job is kept from its search result's title and age.

**United States only** (on by default): a job is skipped when its country, or else its location, is clearly
outside the US (`locationVerdict` in `shared/`); a job in several places counts when any is in the US, and one
that only says "Remote" is kept with a note to check it. The search itself is also asked for US jobs.

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

## Model usage

Every Claude call records one row in `model_usage` (migration 0013): the kind of call (`job_search`, `draft`,
`tailor`, `classify_email`, `posting_keywords`, `resume_analysis`), the model that answered, and its input,
cache-write, cache-read and output tokens and web searches. No user and no text are stored. A failed write is
logged and never fails the call. Cost per kind of call, at Claude Opus 5.5 prices ($4 input, $5 cache write,
$0.40 cache read, $20 output per million tokens; web search $10 per 1,000):

```sql
select call, count(*) as calls,
  round(sum(input_tokens * 4 + cache_write_tokens * 5 + cache_read_tokens * 0.4 + output_tokens * 20)
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
