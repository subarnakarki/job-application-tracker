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
| GET    | `/api/import/gmail/start`       | user | 302 to Google for read-only Gmail access; 3 per day per user          |
| GET    | `/api/import/gmail/callback`    | user | Runs the import, then 302 to `/import/<runId>` (or `/account?import=` |
|        |                                 |      | with a reason code)                                                   |
| GET    | `/api/import/runs/:id`          | user | The run and each email's outcome (never the email body)               |
| POST   | `/api/import/items/:id/undo`    | user | Reverse a create or status change; 409 if the application was edited  |
|        |                                 |      | since                                                                 |
| POST   | `/api/import/items/:id/apply`   | user | Make a review item's proposed change                                  |
| POST   | `/api/import/items/:id/dismiss` | user | Hide a review item                                                    |

An import reads up to 50 job emails from the last 30 days (or since the last import). Claude classifies each one
on its own into a fixed shape (kind, company, role, confidence, summary) and the server decides the change:
a confident confirmation adds an application, a confident interview, assessment, offer or rejection moves the one
matching open application forward. Anything uncertain, ambiguous, backwards or closed goes to review.
Imported changes are recorded with actor `gmail`. Item actions answer 409 `import_conflict` when not possible.

## Health

`GET /api/health` (never touches the database) and `GET /api/health/db` (proves the database answers).
