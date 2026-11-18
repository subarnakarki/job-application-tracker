---
name: resume-red-flag-audit
description: Run the four prompt resume audit from the Cody Brooks reel on a resume plus a target job description: recruiter red flag scan, XYZ rewrite of experience, ATS and hiring manager scoring with skipped section fixes, and a summary rewrite. Use when the user asks to run these prompts, audit a resume against a posting, or check a resume the way a recruiter would.
---

# Resume Red Flag Audit

Source: Instagram reel by @codybrooks.ai (DfPxljOsGh-, posted 2026-11-02), prompts transcribed from the video on 2026-11-18. The method runs four prompts in order against a resume and a specific job description, both supplied as inputs to each prompt.

## Inputs

- The resume (current canonical version unless the user names another).
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
- Show a preview of any resume change and apply it only after the user approves.
- Keep the user's voice rules on every rewrite: plain verbs, real numbers, named tools, no em dashes, no phrases he has struck before ("influence without authority", "cross-functional leadership", "developer productivity", "hands-on enablement").
- After any approved rebuild, verify: 2 pages, 0 private-use characters, 0 em dashes.
- The match score from prompt 3 is a model judgment, not an ATS result. Report it as such, with the top reasons, and do not present it as a measured score from a real system.
