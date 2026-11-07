import {
  chromePrompt,
  searchQueries,
  type SearchSource,
  trackedLabel,
  EMPTY_PROGRESS,
  FILLABLE_SOURCES,
  progressPercent,
  RUN_STEPS,
  type RunProgress,
  type RunStep,
  googleSearchUrl,
  SEARCH_SOURCES,
  SOURCE_LABELS,
  type ApplicationQuestion,
  type JobHit,
  type JobSearchProfile,
  type JobSearchRun,
} from '@jat/shared';
import { useId, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ApiRequestError } from '../api/client';
import {
  useApplyQueue,
  useEditDraft,
  useHitAction,
  useJobSearchRun,
  useJobSearchRuns,
  useJobSearchSetup,
  useMe,
  useResumeText,
  useRunJobSearch,
  useSaveJobSearchProfile,
  type HitAction,
} from '../api/hooks';
import { useToast } from '../components/Toast';
import { Glow } from '../components/ui/Glow';
import { PageHeader } from '../components/ui/PageHeader';
import { Pill } from '../components/ui/Pill';
import { formatDateTime } from '../format';
import {
  CADENCE_LABELS,
  CADENCES,
  emptySetup,
  fromSetupValues,
  hourLabel,
  previewSearches,
  scheduleText,
  toSetupValues,
  WEEKDAYS,
  WORK_MODES,
  DISABILITY_LABELS,
  HISPANIC_LABELS,
  VETERAN_LABELS,
  type SetupValues,
} from '../jobSearchForm';

/** The self-identification answers, for the confirm step and the queue. */
function selfIdentification(profile: JobSearchProfile): [string, string][] {
  return [
    ['Gender', profile.gender],
    ['Hispanic or Latino', HISPANIC_LABELS[profile.hispanicLatino]],
    ['Race or ethnicity', profile.raceEthnicity],
    ['Veteran status', VETERAN_LABELS[profile.veteranStatus]],
    ['Disability', DISABILITY_LABELS[profile.disabilityStatus]],
    ['Other demographic questions', profile.eeoAnswer],
  ];
}

function errorText(error: unknown): string | null {
  if (!error) return null;
  return error instanceof ApiRequestError
    ? error.message
    : 'Something went wrong. Check your connection and try again.';
}

function Unavailable() {
  return (
    <p className="rounded-tile bg-s2 p-4 text-fg-2">
      The scheduled job search isn't available for this account yet.
    </p>
  );
}

// ---------------------------------------------------------------------------------------------
// Setup (first run) and editing it

const labelClass = 'text-[0.8125rem] font-medium text-fg-2';

function TextField({
  name,
  label,
  values,
  errors,
  onChange,
  type = 'text',
  hint,
  autoComplete,
}: {
  name: keyof SetupValues;
  label: string;
  values: SetupValues;
  errors: Record<string, string>;
  onChange: (name: keyof SetupValues, value: string) => void;
  type?: string;
  hint?: string;
  autoComplete?: string;
}) {
  const id = useId();
  const error = errors[name];
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <input
        id={id}
        type={type}
        className="inp"
        autoComplete={autoComplete}
        value={String(values[name])}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        onChange={(event) => onChange(name, event.target.value)}
      />
      {hint && !error && (
        <p id={`${id}-hint`} className="text-xs text-fg-3">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-sm text-red">
          {error}
        </p>
      )}
    </div>
  );
}

