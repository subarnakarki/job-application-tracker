#!/usr/bin/env bash
# Resume helper for the resume-audit skill.
#
#   resume.sh path                        print the base resume path
#   resume.sh text                        print the base resume text, one paragraph per line
#   resume.sh tailor <slug> [--overwrite] apply resumes/<slug>/edits.json to a copy of the base resume, writing
#                                         resumes/<slug>/<name>.docx and, via Microsoft Word, <name>.pdf
#
# Base resume (first match wins): RESUME_DOCX env var (absolute, ~/, UNC, or repo-relative), else the only *.docx
# directly in resumes/ at the repo root (Word's ~$ lock files are ignored). Not supported: text boxes and tracked
# changes (accept or reject them in Word first).
#
# edits.json is a JSON array, applied in order to the document body (not headers, footers or text boxes). Text is
# matched exactly against `resume.sh text` output and must occur exactly once in the document. Edits apply in
# order, so a later edit to the same line must match that line as already edited.
#   {"old": "text", "new": "text"}    replace text within one paragraph; the new text keeps the formatting of the
#                                     run where the old text starts. "new": "" with a whole paragraph deletes it
#                                     (in a table cell its text is cleared instead); a bullet typed as text in
#                                     front of it ("•  ") counts as part of the paragraph and goes with it.
#   {"after": "text", "new": "text"}  add a paragraph after the one containing "after", with that paragraph's
#                                     settings (bullet, indent, spacing) and font. A bullet typed as text ("•  ")
#                                     is copied too, so leave it out of the new text.
#   {"before": "text", "new": "text"} the same, but the new paragraph goes before the one containing "before".
#                                     Several "before" edits on one line insert in order (each lands just above it).
#   Optional on "after"/"before":
#     "like": "text"                  copy the paragraph settings and font from the paragraph containing "like"
#                                     instead (e.g. a section heading, or a skills line in another section).
#     "label": "text"                 start the new paragraph with this text in the font of the copied
#                                     paragraph's first text, then "new" in the font of its last text: copying a
#                                     "Languages: ..." line gives a bold label and plain text. Put the separator
#                                     and space in the label or new text yourself ("label": "Tools:", "new": " ...").
# New text is plain: no tabs, line breaks or other control characters.
#
# Nothing is written if any edit fails. If Word fails or hangs, the edited copy is kept as <name>.failed.docx.
# Exits 2 (after writing both files) when the tailored resume has more pages than the base.
# Needs Python 3 (standard library only) and, for the PDF, Microsoft Word on Windows.
set -euo pipefail

die() { echo "$*" >&2; exit 1; }

root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
dir="$root/resumes"

# Probe each candidate: on Windows, python3 can be the Microsoft Store stub, which exists but does not run.
py=""
for p in python3 python; do
  if command -v "$p" >/dev/null && "$p" -c 'import sys; assert sys.version_info >= (3, 8)' >/dev/null 2>&1; then
    py="$p"
    break
  fi
done
[ -n "$py" ] || die "Python 3.8+ not found."

