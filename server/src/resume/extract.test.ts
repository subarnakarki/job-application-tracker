import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { RESUME_LIMITS } from '@jat/shared';
import { describe, expect, it } from 'vitest';
import {
  cleanText,
  extractResume,
  pastedResume,
  ResumeFileError,
  sniffType,
  wordXmlText,
} from './extract';

/**
 * Fixtures: `resume.source.html` converted by LibreOffice to `resume.pdf` and `resume.docx`;
 * `scanned.pdf` is page 1 of that PDF as an image only; `twelve-pages.pdf` is twelve short pages.
 */
const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ResumeFileError) return error.code;
    throw error;
  }
  throw new Error('Expected the file to be refused');
}

/** A zip with the given parts, deflated unless `stored`. Only what the reader needs. */
function makeZip(parts: { name: string; data: Buffer; stored?: boolean }[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const body = part.stored ? part.data : deflateRawSync(part.data);
    const name = Buffer.from(part.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(part.stored ? 0 : 8, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(part.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(part.stored ? 0 : 8, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(part.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const wordXml = (...paragraphs: string[]) =>
  Buffer.from(
    `<?xml version="1.0"?><w:document><w:body>${paragraphs.join('')}</w:body></w:document>`,
  );
const LONG_ENOUGH = 'Senior SDET with Playwright and TypeScript experience. '.repeat(5);

describe('extractResume: real files', () => {
  it('reads a PDF', async () => {
    const resume = await extractResume(fixture('resume.pdf'));

    expect(resume.mediaType).toBe('application/pdf');
    expect(resume.text).toContain('Pat Example');
    expect(resume.text).toContain('Senior Software Engineer in Test, Acme Payments');
    expect(resume.text).toContain('Kubernetes');
    expect(resume.textSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads a DOCX, paragraphs on their own lines', async () => {
    const resume = await extractResume(fixture('resume.docx'));

    expect(resume.mediaType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(resume.text).toContain('Pat Example\n');
    // The & in the source was escaped in the XML.
    expect(resume.text).toContain('900 tests & contract tests');
    expect(resume.text).toContain('Kubernetes');
  });

  it('gives the same hash for the same text', async () => {
    const first = await extractResume(fixture('resume.docx'));
    const again = await extractResume(fixture('resume.docx'));
    expect(again.textSha256).toBe(first.textSha256);
  });

  it('refuses a scanned PDF (an image with no text)', async () => {
    expect(await failure(extractResume(fixture('scanned.pdf')))).toBe('no_text');
  });

  it('refuses a PDF with more pages than a resume has', async () => {
    expect(await failure(extractResume(fixture('twelve-pages.pdf')))).toBe('too_many_pages');
  });
});

describe('extractResume: hostile and wrong files', () => {
  it('refuses a file over 2 MB before reading it', async () => {
    const big = new Uint8Array(RESUME_LIMITS.fileBytes + 1);
    big.set(Buffer.from('%PDF-1.7'));
    expect(await failure(extractResume(big))).toBe('too_large');
  });

  it.each([
    ['plain text', Buffer.from(LONG_ENOUGH)],
    ['a PNG', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])],
    ['an old .doc file', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])],
  ])('refuses %s, whatever it is named', async (_label, bytes) => {
    expect(await failure(extractResume(new Uint8Array(bytes)))).toBe('unsupported_type');
  });

  it('refuses a zip that is not a Word document', async () => {
    const zip = makeZip([{ name: 'hello.txt', data: Buffer.from(LONG_ENOUGH) }]);
    expect(await failure(extractResume(zip))).toBe('unsupported_type');
  });

  it('stops unzipping a zip bomb at the cap', async () => {
    // 50 MB of zeros deflates to about 50 KB.
    const bomb = makeZip([{ name: 'word/document.xml', data: Buffer.alloc(50 * 1024 * 1024) }]);
    expect(bomb.byteLength).toBeLessThan(RESUME_LIMITS.fileBytes);
    expect(await failure(extractResume(bomb))).toBe('unreadable');
  });

  it('counts the cap across every part, not per part', async () => {
    const part = Buffer.alloc(3 * 1024 * 1024, 0x20);
    const zip = makeZip([
      { name: 'word/document.xml', data: part },
      { name: 'word/header1.xml', data: part },
    ]);
    expect(await failure(extractResume(zip))).toBe('unreadable');
  });

  it('refuses a truncated or corrupt file', async () => {
    const pdf = fixture('resume.pdf');
    expect(await failure(extractResume(pdf.subarray(0, 600)))).toBe('unreadable');
    const docx = fixture('resume.docx');
    expect(await failure(extractResume(docx.subarray(0, docx.length - 30)))).toBe('unreadable');
  });

  it('reads stored (uncompressed) parts, and headers after the body', async () => {
    const zip = makeZip([
      { name: 'word/header1.xml', data: wordXml(paragraph('pat@example.com')) },
      { name: 'word/document.xml', data: wordXml(paragraph(LONG_ENOUGH)), stored: true },
    ]);
    const resume = await extractResume(zip);
    expect(resume.text.startsWith('Senior SDET')).toBe(true);
    expect(resume.text.endsWith('pat@example.com')).toBe(true);
  });
});

describe('wordXmlText', () => {
  it('keeps text runs, paragraph ends, tabs and breaks, and decodes entities', () => {
    const xml =
      '<w:p><w:r><w:t xml:space="preserve">A &amp; B </w:t><w:tab/><w:t>&#x2014;&#65;</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>line</w:t><w:br/><w:t>next</w:t></w:r></w:p>' +
      '<w:p><w:r><w:instrText>HYPERLINK "x"</w:instrText></w:r></w:p>';
    expect(wordXmlText(xml)).toBe('A & B \t—A\nline\nnext\n\n');
  });
});

describe('pasted text and clean-up', () => {
  it('cleans pasted text like a file’s and refuses too little', () => {
    expect(pastedResume(`  ${LONG_ENOUGH}  `).text).toBe(LONG_ENOUGH.trim());
    expect(() => pastedResume('Pat Doe, SDET')).toThrow(ResumeFileError);
  });

  it('collapses spaces and blank lines, and removes control characters', () => {
    expect(cleanText('a \t b\u0000c\r\n\r\n\r\n\r\nd  \n  e')).toBe('a b c\n\nd\ne');
  });

  it('cuts text at the cap without splitting a character', () => {
    const text = cleanText('😀'.repeat(RESUME_LIMITS.textChars + 10));
    expect([...text]).toHaveLength(RESUME_LIMITS.textChars);
  });
});

describe('sniffType', () => {
  it('finds a PDF header after a little junk, as readers do', () => {
    expect(sniffType(new Uint8Array(Buffer.from('\n\n%PDF-1.4')))).toBe('pdf');
    expect(sniffType(new Uint8Array(Buffer.from('PK\u0003\u0004')))).toBe('zip');
    expect(sniffType(new Uint8Array())).toBe('unknown');
  });
});
