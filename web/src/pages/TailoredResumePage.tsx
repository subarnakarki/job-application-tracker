import { useEffect } from 'react';
import { Link, useParams } from 'react-router';
import { useApplication, useApplicationTailoring } from '../api/hooks';
import { resumeBlocks } from '../resumeLayout';

/**
 * This job's resume as a printable page: "Print or save as PDF" opens the browser's print dialog,
 * where Save as PDF gives the file. The page's title becomes the file's name. Only the sheet
 * prints; the app's header and these controls are hidden in print.
 */
export function TailoredResumePage() {
  const { id = '' } = useParams();
  const application = useApplication(id);
  const tailoring = useApplicationTailoring(id, true);
  const saved = tailoring.data?.saved ?? null;
  const company = application.data?.company;
  const role = application.data?.role;

  useEffect(() => {
    if (!company || !role) return;
    const before = document.title;
    document.title = `Resume - ${company} - ${role}`;
    return () => {
      document.title = before;
    };
  }, [company, role]);

  if (application.isPending || tailoring.isPending)
    return <p className="text-sm text-fg-2">Loading…</p>;
  if (!application.data || !saved)
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-xl font-semibold">No saved resume for this job</h1>
        <p className="text-sm text-fg-2">
          Save a tailored resume on the application first.{' '}
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
        aria-label="This job's resume"
        className="resume-sheet rounded-tile bg-paper px-6 py-8 text-ink sm:px-12 sm:py-10 print:rounded-none print:p-0"
      >
        {resumeBlocks(saved.text).map((block, index) => {
          switch (block.kind) {
            case 'name':
              return (
                <h1 key={index} className="text-2xl font-semibold tracking-[-0.02em]">
                  {block.text}
                </h1>
              );
            case 'heading':
              return (
                <h2
                  key={index}
                  className="mt-5 border-b border-ink-2/40 pb-1 text-sm font-semibold tracking-wide uppercase"
                >
                  {block.text}
                </h2>
              );
            case 'bullets':
              return (
                <ul key={index} className="mt-1 list-disc pl-5 text-sm leading-relaxed">
                  {block.items.map((item, itemIndex) => (
                    <li key={itemIndex}>{item}</li>
                  ))}
                </ul>
              );
            case 'line':
              return (
                <p key={index} className="mt-1 text-sm leading-relaxed text-ink-2">
                  {block.text}
                </p>
              );
          }
        })}
      </article>
    </div>
  );
}
