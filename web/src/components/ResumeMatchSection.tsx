import type { ApplicationDetail, ResumeMatch } from '@jat/shared';
import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ApiRequestError, apiRequest } from '../api/client';
import { useMe, useResume } from '../api/hooks';
import { ResumeMatchSchema } from '@jat/shared';
import { Glow } from './ui/Glow';

function useResumeMatch(id: string) {
  return useMutation({
    mutationFn: () =>
      apiRequest(`/api/applications/${encodeURIComponent(id)}/resume-match`, ResumeMatchSchema, {
        method: 'POST',
        body: {},
      }),
  });
}

/**
 * "Check my resume": the keywords this application's posting asks for, found or missing in the
 * stored resume. Shown only when there is a job link to read. Nothing is saved.
 */
export function ResumeMatchSection({ application }: { application: ApplicationDetail }) {
  const me = useMe();
  const resume = useResume();
  const check = useResumeMatch(application.id);

  if (!application.jobLink || me.data?.isDemo || !resume.data?.analysisAvailable) return null;
  const hasResume = resume.data.resume !== null;

  return (
    <Glow as="section" aria-labelledby="match-heading" className="flex flex-col gap-3 p-5">
      <h2 id="match-heading" className="text-[0.8125rem] font-medium text-fg-2">
        Resume match
      </h2>
      {hasResume ? (
        <div>
          <button
            type="button"
            className="btn-d"
            disabled={check.isPending}
            onClick={() => check.mutate()}
          >
            {check.isPending ? 'Reading the posting…' : 'Check my resume'}
          </button>
        </div>
      ) : (
        <p className="text-sm text-fg-2">
          <Link to="/resume" className="link underline">
            Upload your resume
          </Link>{' '}
          to see which of this posting's keywords it already has.
        </p>
      )}
      {check.isPending && (
        <p role="status" className="text-sm text-fg-3">
          Reading the posting and comparing it with your resume…
        </p>
      )}
      {check.isError && (
        <p role="alert" className="text-sm text-red">
          {check.error instanceof ApiRequestError
            ? check.error.message
            : 'Could not check right now. Try again.'}
        </p>
      )}
      {check.data && <MatchResult match={check.data} />}
    </Glow>
  );
}

function MatchResult({ match }: { match: ResumeMatch }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">
        <span className="text-2xl font-semibold tabular-nums">{match.matchPercent}%</span>{' '}
        <span className="text-fg-2">
          of this posting's keywords are in your resume ({match.found} of {match.keywords.length})
        </span>
      </p>
      <ul className="flex flex-wrap gap-1.5" aria-label="Posting keywords">
        {match.keywords.map((keyword) => (
          <li key={keyword.term} className={keyword.found ? 'kw kw-found' : 'kw kw-missing'}>
            <span aria-hidden="true">{keyword.found ? '✓' : '+'}</span>
            {keyword.term}
            <span className="sr-only">{keyword.found ? ' (in your resume)' : ' (missing)'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
