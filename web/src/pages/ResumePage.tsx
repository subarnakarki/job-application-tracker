import type { Resume, ResumeAnalysis, ResumeTitle } from '@jat/shared';
import { useId, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ApiRequestError } from '../api/client';
import {
  useAnalyseResume,
  useDeleteResume,
  useDeleteResumeAnalysis,
  useMe,
  useResume,
  useResumeAnalyses,
  useResumeAnalysis,
  useUploadResume,
} from '../api/hooks';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';
import { Glow } from '../components/ui/Glow';
import { PageHeader } from '../components/ui/PageHeader';
import { Pill } from '../components/ui/Pill';
import { formatDateTime } from '../format';
import {
  ACCEPTED_FILES,
  FIT_LABELS,
  fileProblem,
  missingKeywordsText,
  searchLinks,
  toBase64,
} from '../resume';

const TYPE_LABELS: Record<Resume['mediaType'], string> = {
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word document',
  'text/plain': 'Pasted text',
};

function errorText(error: unknown): string | null {
  if (!error) return null;
  return error instanceof ApiRequestError
    ? error.message
    : 'Something went wrong. Check your connection and try again.';
}

/**
 * Resume match: upload a resume, have it read as a senior recruiter would, and see the 20 titles it
 * fits best with the keywords applicant tracking systems match for each.
 */
export function ResumePage() {
  const me = useMe();
  const resume = useResume();
  const analyses = useResumeAnalyses();
  const [params, setParams] = useSearchParams();
  const selected = params.get('analysis') ?? analyses.data?.items[0]?.id ?? null;
  const analysis = useResumeAnalysis(selected);
  const analyse = useAnalyseResume();

  if (resume.isPending) return <p className="text-sm text-fg-2">Loading…</p>;
  if (resume.isError)
    return (
      <p role="alert" className="text-sm text-red">
        Could not load your resume. Try again shortly.
      </p>
    );

  const isDemo = me.data?.isDemo ?? false;
  const { resume: current, analysisAvailable, analysesPerDay } = resume.data;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Resume match"
        subtitle="Upload your resume to see the 20 job titles you fit best, read the way a senior recruiter would, with the keywords applicant tracking systems look for in each."
      />

      {isDemo ? (
        <p className="rounded-tile bg-s2 p-4 text-fg-2">
          The shared demo account can't upload a resume, because others can see this data. Sign in
          with Google to use resume match.
        </p>
      ) : (
        <ResumeSection resume={current} />
      )}

      {!isDemo && current && (
        <section aria-labelledby="analyse-heading" className="flex flex-col gap-3">
          <h2 id="analyse-heading" className="sr-only">
            Analyse
          </h2>
          {analysisAvailable ? (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="btn-w"
                disabled={analyse.isPending}
                onClick={() =>
                  analyse.mutate(undefined, {
                    onSuccess: (result) => setParams({ analysis: result.id }),
                  })
                }
              >
                {analyse.isPending ? 'Reading your resume…' : 'Find my best-fit titles'}
              </button>
              <p className="text-sm text-fg-3">
                {analysesPerDay === 1 ? 'Once a day' : `Up to ${String(analysesPerDay)} a day`},
                shared with resume checks. Usually takes under a minute.
              </p>
            </div>
          ) : (
            <p className="text-fg-2">Resume analysis is turned off on this server.</p>
          )}
          {analyse.isPending && (
            <p role="status" className="text-sm text-fg-2">
              Reading your resume as a recruiter would. This usually takes under a minute; keep this
              page open.
            </p>
          )}
          {analyse.isError && (
            <p role="alert" className="text-sm text-red">
              {errorText(analyse.error)}
            </p>
          )}
        </section>
      )}

      <AtsNote />

      {analysis.data && <AnalysisView analysis={analysis.data} />}
      {analysis.isError && (
        <p role="alert" className="text-sm text-red">
          This analysis could not be loaded. It may have been deleted.
        </p>
      )}

      {analyses.data && analyses.data.items.length > 0 && (
        <EarlierAnalyses
          items={analyses.data.items}
          selected={analysis.data?.id ?? null}
          onPick={(id) => setParams({ analysis: id })}
          onDeleted={() => setParams({})}
        />
      )}
    </div>
  );
}

/** The honest caveat, close to the keywords it is about. */
function AtsNote() {
  return (
    <p className="max-w-[72ch] text-sm text-fg-3">
      No applicant tracking system publishes a fixed keyword list: each one matches the words in
      that job's posting. These keywords are the ones postings for each title use most, so add the
      missing ones you really have, in your own words.
    </p>
  );
}

