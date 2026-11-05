import { describe, expect, it } from 'vitest';
import { csvCell } from './csv';

describe('csvCell', () => {
  it.each([
    [null, ''],
    ['plain', 'plain'],
    [42, '42'],
    [-5, '-5'],
    [true, 'true'],
    ['a,b', '"a,b"'],
    ['say "hi"', '"say ""hi"""'],
    ['line1\nline2', '"line1\nline2"'],
    ['=SUM(A1:A9)', "'=SUM(A1:A9)"],
    ['+1 555', "'+1 555"],
    ['-2+3', "'-2+3"],
    ['@cmd', "'@cmd"],
    ['\tTab', "'\tTab"],
    ['=HYPERLINK("http://x","click")', '"\'=HYPERLINK(""http://x"",""click"")"'],
  ])('%j -> %j', (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });
});