if [ -n "${RESUME_DOCX:-}" ]; then
  case "$RESUME_DOCX" in
    "~/"*) docx="$HOME/${RESUME_DOCX#\~/}" ;;
    /* | [A-Za-z]:* | \\\\*) docx="$RESUME_DOCX" ;;
    *) docx="$root/$RESUME_DOCX" ;;
  esac
else
  shopt -s nullglob nocaseglob
  found=()
  for f in "$dir"/*.docx; do
    case "$(basename "$f")" in "~\$"*) ;; *) found+=("$f") ;; esac
  done
  if [ "${#found[@]}" -ne 1 ]; then
    echo "Expected exactly one .docx in $dir, found ${#found[@]}." >&2
    for f in "${found[@]}"; do echo "  $(basename "$f")" >&2; done
    die "Put your resume there, or set RESUME_DOCX to its path."
  fi
  docx="${found[0]}"
fi
[ -f "$docx" ] || die "Resume not found: $docx"
name="$(basename "${docx%.*}")"

# Python helper: text extraction and edits, working directly on word/document.xml (no Word needed).
docx_py() {
  "$py" -I - "$@" <<'PY'
import html, json, re, sys, zipfile

P_RE = re.compile(r'<w:p(?:\s[^>]*?)?(?<!/)>.*?</w:p>', re.S)
# Group 1/2: a text element. The other alternatives are run content that Word shows but that is not editable text:
# they read as the character Word displays, and an edit may not cross them.
TOKEN_RE = re.compile(
    r'(<w:t(?:\s[^>]*?)?(?<!/)>)(.*?)</w:t>'
    r'|<w:t(?:\s[^>]*)?/>'
    r'|<w:(?:tab|ptab)\b[^>]*/>'
    r'|<w:(?:br|cr)\b[^>]*/>'
    r'|<w:noBreakHyphen/>'
    r'|<w:softHyphen/>'
    r'|<w:sym\b[^>]*/>', re.S)
SYM = '□'  # stands in for a Word symbol character in the text output
# A bullet typed as text at the start of a paragraph: one to three symbol characters, then spaces or tabs
# (e.g. "•  " or "•\t").
BULLET_RE = re.compile(r'^[^\w\s]{1,3}[ \t ]+')

def token_text(t):
    s = t.group(0)
    if s.startswith('<w:t'):
        return ''  # empty <w:t/>
    if s.startswith(('<w:tab', '<w:ptab')):
        return '\t'
    if s.startswith(('<w:br', '<w:cr')):
        return ' '
    if s.startswith('<w:noBreakHyphen'):
        return '-'
    if s.startswith('<w:softHyphen'):
        return ''
    return SYM

def read(path):
    with zipfile.ZipFile(path) as z:
        xml = z.read('word/document.xml').decode('utf-8')
    if 'txbxContent' in xml:
        sys.exit('This resume uses text boxes, which resume.sh cannot read or edit.')
    if re.search(r'<w:(?:del|ins|moveFrom|moveTo)\b', xml):
        sys.exit('This resume has tracked changes. Accept or reject them in Word first.')
    return xml

def paragraphs(xml):
    """Yield (start, end, text, chars): chars maps each text index to (token match, offset), or None when the
    character comes from a non-editable token (tab, break, symbol, non-breaking hyphen)."""
    for p in P_RE.finditer(xml):
        text, chars = [], []
        for t in TOKEN_RE.finditer(p.group(0)):
            if t.group(1) is not None:
                s = html.unescape(t.group(2))
                text.append(s)
                chars += [(t, i) for i in range(len(s))]
            else:
                s = token_text(t)
                text.append(s)
                chars += [None] * len(s)
        yield p.start(), p.end(), ''.join(text), chars

def text_of(xml):
    out = []
    for _, _, text, _ in paragraphs(xml):
        if text.strip() or (out and out[-1] != ''):
            out.append(text.rstrip())
    return '\n'.join(out).strip('\n') + '\n'

def find_one(xml, needle, label):
    if not needle:
        sys.exit(f'Edit {label}: empty text.')
    hits = []
    for start, end, text, chars in paragraphs(xml):
        i = text.find(needle)
        while i >= 0:
            hits.append((start, end, text, chars, i))
            i = text.find(needle, i + 1)
    if len(hits) != 1:
        sys.exit(f'Edit {label}: text matched {len(hits)} times (need exactly 1): {needle}')
    return hits[0]

def esc(s):
    return html.escape(s, quote=False)

def set_t(open_tag, s):
    if 'xml:space' not in open_tag:
        open_tag = open_tag[:-1] + ' xml:space="preserve">'
    return f'{open_tag}{esc(s)}</w:t>'

def text_tokens(para):
    return [t for t in TOKEN_RE.finditer(para) if t.group(1) is not None]

