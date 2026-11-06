import { APP_NAME } from '@jat/shared';
import { Link } from 'react-router';
import { PublicHeader } from '../components/PublicHeader';
import { RevealHeading } from '../components/ui/PageHeader';

/** Plain-language privacy notice. Public: linked from the sign-in page. */
export function PrivacyPage() {
  return (
    <>
      <PublicHeader />
      <main className="prose-page mx-auto flex max-w-[48rem] flex-col gap-4 px-4 py-10 text-fg md:py-14">
        <RevealHeading text="Privacy" />
        <p>
          {APP_NAME} is a personal portfolio project. It keeps only what it needs to track your job
          applications.
        </p>

        <h2 className="mt-6 text-xl font-semibold tracking-[-0.03em]">What is stored</h2>
        <ul className="flex list-disc flex-col gap-1.5 pl-5">
          <li>
            From your Google account: your Google account id, email address, name and profile
            picture link. Sign-in requests nothing else: no contacts, no Gmail, no Drive.
          </li>
          <li>The applications you enter, their status history, and your time zone setting.</li>
          <li>
            A sign-in session (only a hash of its token) and, briefly, a counter of sign-in attempts
            per network address to stop abuse.
          </li>
        </ul>

        <h2 className="mt-6 text-xl font-semibold tracking-[-0.03em]">Gmail import (owner only)</h2>
        <p>
          The site owner can import job emails from their own Gmail; it is not offered to other
          accounts. An import asks Google for read-only Gmail access for that one run, and the
          access token is used and discarded, never stored. Up to 50 job-related emails are read,
          and the text of each one is sent to Anthropic&apos;s Claude API to classify it
          (confirmation, interview, rejection and so on). Email bodies are not stored: only each
          email&apos;s sender, subject, date and a one-sentence summary, so the results can be shown
          and undone. These are part of the data download and are deleted with the account.
        </p>

        <h2 className="mt-6 text-xl font-semibold tracking-[-0.03em]">Job postings</h2>
        <p>
          When you use &ldquo;Fill from link&rdquo; or &ldquo;Fill from posting&rdquo;, the server
          reads that public job posting to fill in empty fields. After a Gmail import it may read
          the posting an email links to. After an import, or when you use &ldquo;Find
          posting&rdquo;, it may look the role up on the company&apos;s public job board (such as
          Greenhouse or Lever); a posting found that way is only a suggestion until you use it. The
          job board is asked only for the open jobs under the company&apos;s name; nothing else from
          your emails or applications is sent to it.
        </p>

        <h2 className="mt-6 text-xl font-semibold tracking-[-0.03em]">Cookies</h2>
        <p>
          Strictly necessary cookies only: one keeps you signed in (30 days), and one holds a Google
          sign-in (or a Gmail import) for up to 10 minutes while it completes. There are no
          analytics, ads or tracking cookies.
        </p>

        <h2 className="mt-6 text-xl font-semibold tracking-[-0.03em]">Who can see your data</h2>
        <p>
          Your applications are visible only to you. They are stored with Neon (Postgres database,
          US East) and served by Vercel; they are not sold or shared. The{' '}
          <strong>demo account</strong> is shared by everyone who uses it, so do not enter anything
          private there; its data may be removed at any time.
        </p>

        <h2 className="mt-6 text-xl font-semibold tracking-[-0.03em]">Your choices</h2>
        <p>
          On the Account page you can download all your data as JSON, and delete your account, which
          removes everything immediately. You can also revoke the app&apos;s access in your Google
          account settings.
        </p>

        <p className="mt-4">
          <Link to="/" className="link underline">
            Back to the app
          </Link>
        </p>
      </main>
    </>
  );
}
