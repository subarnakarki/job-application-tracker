/**
 * A resume's plain text laid out for printing: the first line is the name, common section titles
 * become headings, bullet lines become lists, and every other line stays as it is. Plain text in,
 * so it works for any resume; nothing is reworded or dropped.
 */
export type ResumeBlock =
  | { kind: 'name'; text: string }
  | { kind: 'heading'; text: string }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'line'; text: string };

const BULLET = /^(?:[-•*–·▪◦]|\d{1,2}[.)])\s+/;
const SECTIONS =
  /^(summary|profile|about|experience|work experience|professional experience|employment|education|skills|technical skills|projects|certifications|awards|publications|languages|interests|volunteering|references)$/i;

function isHeading(line: string): boolean {
  if (line.length > 40) return false;
  const bare = line.replace(/:$/, '').trim();
  if (SECTIONS.test(bare)) return true;
  const letters = bare.replace(/[^A-Za-z]/g, '');
  // ALL CAPS ("EXPERIENCE", "SKILLS & TOOLS"), or a short title ending in a colon.
  return (letters.length >= 3 && letters === letters.toUpperCase()) || /^[^.]{2,}:$/.test(line);
}

export function resumeBlocks(text: string): ResumeBlock[] {
  const blocks: ResumeBlock[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (blocks.length === 0) {
      blocks.push({ kind: 'name', text: line });
      continue;
    }
    if (BULLET.test(line)) {
      const item = line.replace(BULLET, '');
      const last = blocks.at(-1);
      if (last?.kind === 'bullets') last.items.push(item);
      else blocks.push({ kind: 'bullets', items: [item] });
      continue;
    }
    if (isHeading(line)) blocks.push({ kind: 'heading', text: line.replace(/:$/, '').trim() });
    else blocks.push({ kind: 'line', text: line });
  }
  return blocks;
}