def in_table_cell(xml, pos):
    opened = max((m.start() for m in re.finditer(r'<w:tc[\s>]', xml[:pos])), default=-1)
    return opened > xml.rfind('</w:tc>', 0, pos)

def delete_paragraph(xml, start, end, label):
    para = xml[start:end]
    if '<w:sectPr' in para:
        sys.exit(f'Edit {label}: that paragraph ends a section (page layout); clear its text instead of deleting it.')
    if not in_table_cell(xml, start):
        return xml[:start] + xml[end:]
    # A table cell must keep at least one paragraph: clear the text instead.
    out, pos = [], 0
    for t in text_tokens(para):
        out += [para[pos:t.start()], set_t(t.group(1), '')]
        pos = t.end()
    return xml[:start] + ''.join(out) + para[pos:] + xml[end:]

def replace(xml, op, label):
    old, new = op['old'], op['new']
    start, end, text, chars, i = find_one(xml, old, label)
    # Deleting a whole line also removes a typed bullet in front of it, so no empty bullet is left behind.
    if new == '' and old.strip() in (text.strip(), BULLET_RE.sub('', text).strip()):
        return delete_paragraph(xml, start, end, label)
    span = chars[i:i + len(old)]
    if any(c is None for c in span):
        sys.exit(f'Edit {label}: the text crosses a tab, line break, symbol or non-breaking hyphen; '
                 'edit the parts on each side separately.')
    first, last = span[0][0], span[-1][0]
    para = xml[start:end]
    tokens = text_tokens(para)
    a = next(k for k, t in enumerate(tokens) if t.start() == first.start())
    b = next(k for k, t in enumerate(tokens) if t.start() == last.start())
    out, pos = [], 0
    for k, t in enumerate(tokens):
        if k < a or k > b:
            continue
        s = html.unescape(t.group(2))
        if k == a:
            s = s[:span[0][1]] + new + (s[span[-1][1] + 1:] if a == b else '')
        elif k == b:
            s = s[span[-1][1] + 1:]
        else:
            s = ''
        out += [para[pos:t.start()], set_t(t.group(1), s)]
        pos = t.end()
    out.append(para[pos:])
    return xml[:start] + ''.join(out) + xml[end:]

def insert(xml, op, label):
    where = 'after' if isinstance(op.get('after'), str) else 'before'
    start, end, _, _, _ = find_one(xml, op[where], f'{label} ({where})')
    src = op['like'] if isinstance(op.get('like'), str) else op[where]
    s_start, s_end, s_text, s_chars, _ = find_one(xml, src, f'{label} (like)')
    copy = new_paragraph(xml[s_start:s_end], s_text, s_chars, op, label)
    pos = end if where == 'after' else start
    return xml[:pos] + copy + xml[pos:]

def new_paragraph(para, text, chars, op, label):
    tokens = text_tokens(para)
    if not tokens:
        sys.exit(f'Edit {label}: that paragraph has no text to copy formatting from.')
    # Build the new paragraph from the paragraph settings and run formatting only, so nothing else (section
    # breaks, pictures, symbols, fields, bookmarks, ids) is copied.
    ppr = re.search(r'<w:pPr>.*?</w:pPr>', para, re.S)
    ppr = re.sub(r'<w:sectPr\b.*?</w:sectPr>', '', ppr.group(0), flags=re.S) if ppr else ''

    def run_props(token):
        runs = list(re.finditer(r'<w:r(?:\s[^>]*?)?(?<!/)>', para[:token.start()]))
        m = re.match(r'\s*(<w:rPr>.*?</w:rPr>)', para[runs[-1].end():], re.S) if runs else None
        return m.group(1) if m else ''

    # A typed bullet ("•" then a tab) is copied too, in its own formatting; the text gets the formatting of the
    # first text after the bullet.
    bullet = ''
    body = tokens[0]
    m = BULLET_RE.match(text)
    if m:
        after = next((c[0] for c in chars[m.end():] if c is not None), None)
        if after is not None:
            body = after
            parts = re.split(r'(\t)', m.group(0))
            mark = ''.join('<w:tab/>' if p == '\t' else f'<w:t xml:space="preserve">{esc(p)}</w:t>'
                           for p in parts if p)
            bullet = f'<w:r>{run_props(tokens[0])}{mark}</w:r>'
    runs = f'<w:r>{run_props(body)}{set_t("<w:t>", op["new"])}</w:r>'
    if op.get('label'):
        runs = (f'<w:r>{run_props(body)}{set_t("<w:t>", op["label"])}</w:r>'
                f'<w:r>{run_props(tokens[-1])}{set_t("<w:t>", op["new"])}</w:r>')
    return f'<w:p>{ppr}{bullet}{runs}</w:p>'

