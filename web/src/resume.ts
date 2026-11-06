import { RESUME_LIMITS, type FitLevel, type ResumeTitle } from '@jat/shared';

/** Job-board searches for a title. Links only: the app never reads these sites. */
export function searchLinks(title: string): { label: string; href: string }[] {
  const q = encodeURIComponent(title);
  return [
    { label: 'LinkedIn', href: `https://www.linkedin.com/jobs/search/?keywords=${q}` },
    { label: 'Indeed', href: `https://www.indeed.com/jobs?q=${q}` },
  ];
}

/** The missing keywords as one line, for pasting into a resume draft. */
export function missingKeywordsText(title: ResumeTitle): string {
  return title.keywords
    .filter((keyword) => !keyword.found)
    .map((keyword) => keyword.term)
    .join(', ');
}

export const FIT_LABELS: Record<FitLevel, string> = {
  strong: 'Strong fit',
  good: 'Good fit',
  stretch: 'Stretch',
};

export const ACCEPTED_FILES =
  '.pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Checked before upload, so a big file fails at once instead of after sending 2 MB. */
export function fileProblem(file: { name: string; size: number }): string | null {
  if (file.size > RESUME_LIMITS.fileBytes) return 'The file is over 2 MB. Save a smaller copy.';
  if (!/\.(pdf|docx)$/i.test(file.name)) return 'Upload a PDF or a Word (.docx) file.';
  return null;
}

/** A file's bytes as base64 (mutations are JSON only, so the file travels inside JSON). */
export async function toBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await readBytes(file));
  let binary = '';
  // In chunks: one call with millions of arguments overflows the stack.
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/** FileReader rather than Blob.arrayBuffer(), which older Safari and jsdom lack. */
function readBytes(file: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(reader.result as ArrayBuffer);
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('The file could not be read'));
    };
    reader.readAsArrayBuffer(file);
  });
}
