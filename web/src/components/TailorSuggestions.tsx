import { matchPosting, type KeywordGroup, type Tailoring, type TailorEdit } from '@jat/shared';
import { useState } from 'react';

/**
 * Which suggestions are ticked. Those with something to check (a name or number the resume never
 * mentions) start unticked; the rest start ticked. A new tailoring starts over.
 */
export function useChosenEdits(tailoring: Tailoring | null) {
  const [state, setState] = useState<{ createdAt: string | null; off: Set<number> | null }>({
    createdAt: null,
    off: null,
  });
  const createdAt = tailoring?.createdAt ?? null;
  const own = state.createdAt === createdAt ? state.off : null;
  const off =
    own ??
    new Set(
      (tailoring?.edits ?? []).flatMap((edit, index) => (edit.unverified.length ? [index] : [])),
    );
  const chosen: TailorEdit[] = (tailoring?.edits ?? []).filter((_, index) => !off.has(index));
  const toggle = (index: number, on: boolean) => {
    const next = new Set(off);
    if (on) next.delete(index);
    else next.add(index);
    setState({ createdAt, off: next });
  };
  return { off, chosen, toggle };
}

/** The fit of a text with a posting's keywords (code only); null with too few keywords. */
export function fitOf(keywords: { term: string; group: KeywordGroup }[], text: string) {
  const match = matchPosting({ keywords }, text);
  if (!match) return null;
  return {
    percent: match.matchPercent,
    missing: match.keywords.filter((keyword) => !keyword.found).map((keyword) => keyword.term),
  };
}

/** The suggested edits, each with its tick box, and the keywords not added (with why). */
export function TailorSuggestions({
  tailoring,
  off,
  onToggle,
}: {
  tailoring: Tailoring;
  off: Set<number>;
  onToggle: (index: number, on: boolean) => void;
}) {
  return (
    <>
      {tailoring.edits.length === 0 && (
        <p className="text-sm text-fg-3">
          No honest rewording adds the missing keywords; see below for why.
        </p>
      )}
      <ol className="flex flex-col gap-3">
        {tailoring.edits.map((edit, index) => (
          <li key={edit.original} className="flex flex-col gap-2 rounded-tile bg-s3 p-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={!off.has(index)}
                onChange={(event) => onToggle(index, event.target.checked)}
              />
              Use suggestion {String(index + 1)}
              {edit.keywordsAdded.length > 0 && (
                <span className="font-normal text-fg-3">
                  (adds {edit.keywordsAdded.join(', ')})
                </span>
              )}
            </label>
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-fg-3">Your line</dt>
                <dd>{edit.original}</dd>
              </div>
              <div>
                <dt className="text-fg-3">Suggested</dt>
                <dd>{edit.suggested}</dd>
              </div>
            </dl>
            {edit.unverified.length > 0 && (
              <p className="text-sm text-amber" role="note">
                Check this: not in your resume: {edit.unverified.join(', ')}
              </p>
            )}
            <p className="text-xs text-fg-3">{edit.why}</p>
          </li>
        ))}
      </ol>
      {tailoring.notCovered.length > 0 && (
        <div className="flex flex-col gap-1 text-sm">
          <p className="font-medium">Not added</p>
          <ul className="flex flex-col gap-1 text-fg-3">
            {tailoring.notCovered.map((entry) => (
              <li key={entry.keyword}>
                {entry.keyword}: {entry.why}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
