import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { RESUME_LIMITS, type ResumeMediaType } from '@jat/shared';

/**
 * Reads the text out of an uploaded resume. The type comes from the file's first bytes, never its
 * name. Everything is capped (file size, pages, unzipped size, text length), so a hostile file can
 * cost a little CPU but never much memory.
 */

export type ResumeFileFailure =
  'too_large' | 'unsupported_type' | 'unreadable' | 'too_many_pages' | 'no_text';

export class ResumeFileError extends Error {
  constructor(
    readonly code: ResumeFileFailure,
    detail: string,
  ) {
    super(detail);
    this.name = 'ResumeFileError';
  }
}

export interface ExtractedResume {
  mediaType: ResumeMediaType;
  text: string;
  textSha256: string;
}

/** A resume longer than this is not a resume. */
export const MAX_PDF_PAGES = 10;
/** The unzipped size of one part of a DOCX. Real resumes are well under 1 MB. */
export const MAX_DOCX_PART_BYTES = 5 * 1024 * 1024;

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function sniffType(file: Uint8Array): 'pdf' | 'zip' | 'old_word' | 'unknown' {
  const head = Buffer.from(file.subarray(0, 1024)).toString('latin1');
  // The PDF header may follow a little junk; readers accept it within the first kilobyte.
  if (head.includes('%PDF-')) return 'pdf';
  if (head.startsWith('PK\u0003\u0004')) return 'zip';
  if (head.startsWith('ÐÏ\u0011à')) return 'old_word';
  return 'unknown';
}

export async function extractResume(file: Uint8Array): Promise<ExtractedResume> {
  if (file.byteLength > RESUME_LIMITS.fileBytes)
    throw new ResumeFileError('too_large', `${String(file.byteLength)} bytes`);

  const kind = sniffType(file);
  let mediaType: ResumeMediaType;
  let raw: string;
  if (kind === 'pdf') {
    mediaType = 'application/pdf';
    raw = await pdfText(file);
  } else if (kind === 'zip') {
    mediaType = DOCX;
    raw = docxText(file);
  } else {
    throw new ResumeFileError('unsupported_type', kind);
  }
  return finishText(raw, mediaType);
}

/** Pasted text goes through the same clean-up and checks as a file's text. */
export function pastedResume(text: string): ExtractedResume {
  return finishText(text, 'text/plain');
}

function finishText(raw: string, mediaType: ResumeMediaType): ExtractedResume {
  const text = cleanText(raw);
  if (text.length < RESUME_LIMITS.minTextChars)
    throw new ResumeFileError('no_text', `${String(text.length)} characters`);
  return { mediaType, text, textSha256: createHash('sha256').update(text).digest('hex') };
}

/**
 * One space between words, at most one blank line between paragraphs, no control characters (NUL
 * cannot be stored), and no more than the text cap.
 */
export function cleanText(raw: string): string {
  const cleaned = raw
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex -- removing control characters is the point
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return [...cleaned].slice(0, RESUME_LIMITS.textChars).join('').trim();
}

async function pdfText(file: Uint8Array): Promise<string> {
  // Loaded on first use: PDF.js is large and most requests never need it.
  const { extractText, getDocumentProxy } = await import('unpdf');
  let document: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // PDF.js may detach the buffer it is given, so it gets a copy.
    document = await getDocumentProxy(new Uint8Array(file));
  } catch (error) {
    throw new ResumeFileError('unreadable', error instanceof Error ? error.message : 'pdf');
  }
  try {
    if (document.numPages > MAX_PDF_PAGES)
      throw new ResumeFileError('too_many_pages', `${String(document.numPages)} pages`);
    const { text } = await extractText(document, { mergePages: false });
    return text.join('\n\n');
  } catch (error) {
    if (error instanceof ResumeFileError) throw error;
    throw new ResumeFileError('unreadable', error instanceof Error ? error.message : 'pdf');
  } finally {
    // Frees the parser's worker state; the proxy itself has no destroy in this build.
    await document.loadingTask.destroy();
  }
}

// ---------------------------------------------------------------------------------------------
// DOCX: a zip of XML parts. Only the parts with the resume's words are read.

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