function ListField({
  name,
  label,
  hint,
  values,
  errors,
  onChange,
}: {
  name: 'queries' | 'includeTitles' | 'skipTitles';
  label: string;
  hint: string;
  values: SetupValues;
  errors: Record<string, string>;
  onChange: (name: keyof SetupValues, value: string) => void;
}) {
  const id = useId();
  const error = errors[name];
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <textarea
        id={id}
        rows={3}
        className="inp font-mono text-sm"
        value={values[name]}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-hint`}
        onChange={(event) => onChange(name, event.target.value)}
      />
      <p id={`${id}-hint`} className={error ? 'text-sm text-red' : 'text-xs text-fg-3'}>
        {error ?? hint}
      </p>
    </div>
  );
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex min-h-11 items-center gap-2.5 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <select
        id={id}
        className="inp"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function Fieldset({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <Glow as="section" className="p-5">
      <fieldset className="flex flex-col gap-4">
        <legend className="mb-1 text-lg font-semibold tracking-[-0.02em]">{legend}</legend>
        {children}
      </fieldset>
    </Glow>
  );
}

/** The confirm step: everything back in plain words before it is saved. */
function Summary({ profile }: { profile: JobSearchProfile }) {
  const rows: [string, string][] = [
    ['Name', profile.fullName],
    ['Email', profile.email],
    ['Phone', profile.phone],
    ['Location', `${profile.city}, ${profile.state}`],
    ['Work authorization', profile.workAuthorization],
    ['Needs sponsorship', profile.needsSponsorship ? 'Yes' : 'No'],
    [
      'Salary',
      profile.salaryMax === null
        ? `$${profile.salaryMin.toLocaleString()}`
        : `$${profile.salaryMin.toLocaleString()} to $${profile.salaryMax.toLocaleString()}`,
    ],
    ['LinkedIn', profile.linkedin || '—'],
    ['Portfolio', profile.portfolio || '—'],
    ['Website', profile.website || '—'],
    ['Work mode', profile.workModes.join(', ')],
    ['United States only', profile.usOnly ? 'Yes' : 'No, anywhere'],
    [
      'Job sites',
      profile.sites.length === SEARCH_SOURCES.length
        ? `All ${String(SEARCH_SOURCES.length)} sites`
        : profile.sites.map((source) => SOURCE_LABELS[source]).join(', '),
    ],
    ['Searches', searchQueries(profile).join('\n')],
    ['Job titles', profile.includeTitles.join(', ') || 'From your own searches'],
    ['Titles to skip', profile.skipTitles.join(', ') || '—'],
    [
      'Posted within',
      `${String(profile.timeframeDays)} day${profile.timeframeDays === 1 ? '' : 's'}`,
    ],
    ['Schedule', scheduleText(profile)],
    ['Willing to relocate', profile.willingToRelocate],
    ['Start date', profile.startDate],
    ['How you heard', profile.howHeard],
    ['18 or older', profile.over18 ? 'Yes' : 'No'],
    ...selfIdentification(profile),
  ];
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[12rem_1fr]">
      {rows.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-sm text-fg-3">{term}</dt>
          <dd className="text-sm break-words whitespace-pre-line">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A checkbox per job site, the fillable ones first, with Select all and Select none. */
function SiteChoices({
  sites,
  error,
  onChange,
}: {
  sites: SearchSource[];
  error: string | undefined;
  onChange: (sites: SearchSource[]) => void;
}) {
  const toggle = (source: SearchSource, on: boolean) =>
    onChange(SEARCH_SOURCES.filter((entry) => (entry === source ? on : sites.includes(entry))));
  const groups: [string, SearchSource[]][] = [
    ['Filled in by Claude in Chrome', SEARCH_SOURCES.filter((s) => FILLABLE_SOURCES.includes(s))],
    [
      'Need an account (listed for you to finish)',
      SEARCH_SOURCES.filter((s) => !FILLABLE_SOURCES.includes(s)),
    ],
  ];
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className={labelClass}>Job sites to search</legend>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-d" onClick={() => onChange([...SEARCH_SOURCES])}>
          Select all
        </button>
        <button type="button" className="btn-d" onClick={() => onChange([])}>
          Select none
        </button>
      </div>
      {groups.map(([title, sources]) => (
        <div key={title} role="group" aria-label={title}>
          <p className="mt-1 text-xs text-fg-3">{title}</p>
          <div className="grid grid-cols-2 gap-x-4 sm:grid-cols-3">
            {sources.map((source) => (
              <Check
                key={source}
                label={SOURCE_LABELS[source]}
                checked={sites.includes(source)}
                onChange={(on) => toggle(source, on)}
              />
            ))}
          </div>
        </div>
      ))}
      {error && <p className="text-sm text-red">Pick at least one site</p>}
    </fieldset>
  );
}

/** The searches the current answers make, updated as you type. */
function SearchPreview({ values }: { values: SetupValues }) {
  const searches = previewSearches(values);
  return (
    <div className="flex flex-col gap-1">
      <p className={labelClass}>Searches that will run</p>
      {searches.length === 0 ? (
        <p className="text-sm text-fg-3">Add a job title to make the searches.</p>
      ) : (
        <ul aria-label="Searches that will run" className="flex flex-col gap-1">
          {searches.map((search) => (
            <li
              key={search}
              className="rounded-input bg-s2 px-3 py-2 font-mono text-xs break-words"
            >
              {search}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SetupForm({ initial, onSaved }: { initial: SetupValues; onSaved: () => void }) {
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<JobSearchProfile | null>(null);
  const save = useSaveJobSearchProfile();
  const toast = useToast();
  const set = (name: keyof SetupValues, value: string) =>
    setValues((current) => ({ ...current, [name]: value }));
  const field = { values, errors, onChange: set };

  if (confirming)
    return (
      <Glow as="section" aria-labelledby="confirm-heading" className="flex flex-col gap-5 p-5">
        <h2 id="confirm-heading" className="text-lg font-semibold tracking-[-0.02em]">
          Check everything before it is saved
        </h2>
        <Summary profile={confirming} />
        {save.isError && (
          <p role="alert" className="text-sm text-red">
            {errorText(save.error)}
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            className="btn-w"
            disabled={save.isPending}
            onClick={() =>
              save.mutate(confirming, {
                onSuccess: () => {
                  toast('Saved your job search setup');
                  onSaved();
                },
              })
            }
          >
            {save.isPending ? 'Saving…' : 'Confirm and save'}
          </button>
          <button type="button" className="btn-d" onClick={() => setConfirming(null)}>
            Change something
          </button>
        </div>
      </Glow>
    );

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        const result = fromSetupValues(values);
        if (result.ok) {
          setErrors({});
          setConfirming(result.profile);
        } else {
          setErrors(result.errors);
        }
      }}
    >
      <Fieldset legend="You">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField name="fullName" label="Full name" autoComplete="name" {...field} />
          <TextField name="email" label="Email" type="email" autoComplete="email" {...field} />
          <TextField name="phone" label="Phone" type="tel" autoComplete="tel" {...field} />
          <TextField name="city" label="City" autoComplete="address-level2" {...field} />
          <TextField name="state" label="State" autoComplete="address-level1" {...field} />
          <TextField
            name="workAuthorization"
            label="Work authorization"
            hint='In your words, e.g. "US citizen"'
            {...field}
          />
          <TextField
            name="salaryMin"
            label="Salary (minimum)"
            hint="Per year, e.g. 150000"
            {...field}
          />
          <TextField name="salaryMax" label="Salary (maximum, optional)" {...field} />
          <TextField name="linkedin" label="LinkedIn (optional)" type="url" {...field} />
          <TextField
            name="portfolio"
            label="Portfolio or GitHub (optional)"
            type="url"
            {...field}
          />
          <TextField name="website" label="Website (optional)" type="url" {...field} />
        </div>
        <Check
          label="I need visa sponsorship, now or later"
          checked={values.needsSponsorship}
          onChange={(checked) =>
            setValues((current) => ({ ...current, needsSponsorship: checked }))
          }
        />
        <fieldset className="flex flex-col gap-1">
          <legend className={labelClass}>Work mode</legend>
          <div className="flex flex-wrap gap-x-5">
            {WORK_MODES.map((mode) => (
              <Check
                key={mode}
                label={mode}
                checked={values.workModes.includes(mode)}
                onChange={(checked) =>
                  setValues((current) => ({
                    ...current,
                    workModes: checked
                      ? [...current.workModes, mode]
                      : current.workModes.filter((entry) => entry !== mode),
                  }))
                }
              />
            ))}
          </div>
          {errors['workModes'] && <p className="text-sm text-red">Pick at least one</p>}
        </fieldset>
      </Fieldset>

      <Fieldset legend="What to search for">
        <ListField
          name="includeTitles"
          label="Job titles to search for"
          hint="One per line, e.g. SDET or QA automation engineer. Searches are made from these, and a job counts as a match when its title has one."
          {...field}
        />
        <SiteChoices
          sites={values.sites}
          error={errors['sites']}
          onChange={(sites) => setValues((current) => ({ ...current, sites }))}
        />
        <SearchPreview values={values} />
        <details className="rounded-tile bg-s2 p-3">
          <summary className="cursor-pointer text-sm font-medium">
            Advanced: write your own searches
          </summary>
          <div className="mt-3">
            <ListField
              name="queries"
              label="Your own searches"
              hint='Optional, one per line, at most 3, in Google style: "SDET" OR "QA lead" -intern. Used instead of the searches made from your titles. The sites ticked above decide where they search.'
              {...field}
            />
          </div>
        </details>
        <div className="grid gap-4 sm:grid-cols-2">
          <ListField
            name="skipTitles"
            label="Titles to skip"
            hint="One per line, e.g. intern, director."
            {...field}
          />
        </div>
        <Select
          label="Posted within"
          value={values.timeframeDays}
          options={[
            { value: '1', label: 'The past 24 hours' },
            { value: '3', label: 'The past 3 days' },
            { value: '7', label: 'The past week' },
            { value: '14', label: 'The past 2 weeks' },
            { value: '30', label: 'The past 30 days' },
          ]}
          onChange={(value) => set('timeframeDays', value)}
        />
        <Check
          label="United States only (skip jobs clearly outside the US; jobs that only say Remote are kept for you to check)"
          checked={values.usOnly}
          onChange={(checked) => setValues((current) => ({ ...current, usOnly: checked }))}
        />
      </Fieldset>

      <Fieldset legend="When to run">
        <Check
          label="Run on a schedule"
          checked={values.scheduleOn}
          onChange={(checked) => setValues((current) => ({ ...current, scheduleOn: checked }))}
        />
        <div className="grid gap-4 sm:grid-cols-3">
          <Select
            label="How often"
            value={values.cadence}
            options={CADENCES.map((cadence) => ({
              value: cadence,
              label: CADENCE_LABELS[cadence],
            }))}
            onChange={(value) => set('cadence', value)}
          />
          <Select
            label="At (your time zone)"
            value={values.runHour}
            options={Array.from({ length: 24 }, (_, hour) => ({
              value: String(hour),
              label: hourLabel(hour),
            }))}
            onChange={(value) => set('runHour', value)}
          />
          {values.cadence === 'weekly' && (
            <Select
              label="On"
              value={values.runWeekday}
              options={WEEKDAYS.map((day, index) => ({ value: String(index), label: day }))}
              onChange={(value) => set('runWeekday', value)}
            />
          )}
        </div>
      </Fieldset>

      <Fieldset legend="Standard answers">
        <p className="text-sm text-fg-3">Used for the questions most forms ask.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField name="willingToRelocate" label="Willing to relocate?" {...field} />
          <TextField name="startDate" label="When can you start?" {...field} />
          <TextField name="howHeard" label="How did you hear about the job?" {...field} />
        </div>
        <Check
          label="I am 18 or older"
          checked={values.over18}
          onChange={(checked) => setValues((current) => ({ ...current, over18: checked }))}
        />
      </Fieldset>

      <Fieldset legend="Voluntary self-identification (EEO)">
        <p className="text-sm text-fg-3">
          US forms often ask these. They are optional and employers must keep them out of hiring
          decisions. Each one is filled from here, never guessed; if a form&apos;s options
          don&apos;t clearly match your answer, the job asks you instead.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            name="gender"
            label="Gender"
            hint="As forms list it, e.g. Male, Female, Non-binary. Or decline."
            {...field}
          />
          <Select
            label="Hispanic or Latino?"
            value={values.hispanicLatino}
            options={Object.entries(HISPANIC_LABELS).map(([value, label]) => ({ value, label }))}
            onChange={(value) => set('hispanicLatino', value)}
          />
          <TextField
            name="raceEthnicity"
            label="Race or ethnicity"
            hint="As forms list it, e.g. Asian, White, Two or More Races. Or decline."
            {...field}
          />
          <Select
            label="Veteran status"
            value={values.veteranStatus}
            options={Object.entries(VETERAN_LABELS).map(([value, label]) => ({ value, label }))}
            onChange={(value) => set('veteranStatus', value)}
          />
          <Select
            label="Disability"
            value={values.disabilityStatus}
            options={Object.entries(DISABILITY_LABELS).map(([value, label]) => ({ value, label }))}
            onChange={(value) => set('disabilityStatus', value)}
          />
          <TextField
            name="eeoAnswer"
            label="Other demographic questions"
            hint="Sexual orientation, LGBTQ+, pronouns and the like."
            {...field}
          />
        </div>
      </Fieldset>

      {Object.keys(errors).length > 0 && (
        <p role="alert" className="text-sm text-red">
          Some answers need fixing; they are marked above.
        </p>
      )}
      <div>
        <button type="submit" className="btn-w">
          Review
        </button>
      </div>
    </form>
  );
}

export function JobSearchSetupPage() {
  const setup = useJobSearchSetup();
  const me = useMe();
  const navigate = useNavigate();
  if (setup.isPending || me.isPending) return <p className="text-sm text-fg-2">Loading…</p>;
  if (setup.isError) return <p role="alert">Could not load the setup. Try again shortly.</p>;
  if (!setup.data.available) return <Unavailable />;
  const initial = setup.data.profile
    ? toSetupValues(setup.data.profile)
    : emptySetup({ name: me.data?.name, email: me.data?.email });
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Job search setup"
        subtitle="Asked once. It fills your applications and decides what to search for and when."
      />
      {!setup.data.hasResume && (
        <p className="rounded-tile bg-s2 p-4 text-fg-2">
          The search drafts answers from your resume.{' '}
          <Link to="/resume" className="link underline">
            Upload it on the Resume page
          </Link>{' '}
          first or after this.
        </p>
      )}
      <SetupForm initial={initial} onSaved={() => void navigate('/job-search')} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Overview

function counts(run: JobSearchRun): string {
  const { counts: c } = run;
  return `${String(c.found)} found · ${String(c.target)} target · ${String(c.applied)} applied · ${String(c.needsYou + c.ready)} waiting · ${String(c.blocked)} blocked · ${String(c.skipped)} skipped`;
}

export function JobSearchPage() {
  const setup = useJobSearchSetup();
  const available = setup.data?.available === true;
  const runNow = useRunJobSearch();
  const runs = useJobSearchRuns(available && setup.data?.profile !== null, runNow.isPending);
  const queue = useApplyQueue(available && setup.data?.profile !== null);
  const active = runs.data?.items.find((run) => run.status === 'running') ?? null;
  const navigate = useNavigate();
  const toast = useToast();

  if (setup.isPending) return <p className="text-sm text-fg-2">Loading…</p>;
  if (setup.isError) return <p role="alert">Could not load the job search. Try again shortly.</p>;
  if (!available) return <Unavailable />;
  const { profile } = setup.data;
  if (!profile)
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Job search"
          subtitle="Searches the job boards on your schedule, drafts every application, and queues them for Claude in Chrome to fill in."
        />
        <Link to="/job-search/setup" className="btn-w self-start">
          Set up the job search
        </Link>
      </div>
    );

  const waiting = queue.data ? queue.data.ready.length + queue.data.needsYou.length : 0;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Job search"
        subtitle={`${scheduleText(profile)}. Postings from the past ${profile.timeframeDays === 1 ? '24 hours' : `${String(profile.timeframeDays)} days`}.`}
        actions={
          <>
            <button
              type="button"
              className="btn-w"
              disabled={runNow.isPending || !setup.data.hasResume}
              onClick={() =>
                runNow.mutate(undefined, {
                  onSuccess: (result) => {
                    toast(`Found ${String(result.run.counts.found)} new jobs`);
                    void navigate(`/job-search/runs/${result.run.id}`);
                  },
                })
              }
            >
              {runNow.isPending ? 'Searching…' : 'Run now'}
            </button>
            <Link to="/job-search/setup" className="btn-d">
              Edit setup
            </Link>
          </>
        }
      />
      {(active || runNow.isPending) && <RunProgressPanel run={active} />}
      {runNow.isError && (
        <p role="alert" className="text-sm text-red">
          {errorText(runNow.error)}
        </p>
      )}
      {!setup.data.hasResume && (
        <p className="rounded-tile bg-s2 p-4 text-fg-2">
          <Link to="/resume" className="link underline">
            Upload your resume
          </Link>{' '}
          so the search can draft your answers.
        </p>
      )}

      <Glow as="section" aria-labelledby="queue-heading" className="flex flex-col gap-3 p-5">
        <h2 id="queue-heading" className="text-lg font-semibold tracking-[-0.02em]">
          Apply queue
        </h2>
        <p className="text-fg-2">
          {waiting === 0
            ? 'Nothing waiting right now.'
            : `${String(waiting)} job${waiting === 1 ? '' : 's'} drafted and waiting.`}
        </p>
        <div className="flex flex-wrap gap-3">
          <Link to="/apply-queue" className="btn-d">
            Open the apply queue
          </Link>
          <CopyPromptButton />
        </div>
      </Glow>

      <section aria-labelledby="google-heading" className="flex flex-col gap-2">
        <h2 id="google-heading" className="text-sm font-medium text-fg-2">
          Cross-check on Google
        </h2>
        <ul className="flex flex-col gap-1">
          {searchQueries(profile).map((query) => (
            <li key={query}>
              <a
                className="link text-sm break-all underline"
                href={googleSearchUrl(query, profile.timeframeDays)}
                target="_blank"
                rel="noreferrer"
              >
                {query}
                <span className="sr-only"> (opens Google in a new tab)</span>
              </a>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="runs-heading" className="flex flex-col gap-3">
        <h2 id="runs-heading" className="text-lg font-semibold tracking-[-0.02em]">
          Runs
        </h2>
        {runs.data && runs.data.items.length === 0 && <p className="text-fg-2">No runs yet.</p>}
        <ul className="flex flex-col gap-2" aria-label="Runs">
          {runs.data?.items.map((run) => (
            <li key={run.id} className="rounded-tile bg-s2 p-3">
              <Link to={`/job-search/runs/${run.id}`} className="link font-medium">
                {formatDateTime(run.startedAt)} (
                {run.trigger === 'schedule' ? 'scheduled' : 'by hand'})
              </Link>
              <p className="text-sm text-fg-3">
                {run.status === 'failed' ? `Failed: ${run.error ?? 'unknown error'}` : counts(run)}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

const STEP_LABELS: Record<Exclude<RunStep, 'done'>, string> = {
  searching: 'Searching the job boards',
  sweeping: "Checking companies' own job lists",
  reading: 'Reading new jobs',
  drafting: 'Drafting answers',
};

function stepCount(step: Exclude<RunStep, 'done'>, progress: RunProgress): string | null {
  const of = (done: number, total: number, noun: string) =>
    total > 0 ? `${String(Math.min(done, total))} of ${String(total)} ${noun}` : null;
  switch (step) {
    case 'searching':
      return of(progress.queriesDone, progress.queriesTotal, 'queries');
    case 'sweeping':
      return of(progress.boardsDone, progress.boardsTotal, 'companies');
    case 'reading':
      return of(progress.jobsRead, progress.jobsTotal, 'jobs');
    case 'drafting':
      return of(progress.drafted, progress.draftsTotal, 'jobs');
  }
}

/** A running search: the overall bar, then each step with its counts. */
function RunProgressPanel({ run }: { run: JobSearchRun | null }) {
  const progress = run?.progress ?? EMPTY_PROGRESS;
  const percent = progressPercent(progress);
  const steps = Object.keys(STEP_LABELS) as Exclude<RunStep, 'done'>[];
  const current = RUN_STEPS.indexOf(progress.step);
  const label = progress.step === 'done' ? 'Finishing' : STEP_LABELS[progress.step];
  return (
    <Glow as="section" aria-labelledby="progress-heading" className="flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="progress-heading" className="text-lg font-semibold tracking-[-0.02em]">
          {run?.trigger === 'schedule' ? 'Scheduled search running' : 'Search running'}
        </h2>
        <span className="text-sm text-fg-3 tabular-nums">{percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-label="Job search progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${String(percent)}%, ${label}`}
        className="h-2 overflow-hidden rounded-full bg-s3"
      >
        <div
          className="h-full rounded-full bg-blue motion-safe:transition-[width] motion-safe:duration-700"
          style={{ width: `${String(percent)}%` }}
        />
      </div>
      <p role="status" className="text-sm text-fg-2">
        {run ? `${label}…` : 'Starting…'} This takes a few minutes; you can leave this page.
      </p>
      <ol className="flex flex-col gap-1.5" aria-label="Steps">
        {steps.map((step, index) => {
          const state = !run || index > current ? 'waiting' : index < current ? 'done' : 'now';
          const counts = run ? stepCount(step, progress) : null;
          return (
            <li key={step} className="flex flex-wrap items-baseline gap-x-2 text-sm">
              <span
                aria-hidden="true"
                className={`inline-block w-4 text-center ${state === 'done' ? 'text-green' : state === 'now' ? 'text-blue' : 'text-fg-4'}`}
              >
                {state === 'done' ? '✓' : state === 'now' ? '●' : '○'}
              </span>
              <span className={state === 'waiting' ? 'text-fg-3' : 'text-fg'}>
                {STEP_LABELS[step]}
              </span>
              <span className="sr-only">
                {state === 'done' ? '(done)' : state === 'now' ? '(in progress)' : '(waiting)'}
              </span>
              {counts && state !== 'waiting' && <span className="text-fg-3">· {counts}</span>}
            </li>
          );
        })}
      </ol>
    </Glow>
  );
}

