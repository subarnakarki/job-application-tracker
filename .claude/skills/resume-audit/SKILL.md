---
name: resume-audit
description: Audit the user's resume against a job posting (recruiter red flags, XYZ rewrite, ATS score, summary) and optionally build a tailored copy. Use when the user shares a job posting or URL and asks to review, score, tailor or rewrite their resume, check ATS fit, or whether their resume fits a job.
---

# Resume Audit

Four prompts, run in order, each against the resume and one job description.

## Setup (per user, all under the gitignored `resumes/` folder)

- Base resume: put your resume as a Word `.docx` directly in `resumes/` (exactly one `.docx` there), or set
  `RESUME_DOCX` to its path (absolute, `~/`, or repo-relative), e.g. in the `env` block of your
  `.claude/settings.local.json`. Text boxes are not supported, and tracked changes must be accepted or rejected
  in Word first.
- Optional voice rules: `resumes/voice.md`, your style preferences and phrases to avoid. Applied to every rewrite.
- Requires Python 3 (standard library only) and, for the tailored PDF, Microsoft Word on Windows.

`resume.sh` is in `.claude/skills/resume-audit/`; run it with `bash` from the repo root. Its header documents
every command and the edits format.

## Inputs

- Resume text: run `resume.sh text` once per run and use its output for the whole audit (one paragraph per line).
  Do not open the `.docx` with the Read tool, and do not use a resume from memory or a tailored company copy. If
  the script fails, stop and show the user its message (it explains how to set the path).
- Voice rules: read `resumes/voice.md` if it exists.
- The target job description. If the user pastes it, use it as is. If they give a URL, use WebFetch with a prompt
  asking for only the company, title, responsibilities, and requirements (verbatim, no page chrome, benefits, or
  boilerplate). With no posting, use the user's target role profile and say so.

## The four prompts

1. Act as a senior recruiter for this exact company read my resume the way you'd actually read them, skimming for reasons to say no and then tell me the top three red flags a hiring manager spots in [number] seconds
   - Use 6 seconds unless the user gives another number. Fill it in silently; don't echo the bracket.
2. Rewrite my experience section to kill those red flags lead every line with measurable impact using the Google XYZ formula, and strip out every generic phrase
3. Act as both an ATS filter and a hiring manager reading two hundred resumes in one sitting give me a match score out of a hundred and tell me which sections would get skipped and rewrite them so they actually stop
4. Rewrite my summary so a recruiter feels like passing on me would be a mistake

## Rules

- Answer under four headings, one per prompt, without restating the prompts.
- Prompt 1 red flags first, before any rewrite: exactly 3 bullets, about 2 lines each, no preamble. Tag each as a
  real gap or a wording problem.
- No duplicate rewrites. Each section is rewritten once, by the first prompt that touches it: prompt 2 owns
  experience, prompt 4 owns the summary, so prompt 3 rewrites only the other skipped sections (skills, projects,
  headline, etc.). If prompt 3 flags experience or summary, name the issue in one line and point to the prompt 2
  or 4 rewrite (adjusting that rewrite if needed) instead of writing a second version.
- Rewrites are proposals. Never invent metrics, dates, tools, or experience; where a rewrite needs a number the
  resume lacks, flag it and ask.
- Follow `resumes/voice.md` on every rewrite. Without it: plain verbs, real numbers, named tools, no filler.
- The prompt 3 score is a model judgment, not a real ATS result. Say so and give the top reasons.
- Rewrite only the sections that change; don't reprint unchanged resume text back to the user.
- Privacy: never modify the base resume, never `git add` anything under `resumes/`, and never send resume text to
  WebFetch or any other external tool (a job posting fetch sends only the URL).

## After the audit: tailored resume

Ask (AskUserQuestion, yes/no) whether to build a resume for this company. If no, stop. If yes:

1. Settle every open fact (unconfirmed numbers, dates, tools) in one round of questions; drop what isn't confirmed.
2. Slug: the company name in kebab-case (`Acme Corp` → `acme-corp`). If `resumes/<slug>/` already holds a tailored
   `.docx` or `.pdf`, ask before overwriting (then pass `--overwrite`).
3. Show a text preview of only the changed lines and get approval.
4. Write the approved changes to `resumes/<slug>/edits.json` (format in the `resume.sh` header):
   - `{"old": ..., "new": ...}` replaces text. Copy `old` exactly from the `resume.sh text` output; use the
     smallest span that is unique (e.g. a bullet's text without its leading label) so surrounding formatting such
     as a bold company name is kept. `"new": ""` with a whole line deletes it.
   - `{"after": ..., "new": ...}` adds a line after the line containing `after`, with its formatting (bullets).
   - Edits apply in order, so prefer one edit per line. A second edit to the same line must match the text as the
     first edit left it.
   - New text is one plain line: no tabs or line breaks (add separate lines with `after`). An edit can't span a
     tab, line break, symbol (shown as `□`) or non-breaking hyphen; edit the parts on either side instead.
   - If `resumes/voice.md` bans a character or phrase (e.g. em dashes), grep the new texts for it first.
5. Run `resume.sh tailor <slug>`. It checks that the folder is gitignored, applies every edit to a copy (each must
   match exactly once, and each new text must be present and old text gone afterwards), and exports
   `resumes/<slug>/<name>.docx` and `.pdf` via Word. On an edit error, fix `edits.json` and rerun. If Word fails
   or hangs (90-second limit), the edited copy is kept as `<name>.failed.docx`: tell the user and suggest opening
   it in Word. Exit 2 means the tailored resume has more pages than the base: tighten the edits with the user and
   rerun with `--overwrite`.
6. Give the user the full paths to the `.docx` and `.pdf`, and suggest a quick look at the PDF: the script checks
   text and page count, not how it looks.