function ResumeSection({ resume }: { resume: Resume | null }) {
  const id = useId();
  const upload = useUploadResume();
  const remove = useDeleteResume();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const found = fileProblem(file);
    setProblem(found);
    if (found) return;
    let dataBase64: string;
    try {
      dataBase64 = await toBase64(file);
    } catch {
      setProblem('That file could not be read.');
      return;
    }
    upload.mutate(
      { kind: 'file', fileName: file.name, dataBase64 },
      { onSuccess: () => toast(`Saved ${file.name}`) },
    );
  };

  const failure = problem ?? errorText(upload.error) ?? errorText(remove.error);

  return (
    <Glow as="section" aria-labelledby={`${id}-heading`} className="flex flex-col gap-4 p-5">
      <h2 id={`${id}-heading`} className="text-lg font-semibold tracking-[-0.02em]">
        Your resume
      </h2>
      {resume ? (
        <p className="text-fg-2">
          {resume.fileName ?? 'Pasted text'} · {TYPE_LABELS[resume.mediaType]} ·{' '}
          {resume.characters.toLocaleString()} characters · saved{' '}
          {formatDateTime(resume.uploadedAt)}
        </p>
      ) : (
        <p className="text-fg-2">
          No resume yet. Upload a PDF or Word file (up to 2 MB), or paste the text. It is kept in
          your account so later features can attach it for you; you can delete it at any time.
        </p>
      )}

      <div className="flex flex-wrap gap-3">
        <input
          ref={fileInput}
          id={`${id}-file`}
          type="file"
          accept={ACCEPTED_FILES}
          aria-label="Resume file"
          // The button below opens it; one stop on the keyboard path is enough.
          tabIndex={-1}
          className="sr-only"
          onChange={(event) => {
            void onFile(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        <button
          type="button"
          className="btn-w"
          disabled={upload.isPending}
          onClick={() => fileInput.current?.click()}
        >
          {upload.isPending ? 'Uploading…' : resume ? 'Replace file' : 'Upload resume'}
        </button>
        <button
          type="button"
          className="btn-d"
          aria-expanded={pasting}
          onClick={() => setPasting((open) => !open)}
        >
          Paste text instead
        </button>
        {resume?.fileName && (
          <a className="btn-d" href="/api/resume/file" download>
            Download
          </a>
        )}
        {resume && (
          <button type="button" className="btn-d" onClick={() => setConfirmingDelete(true)}>
            Delete resume
          </button>
        )}
      </div>

      {pasting && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            upload.mutate(
              { kind: 'text', text },
              {
                onSuccess: () => {
                  setPasting(false);
                  setText('');
                  toast('Saved your resume text');
                },
              },
            );
          }}
        >
          <label htmlFor={`${id}-text`} className="text-[0.8125rem] font-medium text-fg-2">
            Resume text
          </label>
          <textarea
            id={`${id}-text`}
            rows={10}
            className="inp"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <div>
            <button type="submit" className="btn-w" disabled={upload.isPending || !text.trim()}>
              Save text
            </button>
          </div>
        </form>
      )}

      {failure && (
        <p role="alert" className="text-sm text-red">
          {failure}
        </p>
      )}

      <ConfirmDialog
        open={confirmingDelete}
        title="Delete your resume?"
        confirmLabel="Delete resume"
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={() =>
          remove.mutate(undefined, {
            onSuccess: () => {
              setConfirmingDelete(false);
              toast('Deleted your resume');
            },
          })
        }
        message="The file and its text are removed. Saved analyses stay until you delete them."
        busy={remove.isPending}
      />
    </Glow>
  );
}

function AnalysisView({ analysis }: { analysis: ResumeAnalysis }) {
  return (
    <section aria-labelledby="results-heading" className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h2 id="results-heading" className="text-2xl font-semibold tracking-[-0.03em]">
          Your top {analysis.titles.length} titles
        </h2>
        <p className="text-sm text-fg-3">
          {analysis.fileName ?? 'Pasted text'} · analysed {formatDateTime(analysis.createdAt)}
        </p>
        <p className="max-w-[72ch] text-fg-2">{analysis.summary}</p>
      </div>

      {(analysis.warnings.length > 0 || analysis.gaps.length > 0) && (
        <div className="grid gap-4 md:grid-cols-2">
          {analysis.warnings.length > 0 && (
            <Notes title="Check these first" items={analysis.warnings} />
          )}
          {analysis.gaps.length > 0 && <Notes title="To strengthen it" items={analysis.gaps} />}
        </div>
      )}

      <ol className="grid gap-4 lg:grid-cols-2" aria-label="Best-fit titles">
        {analysis.titles.map((title) => (
          <TitleCard key={title.rank} title={title} />
        ))}
      </ol>
    </section>
  );
}