/** "Already applied · Interviewing" (or "In your tracker · Saved"), linking to the application. */
function TrackedLabel({ hit }: { hit: JobHit }) {
  if (!hit.tracked) return null;
  return (
    <Link
      to={`/applications/${hit.tracked.applicationId}`}
      className="ml-1 inline-block align-middle"
    >
      <Pill tone={hit.tracked.status === 'Saved' ? 'neutral' : 'iv'} dot>
        {trackedLabel(hit.tracked.status)}
      </Pill>
    </Link>
  );
}

function CopyPromptButton() {
  const toast = useToast();
  return (
    <button
      type="button"
      className="btn-d"
      onClick={() =>
        void navigator.clipboard
          .writeText(chromePrompt(window.location.origin))
          .then(() => toast('Copied the Claude in Chrome prompt'))
      }
    >
      Copy Claude in Chrome prompt
    </button>
  );
}

// ---------------------------------------------------------------------------------------------
// One run: everything it found

const KIND_HEADINGS: [JobHit['kind'], string][] = [
  ['target', 'Target roles'],
  ['finish_yourself', 'Finish yourself (needs an account)'],
  ['keyword_only', 'Keyword only'],
  ['skipped', 'Skipped'],
];

const STATE_LABELS: Record<JobHit['state'], string> = {
  new: 'Not drafted yet',
  ready: 'Ready to apply',
  needs_you: 'Needs you',
  applied: 'Applied',
  blocked: 'Blocked',
  skipped: 'Skipped',
};