cmd = sys.argv[1]
if cmd == 'text':
    sys.stdout.reconfigure(encoding='utf-8', newline='\n')
    sys.stdout.write(text_of(read(sys.argv[2])))
elif cmd == 'tailor':
    src, edits, dest = sys.argv[2:5]
    with open(edits, encoding='utf-8-sig') as f:
        ops = json.load(f)
    if not isinstance(ops, list) or not ops:
        sys.exit(f'{edits} must be a non-empty JSON array.')
    xml = read(src)
    for n, op in enumerate(ops, 1):
        if not isinstance(op, dict) or not isinstance(op.get('new'), str):
            sys.exit(f'Edit #{n}: must be an object with a string "new".')
        if re.search(r'[\x00-\x1f￾￿]', op['new']):
            sys.exit(f'Edit #{n}: new text has a tab, line break or control character; use one edit per line.')
        if isinstance(op.get('after'), str) or isinstance(op.get('before'), str):
            if isinstance(op.get('after'), str) and isinstance(op.get('before'), str):
                sys.exit(f'Edit #{n}: use "after" or "before", not both.')
            if not op['new']:
                sys.exit(f'Edit #{n}: "after"/"before" needs non-empty new text.')
            for k in ('like', 'label'):
                if k in op and (not isinstance(op[k], str) or not op[k] or re.search(r'[\x00-\x1f]', op[k])):
                    sys.exit(f'Edit #{n}: "{k}" must be non-empty plain text.')
            xml = insert(xml, op, f'#{n}')
        elif isinstance(op.get('old'), str):
            xml = replace(xml, op, f'#{n}')
        else:
            sys.exit(f"Edit #{n}: needs 'old', 'after' or 'before'.")
    final = text_of(xml)
    news = [op['new'] for op in ops]
    for n, op in enumerate(ops, 1):
        new, old = op['new'], op.get('old')
        if new and (op.get('label') or '') + new not in final:
            sys.exit(f'Edit #{n}: new text not found after editing.')
        # Skip when any edit's new text contains this old text: then it is expected to still be there.
        if old and not any(old in s for s in news) and old.strip() and old in final:
            sys.exit(f'Edit #{n}: old text still present after editing.')
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dest, 'w', zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            data = xml.encode('utf-8') if info.filename == 'word/document.xml' else zin.read(info)
            zout.writestr(info, data)
    print(f'{len(ops)} edits applied.')
PY
}

winpath() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else printf '%s\n' "$1"; fi; }

# PIDs of Word instances started by automation (COM). A Word the user opens never has /Automation on its command
# line, so killing only new ones of these can never close the user's own Word.
automation_word_pids() {
  powershell.exe -NoProfile -NonInteractive -Command \
    "Get-CimInstance Win32_Process -Filter \"Name='WINWORD.EXE'\" | Where-Object { \$_.CommandLine -match '/Automation' } | ForEach-Object { \$_.ProcessId }" |
    tr -d '\r'
}