function Notes({ title, items }: { title: string; items: string[] }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="rounded-tile bg-s2 p-4">
      <h3 id={id} className="text-sm font-semibold">
        {title}
      </h3>
      <ul className="mt-2 list-disc pl-5 text-sm text-fg-2">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

function TitleCard({ title }: { title: ResumeTitle }) {
  const toast = useToast();
  const headingId = useId();
  const missing = missingKeywordsText(title);
  const found = title.keywords.filter((keyword) => keyword.found).length;

  return (
    <li>
      <Glow as="article" aria-labelledby={headingId} className="flex h-full flex-col gap-3 p-5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-sm text-fg-3 tabular-nums">{title.rank}.</span>
          <h3 id={headingId} className="text-lg font-semibold tracking-[-0.02em]">
            {title.title}
          </h3>
        </div>
        <div className="flex flex-wrap gap-2">
          <Pill tone={title.fit === 'strong' ? 'iv' : title.fit === 'good' ? 'neutral' : 'follow'}>
            {FIT_LABELS[title.fit]}
          </Pill>
          <Pill>{title.seniority}</Pill>
        </div>
        <p className="text-sm text-fg-2">{title.reason}</p>

        <div>
          <p className="text-[0.8125rem] font-medium text-fg-2">
            Keywords: {found} of {title.keywords.length} in your resume
          </p>
          <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={`Keywords for ${title.title}`}>
            {title.keywords.map((keyword) => (
              <li key={keyword.term} className={keyword.found ? 'kw kw-found' : 'kw kw-missing'}>
                <span aria-hidden="true">{keyword.found ? '✓' : '+'}</span>
                {keyword.term}
                <span className="sr-only">
                  {keyword.found ? ' (in your resume)' : ' (missing)'}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-auto flex flex-wrap gap-2 pt-1">
          {missing && (
            <button
              type="button"
              className="btn-d"
              onClick={() =>
                void navigator.clipboard
                  .writeText(missing)
                  .then(() => toast('Copied the missing keywords'))
              }
            >
              Copy missing keywords
            </button>
          )}
          <Link className="btn-d" to={`/applications/new?role=${encodeURIComponent(title.title)}`}>
            Track this title
          </Link>
          {searchLinks(title.title).map((link) => (
            <a key={link.label} className="btn-d" href={link.href} target="_blank" rel="noreferrer">
              Search {link.label}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ))}
        </div>
      </Glow>
    </li>
  );
}

function EarlierAnalyses({
  items,
  selected,
  onPick,
  onDeleted,
}: {
  items: { id: string; fileName: string | null; createdAt: string; topTitles: string[] }[];
  selected: string | null;
  onPick: (id: string) => void;
  onDeleted: () => void;
}) {
  const remove = useDeleteResumeAnalysis();
  const toast = useToast();
  const [deleting, setDeleting] = useState<string | null>(null);
  return (
    <section aria-labelledby="earlier-heading" className="flex flex-col gap-3">
      <h2 id="earlier-heading" className="text-lg font-semibold tracking-[-0.02em]">
        Saved analyses
      </h2>
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-tile bg-s2 p-3"
          >
            <button
              type="button"
              className="link text-left"
              aria-current={item.id === selected ? 'true' : undefined}
              onClick={() => onPick(item.id)}
            >
              {formatDateTime(item.createdAt)} · {item.fileName ?? 'Pasted text'}
              {item.topTitles.length > 0 && (
                <span className="text-fg-3"> · {item.topTitles.join(', ')}</span>
              )}
            </button>
            <button type="button" className="btn-d" onClick={() => setDeleting(item.id)}>
              Delete<span className="sr-only"> analysis from {formatDateTime(item.createdAt)}</span>
            </button>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={deleting !== null}
        title="Delete this analysis?"
        confirmLabel="Delete analysis"
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          remove.mutate(deleting, {
            onSuccess: () => {
              setDeleting(null);
              onDeleted();
              toast('Deleted the analysis');
            },
          });
        }}
        message="Your resume is not affected."
        busy={remove.isPending}
      />
    </section>
  );
}