function posted(hit: JobHit): string {
  return hit.postedAt ? `Posted ${formatDateTime(hit.postedAt)}` : 'Posting time unknown';
}

export function JobSearchRunPage() {
  const { id = '' } = useParams();
  const run = useJobSearchRun(id);
  if (run.isPending) return <p className="text-sm text-fg-2">Loading…</p>;
  if (run.isError) return <p role="alert">This run could not be loaded.</p>;
  const { run: summary, hits } = run.data;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Search results"
        subtitle={`${formatDateTime(summary.startedAt)} · ${counts(summary)}`}
        actions={
          <Link to="/apply-queue" className="btn-w">
            Open the apply queue
          </Link>
        }
      />
      {hits.length === 0 && <p className="text-fg-2">No new jobs this time.</p>}
      {KIND_HEADINGS.map(([kind, heading]) => {
        const group = hits.filter((hit) => hit.kind === kind);
        if (group.length === 0) return null;
        return (
          <section key={kind} aria-label={heading} className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold tracking-[-0.02em]">
              {heading} ({group.length})
            </h2>
            <ul className="flex flex-col gap-2">
              {group.map((hit) => (
                <li key={hit.id} className="rounded-tile bg-s2 p-3">
                  <p className="font-medium">
                    {hit.company} · {hit.role} <TrackedLabel hit={hit} />
                  </p>
                  <p className="text-sm text-fg-3">
                    {posted(hit)} · {SOURCE_LABELS[hit.source]}
                    {hit.location ? ` · ${hit.location}` : ''} · {STATE_LABELS[hit.state]}
                  </p>
                  {(kind !== 'target' || hit.reason !== 'Matches your titles') && (
                    <p className="text-sm text-fg-3">{hit.reason}</p>
                  )}
                  <a
                    className="link text-sm break-all underline"
                    href={hit.jobLink}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {hit.jobLink}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The apply queue: read by the user and by Claude in Chrome

function profileFields(profile: JobSearchProfile): [string, string][] {
  const [first, ...rest] = profile.fullName.split(/\s+/);
  const fields: [string, string][] = [
    ['First name', first ?? profile.fullName],
    ['Last name', rest.join(' ')],
    ['Full name', profile.fullName],
    ['Email', profile.email],
    ['Phone', profile.phone],
    ['Location', `${profile.city}, ${profile.state}`],
    ['LinkedIn', profile.linkedin],
    ['Portfolio', profile.portfolio],
    ['Website', profile.website],
  ];
  return fields.filter(([, value]) => value);
}

function HitActions({ hit }: { hit: JobHit }) {
  const action = useHitAction();
  const toast = useToast();
  const [blocking, setBlocking] = useState(false);
  const [reason, setReason] = useState('');
  const id = useId();
  const act = (kind: HitAction, done: string, blockReason?: string) =>
    action.mutate(
      { id: hit.id, action: kind, ...(blockReason ? { reason: blockReason } : {}) },
      { onSuccess: () => toast(done) },
    );
  const job = `${hit.company}, ${hit.role}`;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-w"
          disabled={action.isPending}
          aria-label={`Mark applied: ${job}`}
          onClick={() => act('applied', `Marked ${hit.company} applied`)}
        >
          Mark applied
        </button>
        <button
          type="button"
          className="btn-d"
          aria-expanded={blocking}
          aria-label={`Mark blocked: ${job}`}
          onClick={() => setBlocking((open) => !open)}
        >
          Mark blocked
        </button>
        <button
          type="button"
          className="btn-d"
          disabled={action.isPending}
          aria-label={`Skip: ${job}`}
          onClick={() => act('skip', `Skipped ${hit.company}`)}
        >
          Skip
        </button>
        <button
          type="button"
          className="btn-d"
          disabled={action.isPending}
          aria-label={`Redraft with my current setup: ${job}`}
          onClick={() => act('redraft', `Redrafted ${hit.company}`)}
        >
          Redraft
        </button>
      </div>
      {blocking && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (reason.trim()) act('blocked', `Marked ${hit.company} blocked`, reason.trim());
          }}
        >
          <div className="flex min-w-60 flex-1 flex-col gap-1.5">
            <label htmlFor={`${id}-reason`} className={labelClass}>
              Why it is blocked
            </label>
            <input
              id={`${id}-reason`}
              className="inp"
              value={reason}
              placeholder="Needs an account"
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <button type="submit" className="btn-d" disabled={!reason.trim() || action.isPending}>
            Save
          </button>
        </form>
      )}
      {action.isError && (
        <p role="alert" className="text-sm text-red">
          {errorText(action.error)}
        </p>
      )}
    </div>
  );
}

function questionOf(hit: JobHit, label: string): ApplicationQuestion | undefined {
  return hit.questions?.find((question) => question.label === label);
}

/** Answers that need the user: editable, then saved. */
function NeedsYouForm({ hit }: { hit: JobHit }) {
  const edit = useEditDraft();
  const toast = useToast();
  const open = hit.draft?.answers.filter((answer) => answer.source === 'needs_you') ?? [];
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(open.map((answer) => [answer.question, answer.answer])),
  );
  const baseId = useId();
  if (!hit.draft) return null;
  const draft = hit.draft;
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        edit.mutate(
          {
            id: hit.id,
            edit: {
              answers: Object.entries(values).map(([question, answer]) => ({ question, answer })),
              coverLetter: draft.coverLetter,
            },
          },
          { onSuccess: () => toast('Saved your answers') },
        );
      }}
    >
      {open.map((answer, index) => {
        const question = questionOf(hit, answer.question);
        const fieldId = `${baseId}-${String(index)}`;
        return (
          <div key={answer.question} className="flex flex-col gap-1.5">
            <label htmlFor={fieldId} className={labelClass}>
              {answer.question}
              {question?.required ? ' (required)' : ''}
            </label>
            {question && question.options.length > 0 ? (
              <select
                id={fieldId}
                className="inp"
                value={values[answer.question] ?? ''}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [answer.question]: event.target.value }))
                }
              >
                <option value="">Choose…</option>
                {question.options.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            ) : (
              <input
                id={fieldId}
                className="inp"
                value={values[answer.question] ?? ''}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [answer.question]: event.target.value }))
                }
              />
            )}
          </div>
        );
      })}
      <div>
        <button type="submit" className="btn-w" disabled={edit.isPending}>
          Save answers
        </button>
      </div>
      {edit.isError && (
        <p role="alert" className="text-sm text-red">
          {errorText(edit.error)}
        </p>
      )}
    </form>
  );
}