# Export <docx> to <pdf> with Word and print "<tailored pages> <base pages>". Word runs hidden with a time limit;
# if it hangs (usually a hidden dialog), the automation Word started during this run is killed.
word_export() {
  local before status=0
  before=" $(automation_word_pids | tr '\n' ' ') "
  BASE="$(winpath "$docx")" SRC="$(winpath "$1")" OUT="$(winpath "$2")" \
    timeout 90 powershell.exe -NoProfile -NonInteractive -Command '
$ErrorActionPreference = "Stop"
$word = New-Object -ComObject Word.Application
$base = $null
$doc = $null
try {
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $base = $word.Documents.Open($env:BASE, $false, $true, $false)
  $basePages = $base.ComputeStatistics(2)
  $base.Close(0); $base = $null
  $doc = $word.Documents.Open($env:SRC, $false, $true, $false)
  $pages = $doc.ComputeStatistics(2)
  $doc.ExportAsFixedFormat($env:OUT, 17)
  $doc.Close(0); $doc = $null
  Write-Output "$pages $basePages"
} finally {
  foreach ($d in @($doc, $base)) { if ($d) { try { $d.Close(0) } catch {} } }
  # Quit only when nothing else is open in this instance.
  if ($word.Documents.Count -eq 0) { $word.Quit() }
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word)
}' || status=$?
  if [ "$status" -eq 124 ]; then
    for pid in $(automation_word_pids); do
      case "$before" in *" $pid "*) ;; *) taskkill //PID "$pid" //F >/dev/null 2>&1 || true ;; esac
    done
    die "Word did not finish within 90 seconds (probably a hidden dialog) and was closed."
  fi
  [ "$status" -eq 0 ] || die "Word could not export the PDF (exit $status)."
}

case "${1:-}" in
  path)
    echo "$docx"
    ;;
  text)
    docx_py text "$docx"
    ;;
  tailor)
    slug="${2:-}"
    [[ "$slug" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || die "Usage: resume.sh tailor <kebab-case-slug> [--overwrite]"
    out_dir="$dir/$slug"
    edits="$out_dir/edits.json"
    out_docx="$out_dir/$name.docx"
    out_pdf="$out_dir/$name.pdf"
    [ -f "$edits" ] || die "Missing $edits"
    if { [ -e "$out_docx" ] || [ -e "$out_pdf" ]; } && [ "${3:-}" != "--overwrite" ]; then
      die "A tailored resume already exists in $out_dir; rerun with --overwrite."
    fi
    git -C "$root" check-ignore -q "resumes/$slug/$name.docx" ||
      die "resumes/$slug is not gitignored; refusing to write a resume there."
    tmp="$out_dir/$name.tmp.docx"
    tmp_pdf="$out_dir/$name.tmp.pdf"
    failed="$out_dir/$name.failed.docx"
    trap 'rm -f "$tmp" "$tmp_pdf"' EXIT
    docx_py tailor "$docx" "$edits" "$tmp"
    rm -f "$tmp_pdf" "$failed"
    if ! result="$(word_export "$tmp" "$tmp_pdf")" || [ ! -s "$tmp_pdf" ]; then
      mv -f "$tmp" "$failed" 2>/dev/null || true
      die "No PDF was written. The edited copy is kept at $failed; open it in Word to check."
    fi
    read -r pages base_pages <<<"$(printf '%s' "$result" | tr -d '\r')"
    [[ "${pages:-}" =~ ^[0-9]+$ && "${base_pages:-}" =~ ^[0-9]+$ ]] || die "Unexpected page count from Word: $result"
    mv -f "$tmp_pdf" "$out_pdf"
    mv -f "$tmp" "$out_docx"
    echo "Pages: $pages (base $base_pages)."
    echo "$out_docx"
    echo "$out_pdf"
    if [ "$pages" -gt "$base_pages" ]; then
      echo "Tailored resume is $pages pages, base is $base_pages. Shorten the edits and rerun with --overwrite." >&2
      exit 2
    fi
    ;;
  *)
    die "Usage: resume.sh path | text | tailor <slug> [--overwrite]"
    ;;
esac