/** The body first, then headers and footers (where contact details often live). */
const TEXT_PARTS = /^word\/(document|header\d*|footer\d*)\.xml$/;

export function docxText(file: Uint8Array): string {
  const zip = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  const entries = readCentralDirectory(zip);
  const parts = entries
    .filter((entry) => TEXT_PARTS.test(entry.name))
    .sort((a, b) => partOrder(a.name) - partOrder(b.name) || a.name.localeCompare(b.name));
  if (!parts.some((entry) => entry.name === 'word/document.xml'))
    throw new ResumeFileError('unsupported_type', 'zip without word/document.xml');

  let total = 0;
  const texts: string[] = [];
  for (const entry of parts) {
    const xml = readEntry(zip, entry, MAX_DOCX_PART_BYTES - total);
    total += xml.length;
    texts.push(wordXmlText(xml.toString('utf8')));
  }
  return texts.join('\n\n');
}

function partOrder(name: string): number {
  if (name === 'word/document.xml') return 0;
  return name.startsWith('word/header') ? 1 : 2;
}

function readCentralDirectory(zip: Buffer): ZipEntry[] {
  // The end-of-central-directory record is in the last 64 KB + 22 bytes.
  const searchFrom = Math.max(0, zip.length - 65_557);
  let end = -1;
  for (let at = zip.length - 22; at >= searchFrom; at -= 1) {
    if (zip.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new ResumeFileError('unreadable', 'no end of central directory');

  const count = zip.readUInt16LE(end + 10);
  const size = zip.readUInt32LE(end + 12);
  const offset = zip.readUInt32LE(end + 16);
  if (count === 0xffff || offset === 0xffffffff || offset + size > end)
    throw new ResumeFileError('unreadable', 'zip64 or bad central directory');

  const entries: ZipEntry[] = [];
  let at = offset;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > end || zip.readUInt32LE(at) !== 0x02014b50)
      throw new ResumeFileError('unreadable', 'bad central directory entry');
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    entries.push({
      method: zip.readUInt16LE(at + 10),
      compressedSize: zip.readUInt32LE(at + 20),
      name: zip.toString('utf8', at + 46, at + 46 + nameLength),
      localHeaderOffset: zip.readUInt32LE(at + 42),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readEntry(zip: Buffer, entry: ZipEntry, maxBytes: number): Buffer {
  const at = entry.localHeaderOffset;
  if (at + 30 > zip.length || zip.readUInt32LE(at) !== 0x04034b50)
    throw new ResumeFileError('unreadable', 'bad local header');
  const start = at + 30 + zip.readUInt16LE(at + 26) + zip.readUInt16LE(at + 28);
  const data = zip.subarray(start, start + entry.compressedSize);
  if (data.length !== entry.compressedSize) throw new ResumeFileError('unreadable', 'truncated');
  if (maxBytes <= 0) throw new ResumeFileError('unreadable', 'unzipped too large');

  if (entry.method === 0) {
    if (data.length > maxBytes) throw new ResumeFileError('unreadable', 'unzipped too large');
    return data;
  }
  if (entry.method !== 8)
    throw new ResumeFileError('unreadable', `zip method ${String(entry.method)}`);
  try {
    // Stops inflating at the cap, so a zip bomb never fills memory.
    return inflateRawSync(data, { maxOutputLength: maxBytes });
  } catch (error) {
    throw new ResumeFileError('unreadable', error instanceof Error ? error.message : 'inflate');
  }
}

const XML_TOKENS =
  /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<\/w:p>|<w:tab\s*\/>|<w:(?:br|cr)(?:\s[^>]*)?\/>/g;

/** The words of a WordprocessingML part: text runs, with paragraph ends, tabs and breaks kept. */
export function wordXmlText(xml: string): string {
  let text = '';
  for (const match of xml.matchAll(XML_TOKENS)) {
    const [token, run] = match;
    if (run !== undefined) text += decodeXml(run);
    else if (token === '</w:p>') text += '\n';
    else if (token.startsWith('<w:tab')) text += '\t';
    else text += '\n';
  }
  return text;
}

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith('#')) {
      const code =
        name[1] === 'x' || name[1] === 'X'
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
    }
    return NAMED[name] ?? whole;
  });
}