function QueueJob({ hit, profile }: { hit: JobHit; profile: JobSearchProfile }) {
  const headingId = useId();
  const draft = hit.draft;
  const contact = profileFields(profile);
  // A question that repeats a contact field ("Email") is listed once, with the contact details.
  const shown = new Set(contact.map(([label]) => label.toLowerCase()));
  const answered =
    draft?.answers.filter(
      (answer) => answer.source !== 'needs_you' && !shown.has(answer.question.trim().toLowerCase()),
    ) ?? [];
  return (
    <Glow as="article" aria-labelledby={headingId} className="flex flex-col gap-4 p-5">
      <div>
        <h3 id={headingId} className="text-lg font-semibold tracking-[-0.02em]">
          {hit.company}: {hit.role}
        </h3>
        <TrackedLabel hit={hit} />
        <p className="text-sm text-fg-3">
          {posted(hit)} · {SOURCE_LABELS[hit.source]}
          {hit.location ? ` · ${hit.location}` : ''}
        </p>
      </div>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[14rem_1fr]">
        <dt className="text-fg-3">Application link</dt>
        <dd>
          <a
            className="link break-all underline"
            href={hit.applyLink}
            target="_blank"
            rel="noreferrer"
          >
            {hit.applyLink}
          </a>
        </dd>
        {contact.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-fg-3">{label}</dt>
            <dd className="break-words">{value}</dd>
          </div>
        ))}
        {answered.map((answer) => (
          <div key={answer.question} className="contents">
            <dt className="text-fg-3">{answer.question}</dt>
            <dd className="break-words whitespace-pre-line">{answer.option ?? answer.answer}</dd>
          </div>
        ))}
        {draft && (
          <>
            <dt className="text-fg-3">Cover letter</dt>
            <dd className="whitespace-pre-line">{draft.coverLetter}</dd>
            <dt className="text-fg-3">Why this job</dt>
            <dd className="whitespace-pre-line">{draft.whyInterested}</dd>
          </>
        )}
      </dl>
      {hit.state === 'needs_you' && (
        <section aria-label="Answers only you can give" className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold text-amber">Only you can answer these</h4>
          <NeedsYouForm hit={hit} />
        </section>
      )}
      {hit.questions === null && (
        <p className="text-sm text-fg-3">
          {SOURCE_LABELS[hit.source]} does not publish its form's questions: use the answers above
          and the standard answers below; mark the job blocked for anything else.
        </p>
      )}
      <HitActions hit={hit} />
    </Glow>
  );
}

