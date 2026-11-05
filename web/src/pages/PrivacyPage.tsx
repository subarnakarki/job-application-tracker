import { APP_NAME } from '@jat/shared';
import { Link } from 'react-router';

/** Plain-language privacy notice. Public: linked from the sign-in page. */
export function PrivacyPage() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-8 text-slate-800 dark:text-slate-200">
      <h1 className="text-2xl font-semibold">Privacy</h1>
      <p>
        {APP_NAME} is a personal portfolio project. It keeps only what it needs to track your job
        applications.
      </p>

      <h2 className="mt-2 text-lg font-semibold">What is stored</h2>
      <ul className="list-disc pl-6">
        <li>
          From your Google account: your Google account id, email address, name and profile picture
          link. Nothing else is requested: no contacts, no Gmail, no Drive.
        </li>
        <li>The applications you enter, their status history, and your time zone setting.</li>
        <li>
          A sign-in session (only a hash of its token) and, briefly, a counter of sign-in attempts
          per network address to stop abuse.
        </li>
      </ul>

      <h2 className="mt-2 text-lg font-semibold">Cookies</h2>
      <p>
        Two strictly necessary cookies: one keeps you signed in (30 days), and one holds a Google
        sign-in for up to 10 minutes while it completes. There are no analytics, ads or tracking
        cookies.
      </p>

      <h2 className="mt-2 text-lg font-semibold">Who can see your data</h2>
      <p>
        Your applications are visible only to you. They are stored with Neon (Postgres database, US
        East) and served by Vercel; they are not sold or shared. The <strong>demo account</strong>{' '}
        is shared by everyone who uses it, so do not enter anything private there; its data may be
        removed at any time.
      </p>

      <h2 className="mt-2 text-lg font-semibold">Your choices</h2>
      <p>
        On the Account page you can download all your data as JSON, and delete your account, which
        removes everything immediately. You can also revoke the app&apos;s access in your Google
        account settings.
      </p>

      <p className="mt-4">
        <Link to="/" className="text-blue-700 underline dark:text-blue-400">
          Back to the app
        </Link>
      </p>
    </main>
  );
}
