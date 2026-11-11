import { useEffect } from 'react';
import { Link, useParams } from 'react-router';
import { useApplication, useApplicationCoverLetter } from '../api/hooks';

/** The letter's paragraphs: split at blank lines; single line breaks are kept inside one. */
export function letterParagraphs(text: string): string[] {
  return text
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

/**
 * This job's cover letter as a printable page: "Print or save as PDF" opens the browser's print
 * dialog, where Save as PDF gives the file. The page's title becomes the file's name. Only the
 * sheet prints; the app's header and these controls are hidden in print.
 */
export function CoverLetterPage() {
  const { id = '' } = useParams();
  const application = useApplication(id);
  const query = useApplicationCoverLetter(id, true);
  const letter = query.data?.coverLetter ?? null;
  const company = application.data?.company;
  const role = application.data?.role;

  useEffect(() => {
    if (!company || !role) return;
    const before = document.title;
    document.title = `Cover letter - ${company} - ${role}`;
    return () => {
      document.title = before;
    };
  }, [company, role]);

  if (application.isPending || query.isPending)
    return <p className="text-sm text-fg-2">Loading…</p>;
  if (!application.data || !letter)
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold">No cover letter for this job</h1>
        <p className="text-sm text-fg-2">
          Draft a cover letter on the application first.{' '}
          <Link to={`/applications/${id}`} className="link underline">
            Back to the application
          </Link>
        </p>
      </div>
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 print:hidden">
        <p className="text-sm">
          <Link to={`/applications/${id}`} className="link underline">
            Back to {application.data.company}
          </Link>
        </p>
        {!letter.savedAt && (
          <p className="text-sm text-amber" role="note">
            This is a draft you have not saved yet.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn-w" onClick={() => window.print()}>
            Print or save as PDF
          </button>
          <p className="text-sm text-fg-3">
            In the print dialog, choose Save as PDF, and turn off Headers and footers.
          </p>
        </div>
      </div>
      <article
        aria-label="This job's cover letter"
        className="resume-sheet rounded-tile bg-paper px-6 py-8 text-ink sm:px-12 sm:py-10 print:rounded-none print:p-0"
      >
        {letterParagraphs(letter.text).map((paragraph, index) => (
          <p
            key={index}
            className="mt-4 text-[0.9375rem] leading-relaxed whitespace-pre-line first:mt-0"
          >
            {paragraph}
          </p>
        ))}
      </article>
    </div>
  );
}