function StandardAnswers({ profile }: { profile: JobSearchProfile }) {
  const rows: [string, string][] = [
    ['Work authorization', profile.workAuthorization],
    ['Needs visa sponsorship', profile.needsSponsorship ? 'Yes' : 'No'],
    [
      'Salary expectation',
      profile.salaryMax === null
        ? `$${profile.salaryMin.toLocaleString('en-US')}`
        : `$${profile.salaryMin.toLocaleString('en-US')} to $${profile.salaryMax.toLocaleString('en-US')}`,
    ],
    ['Willing to relocate', profile.willingToRelocate],
    ['Start date', profile.startDate],
    ['How did you hear about us', profile.howHeard],
    ['18 or older', profile.over18 ? 'Yes' : 'No'],
    ...selfIdentification(profile),
  ];
  return (
    <Glow as="section" aria-labelledby="standard-heading" className="flex flex-col gap-3 p-5">
      <h2 id="standard-heading" className="text-lg font-semibold tracking-[-0.02em]">
        Standard answers
      </h2>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[14rem_1fr]">
        {rows.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-fg-3">{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </Glow>
  );
}

function ResumeTextBlock() {
  const [shown, setShown] = useState(false);
  const text = useResumeText(shown);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-3">
        <a className="btn-w" href="/api/resume/file" download>
          Download resume
        </a>
        <button
          type="button"
          className="btn-d"
          aria-expanded={shown}
          onClick={() => setShown((open) => !open)}
        >
          {shown ? 'Hide resume text' : 'Show resume text'}
        </button>
      </div>
      {shown && text.data && (
        <pre
          aria-label="Resume text"
          className="max-h-80 overflow-auto rounded-tile bg-s2 p-3 text-xs whitespace-pre-wrap"
        >
          {text.data.text}
        </pre>
      )}
    </div>
  );
}

