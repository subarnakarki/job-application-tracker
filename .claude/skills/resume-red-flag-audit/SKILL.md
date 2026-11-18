---
name: resume-red-flag-audit
description: Run the four prompt resume audit from the Cody Brooks reel on the user's resume (always subarna-karki-resume.pdf at the repo root) plus a target job description: recruiter red flag scan, XYZ rewrite of experience, ATS and hiring manager scoring with skipped section fixes, and a summary rewrite. Afterwards, offer to build a tailored copy of the resume in a gitignored folder named for the company. Use when the user asks to run these prompts, audit a resume against a posting, or check a resume the way a recruiter would.
---

# Resume Red Flag Audit

Source: Instagram reel by @codybrooks.ai (DfPxljOsGh-, posted 2026-11-02), prompts transcribed from the video on 2026-11-18. The method runs four prompts in order against a resume and a specific job description, both supplied as inputs to each prompt.

## Inputs

- The resume: always `C:\Users\Subarna\Documents\github\job-application-tracker\subarna-karki-resume.pdf`
  (`subarna-karki-resume.pdf` at the repo root). Read it fresh at the start of every run, with the Read tool
  (or `pdftotext -layout`), and base the whole audit on that text. Do not use a resume from memory, an earlier
  conversation, or a previously tailored company copy. If the file is missing or unreadable, stop and tell the user.
- The target job description, full text from the company's own posting.
- If no specific posting is given, run it against the user's target role profile instead and say so.

## The four prompts (run in this order)

1. Act as a senior recruiter for this exact company read my resume the way you'd actually read them, skimming for reasons to say no and then tell me the top three red flags a hiring manager spots in [number] seconds
   - Note: the number before "seconds" was cropped in the source video and could not be read. Use 6 unless the user says otherwise (the standard recruiter skim figure), and tell the user it was unreadable in the source.
2. Rewrite my experience section to kill those red flags lead every line with measurable impact using the Google XYZ formula, and strip out every generic phrase
3. Act as both an ATS filter and a hiring manager reading two hundred resumes in one sitting give me a match score out of a hundred and tell me which sections would get skipped and rewrite them so they actually stop
4. Rewrite my summary so a recruiter feels like passing on me would be a mistake

## How to run it for this user

- Present the prompt 1 red flags first, plainly, before any rewrite. Separate real gaps from wording problems.
- Prompt 2 and 3 rewrites are proposals only. Never invent facts: no metrics, dates, tools, or experience the user has not confirmed. Where a rewrite needs a number the resume does not have, flag it and ask instead of filling it in.
- Keep the user's voice rules on every rewrite: plain verbs, real numbers, named tools, no em dashes, no phrases the user has struck before ("influence without authority", "cross-functional leadership", "developer productivity", "hands-on enablement").
- The match score from prompt 3 is a model judgment, not an ATS result. Report it as such, with the top reasons, and do not present it as a measured score from a real system.
- Never modify the original `subarna-karki-resume.pdf`. Tailored versions only go in a company folder (below).

## After the audit: offer a tailored resume

When all four prompts are done, ask the user (AskUserQuestion) whether to create a new resume for this company
from the audit. Options: yes, or no. If no, stop there.

If yes:

1. Settle open facts first. Any rewrite that needed a number, date, or tool the resume does not have must be
   confirmed or dropped before building. Ask these in one round, not one at a time.
2. Folder: a kebab-case slug of the company name at the repo root, for example `Acme Corp` becomes `acme-corp/`.
   If the folder already exists, ask before overwriting anything in it.
3. Make it gitignored: write `acme-corp/.gitignore` containing a single line `*`. That ignores the folder and
   everything in it (including the `.gitignore` itself), so the root `.gitignore` does not change and nothing
   needs committing. Confirm with `git status --porcelain` that the folder does not show up and
   `git check-ignore -v acme-corp/subarna-karki-resume.pdf` that it is ignored.
4. Build the resume as `acme-corp/subarna-karki-resume.pdf` (the original file name). Start from the original
   resume's full text and layout (letter size, same section order and styling as closely as possible), then apply
   only the rewrites the user approved in this run. Show a text preview of the changed sections and get approval
   before writing the PDF.
   - Build route: write the source into the company folder (`resume.html` with inline CSS, print styles,
     `@page { size: letter; }`), then print it to PDF with headless Edge or Chrome, for example
     `"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless --disable-gpu --no-pdf-header-footer --print-to-pdf="<abs path>/acme-corp/subarna-karki-resume.pdf" "file:///<abs path>/acme-corp/resume.html"`.
     If LibreOffice and python-docx are available, building a `.docx` and converting with
     `soffice --headless --convert-to pdf` (how the original was made) is fine too.
5. Verify the PDF (`pdfinfo` for page count, `pdftotext` for text): 2 pages, 0 private-use characters,
   0 em dashes, and every approved change present. Fix and rebuild until it passes, then give the user the full
   path to the new file.