export function ApplyQueuePage() {
  const setup = useJobSearchSetup();
  const available = setup.data?.available === true;
  const queue = useApplyQueue(available);
  const action = useHitAction();

  if (setup.isPending) return <p className="text-sm text-fg-2">Loading…</p>;
  if (!available || !setup.data?.profile) return <Unavailable />;
  const { profile } = setup.data;
  if (queue.isPending) return <p className="text-sm text-fg-2">Loading…</p>;
  if (queue.isError) return <p role="alert">Could not load the queue. Try again shortly.</p>;
  const { ready, needsYou, finishYourself, keywordOnly, olderMatches, notDrafted } = queue.data;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Apply queue"
        subtitle="Each job with every answer for its form. Claude in Chrome fills them from this page; you can too."
      />
      <ResumeTextBlock />
      {notDrafted > 0 && (
        <p className="text-sm text-fg-3">
          {notDrafted} more job{notDrafted === 1 ? ' is' : 's are'} still being drafted; they appear
          here within the hour.
        </p>
      )}

      <section aria-labelledby="ready-heading" className="flex flex-col gap-4">
        <h2 id="ready-heading" className="text-2xl font-semibold tracking-[-0.03em]">
          Ready to apply ({ready.length})
        </h2>
        {ready.length === 0 && <p className="text-fg-2">Nothing ready right now.</p>}
        {ready.map((hit) => (
          <QueueJob key={hit.id} hit={hit} profile={profile} />
        ))}
      </section>

      {needsYou.length > 0 && (
        <section aria-labelledby="needs-heading" className="flex flex-col gap-4">
          <h2 id="needs-heading" className="text-2xl font-semibold tracking-[-0.03em]">
            Needs you ({needsYou.length})
          </h2>
          <p className="text-sm text-fg-3">
            Answer what only you can, then the job moves to Ready to apply.
          </p>
          {needsYou.map((hit) => (
            <QueueJob key={hit.id} hit={hit} profile={profile} />
          ))}
        </section>
      )}

      <StandardAnswers profile={profile} />

      {finishYourself.length > 0 && (
        <section aria-labelledby="finish-heading" className="flex flex-col gap-4">
          <h2 id="finish-heading" className="text-2xl font-semibold tracking-[-0.03em]">
            Finish yourself ({finishYourself.length})
          </h2>
          <p className="text-sm text-fg-3">
            These need an account on the company's site, which can't be created for you. The answers
            are ready to copy.
          </p>
          {finishYourself.map((hit) => (
            <QueueJob key={hit.id} hit={hit} profile={profile} />
          ))}
        </section>
      )}

      {keywordOnly.length > 0 && (
        <section aria-labelledby="keyword-heading" className="flex flex-col gap-3">
          <h2 id="keyword-heading" className="text-2xl font-semibold tracking-[-0.03em]">
            Keyword only ({keywordOnly.length})
          </h2>
          <p className="text-sm text-fg-3">
            These mention your keywords, but the title is a different role. Add one to the queue to
            have it drafted.
          </p>
          <ul className="flex flex-col gap-2">
            {keywordOnly.map((hit) => (
              <li
                key={hit.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-tile bg-s2 p-3"
              >
                <div>
                  <p className="font-medium">
                    {hit.company} · {hit.role} <TrackedLabel hit={hit} />
                  </p>
                  <p className="text-sm text-fg-3">
                    {posted(hit)} ·{' '}
                    <a
                      className="link underline"
                      href={hit.jobLink}
                      target="_blank"
                      rel="noreferrer"
                    >
                      posting
                    </a>
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="btn-d"
                    disabled={action.isPending}
                    aria-label={`Add to queue: ${hit.company}, ${hit.role}`}
                    onClick={() => action.mutate({ id: hit.id, action: 'queue' })}
                  >
                    Add to queue
                  </button>
                  <button
                    type="button"
                    className="btn-d"
                    disabled={action.isPending}
                    aria-label={`Skip: ${hit.company}, ${hit.role}`}
                    onClick={() => action.mutate({ id: hit.id, action: 'skip' })}
                  >
                    Skip
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {olderMatches.length > 0 && (
        <section aria-labelledby="older-heading" className="flex flex-col gap-3">
          <h2 id="older-heading" className="text-2xl font-semibold tracking-[-0.03em]">
            Older matches ({olderMatches.length})
          </h2>
          <p className="text-sm text-fg-3">
            These match your titles and location, but were posted before your time window. They were
            open when found; add one to the queue to have it drafted.
          </p>
          <ul className="flex flex-col gap-2">
            {olderMatches.map((hit) => (
              <li
                key={hit.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-tile bg-s2 p-3"
              >
                <div>
                  <p className="font-medium">
                    {hit.company} · {hit.role} <TrackedLabel hit={hit} />
                  </p>
                  <p className="text-sm text-fg-3">
                    {posted(hit)}
                    {hit.location ? ` · ${hit.location}` : ''} ·{' '}
                    <a
                      className="link underline"
                      href={hit.jobLink}
                      target="_blank"
                      rel="noreferrer"
                    >
                      posting
                    </a>
                  </p>
                </div>
                <button
                  type="button"
                  className="btn-d"
                  disabled={action.isPending}
                  aria-label={`Add to queue: ${hit.company}, ${hit.role}`}
                  onClick={() => action.mutate({ id: hit.id, action: 'queue' })}
                >
                  Add to queue
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
