// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, as (old, new) pairs, so the output can print `R` lines. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** A file's lines under its own line break (SPEC section 3). */
interface FileLines {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** Matching (SPEC section 5): the first tier at which O occurs at least once wins. */
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every 0-based position where O matches the file's lines at the tier, from `from` on. */
function occurrences(lines: string[], old: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  for (let i = from; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (!tierEq(lines[i + j]!, old[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(lines: string[], old: string[], strict: boolean, from = 0): { tier: number; occs: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const occs = occurrences(lines, old, t, from);
    if (occs.length > 0) return { tier: t, occs };
  }
  return null;
}

/** The first line at or after `from` equal to a one-line anchor, at the first tier with one. */
function findAnchor(lines: string[], anchor: string, strict: boolean, from: number): number | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    for (let i = from; i < lines.length; i++) {
      if (tierEq(lines[i]!, anchor, t)) return i;
    }
  }
  return null;
}

/** One line of N: `ctx` is the O index when it is a context line, else a new (`+`) line. */
interface NewLine {
  text: string;
  ctx: number | null;
}

function spliceLines(lines: string[], at: number, oldLen: number, repl: string[]): string[] {
  return [...lines.slice(0, at), ...repl, ...lines.slice(at + oldLen)];
}

/** Render N over a match at `at`: context lines as the file's own, tier-2 re-indent for the rest. */
function renderNew(old: string[], nlines: NewLine[], at: number, lines: string[], tier: number): string[] {
  const out: string[] = [];
  const f = tier === 2 && old.length > 0 ? leadWs(lines[at]!) : '';
  const p = tier === 2 && old.length > 0 ? leadWs(old[0]!) : '';
  for (const nl of nlines) {
    if (nl.ctx !== null) {
      out.push(lines[at + nl.ctx]!);
      continue;
    }
    const t = nl.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
    else out.push(t);
  }
  return out;
}

function applyAt(lines: string[], at: number, old: string[], nlines: NewLine[], tier: number): string[] {
  return spliceLines(lines, at, old.length, renderNew(old, nlines, at, lines, tier));
}

/** Split hunk/chunk body lines into old lines O and new lines N (SPEC sections 6 and 8). */
function bodyON(body: string[]): { O: string[]; N: NewLine[] } {
  const O: string[] = [];
  const N: NewLine[] = [];
  for (const l of body) {
    if (l.startsWith(' ')) {
      const t = l.slice(1);
      O.push(t);
      N.push({ text: t, ctx: O.length - 1 });
    } else if (l.startsWith('-')) {
      O.push(l.slice(1));
    } else if (l.startsWith('+')) {
      N.push({ text: l.slice(1), ctx: null });
    } else if (l === '') {
      O.push('');
      N.push({ text: '', ctx: O.length - 1 });
    }
  }
  return { O, N };
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Unified diffs (SPEC section 6). */
interface Hunk {
  a: number;
  body: string[];
  noEol: boolean;
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renOld: string | null;
  renNew: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const gitRe = /^diff --git a\/(.+) b\/(.+)$/;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const sections: Section[] = [];
  let cur: Section | null = null;
  let header = false;
  const fresh = (gO: string | null, gN: string | null): Section => {
    const s: Section = { gitOld: gO, gitNew: gN, pairOld: null, pairNew: null, renOld: null, renNew: null, create: false, del: false, hunks: [] };
    sections.push(s);
    cur = s;
    header = true;
    return s;
  };
  const pathAfter = (l: string): string => {
    const t = l.slice(4);
    const tab = t.indexOf('\t');
    return (tab >= 0 ? t.slice(0, tab) : t).trim();
  };
  const stripAB = (p: string): string | null => {
    if (p === '/dev/null') return null;
    if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
    return p;
  };
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = gitRe.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      fresh(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (l.startsWith('--- ')) {
      const nx = lines[i + 1];
      if (nx !== undefined && nx.startsWith('+++ ')) {
        const o = stripAB(pathAfter(l));
        const nw = stripAB(pathAfter(nx));
        if (cur === null || !header || cur.pairOld !== null || cur.pairNew !== null) fresh(null, null);
        cur!.pairOld = o;
        cur!.pairNew = nw;
        i += 2;
        continue;
      }
      if (cur !== null && header) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (l.startsWith('+++ ')) {
      if (cur !== null && header && cur.pairNew === null) cur.pairNew = stripAB(pathAfter(l));
      i++;
      continue;
    }
    if (l.startsWith('rename from ') && cur !== null && header && cur.renOld === null) {
      cur.renOld = l.slice(12).trim();
      i++;
      continue;
    }
    if (l.startsWith('rename to ') && cur !== null && header && cur.renNew === null) {
      cur.renNew = l.slice(10).trim();
      i++;
      continue;
    }
    if (l.startsWith('new file mode') && cur !== null && header) {
      cur.create = true;
      i++;
      continue;
    }
    if (l.startsWith('deleted file mode') && cur !== null && header) {
      cur.del = true;
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      const body: string[] = [];
      let j = i + 1;
      while (j < n) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\') || bl === '') {
          body.push(bl);
          j++;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      let noEol = false;
      for (let k = body.length - 1; k >= 0; k--) {
        const bl = body[k]!;
        if (bl.startsWith(' ') || bl.startsWith('+') || bl === '') {
          if (k + 1 < body.length && body[k + 1]!.startsWith('\\')) noEol = true;
          break;
        }
      }
      cur.hunks.push({ a, body, noEol });
      header = false;
      i = j;
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(before);
  let lines = f.lines;
  let final = f.final;
  let d = 0;
  for (const h of hunks) {
    const { O, N } = bodyON(h.body);
    if (O.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, lines.length));
      const wasLen = lines.length;
      lines = spliceLines(lines, at, 0, N.map((nl) => nl.text));
      if (at === wasLen) final = !h.noEol;
      d += N.length;
    } else {
      const found = findTier(lines, O, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occs[0]!;
      for (const o of found.occs) {
        if (Math.abs(o - target) < Math.abs(best - target)) best = o;
      }
      const touchesEnd = best + O.length === lines.length;
      lines = applyAt(lines, best, O, N, found.tier);
      if (touchesEnd) final = !h.noEol;
      d += N.length - O.length;
    }
  }
  return joinFile({ br: f.br, lines, final });
}

function unifiedSectionEdit(s: Section, strict: boolean): Edit {
  const oldP = s.pairOld ?? s.renOld ?? s.gitOld;
  const newP = s.pairNew ?? s.renNew ?? s.gitNew;
  const isCreate = oldP === null || s.create;
  const isDelete = !isCreate && (newP === null || s.del);
  const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
  return (tree) => {
    if (isCreate) {
      if (newP === null) throw new Fail('unsafe', '');
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let lastPlus: { h: Hunk; idx: number } | null = null;
      for (const h of s.hunks) {
        h.body.forEach((bl, idx) => {
          if (bl.startsWith('+')) {
            plus.push(bl.slice(1));
            lastPlus = { h, idx };
          }
        });
      }
      let noEol = false;
      if (lastPlus !== null) {
        const { h, idx } = lastPlus;
        if (idx + 1 < h.body.length && h.body[idx + 1]!.startsWith('\\')) noEol = true;
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldP === null) throw new Fail('unsafe', '');
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const op = oldP as string;
    if (!safe(op)) throw new Fail('unsafe', op);
    if (isMove) {
      const np = newP as string;
      if (!safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const out = applyHunks(before, s.hunks, strict, op);
      tree.now.set(np, out);
      tree.now.set(op, null);
      tree.moves.push([op, np]);
      return;
    }
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    tree.now.set(op, applyHunks(before, s.hunks, strict, op));
  };
}

/** SEARCH/REPLACE blocks (SPEC section 7). */
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    let eq = -1;
    let gt = -1;
    for (let j = s + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (eq === -1 && t === '=======') {
        eq = j;
        continue;
      }
      if (eq !== -1 && t === '>>>>>>> REPLACE') {
        gt = j;
        break;
      }
    }
    if (eq === -1 || gt === -1) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(srEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, gt), strict));
    prevPath = path;
    prevEnd = gt;
    i = gt + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occs.length > 1) throw new Fail('ambiguous', path);
    const nlines: NewLine[] = newLines.map((t) => ({ text: t, ctx: null }));
    tree.now.set(path, joinFile({ br: f.br, lines: applyAt(f.lines, found.occs[0]!, oldLines, nlines, found.tier), final: f.final }));
  };
}

/** V4A patches (SPEC section 8). */
interface Chunk {
  anchor: string | null;
  eof: boolean;
  O: string[];
  N: NewLine[];
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const collect = (start: number): { next: number; raw: string[] } => {
    let j = start;
    while (j < last && !isSectionStart(lines[j]!)) j++;
    const raw = lines.slice(start, j);
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    return { next: j, raw };
  };
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const p = l.slice(14).trim();
      const { next, raw } = collect(i + 1);
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const rl = raw[k]!;
        if (rl.startsWith('+')) fileLines.push(rl.slice(1));
        else if (rl === '') fileLines.push('');
        else throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push(v4aAddEdit(p, fileLines));
      i = next;
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const p = l.slice(17).trim();
      const { next, raw } = collect(i + 1);
      for (let k = 0; k < raw.length; k++) {
        if (!blank(raw[k]!)) throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      edits.push(v4aDeleteEdit(p));
      i = next;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const p = l.slice(17).trim();
      const { next, raw } = collect(i + 1);
      let moveTo: string | null = null;
      let k = 0;
      if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.slice(13).trim();
        k = 1;
      }
      const chunks: Chunk[] = [];
      let cur: { anchor: string | null; eof: boolean; body: string[] } | null = null;
      const close = (): void => {
        if (cur === null) return;
        const { O, N } = bodyON(cur.body);
        chunks.push({ anchor: cur.anchor, eof: cur.eof, O, N });
        cur = null;
      };
      for (; k < raw.length; k++) {
        const rl = raw[k]!;
        if (rl.startsWith('@@')) {
          close();
          const a = rl.slice(2).trim();
          cur = { anchor: a === '' ? null : a, eof: false, body: [] };
        } else if (rl === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 2 + k}`);
          cur.eof = true;
          close();
        } else if (rl.startsWith(' ') || rl.startsWith('-') || rl.startsWith('+') || rl === '') {
          if (cur === null) cur = { anchor: null, eof: false, body: [] };
          cur.body.push(rl);
        } else {
          throw new Exit2(`error: parse ${i + 2 + k}`);
        }
      }
      close();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(v4aUpdateEdit(p, moveTo, chunks, strict));
      i = next;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function findChunkOcc(lines: string[], O: string[], strict: boolean, from: number, eof: boolean): { at: number; tier: number } | null {
  const found = findTier(lines, O, strict, from);
  if (found === null) return null;
  if (!eof) return { at: found.occs[0]!, tier: found.tier };
  for (const o of found.occs) {
    if (o + O.length === lines.length) return { at: o, tier: found.tier };
  }
  return null;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: Chunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let lines = f.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(lines, ch.anchor, strict, cursor);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      if (ch.O.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        const repl = ch.N.map((nl) => nl.text);
        lines = spliceLines(lines, at, 0, repl);
        cursor = at + repl.length;
      } else {
        const found = findChunkOcc(lines, ch.O, strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        lines = applyAt(lines, found.at, ch.O, ch.N, found.tier);
        cursor = found.at + ch.N.length;
      }
    }
    const out = joinFile({ br: f.br, lines, final: f.final });
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // A successful move prints one `R <old> -> <new>` line, sorted by <new>, when the old path
  // existed before the patch and is gone after it and the new path is new; chains collapse
  // to a single line from the first old path to the last new path.
  const moveTo = new Map<string, string>();
  for (const [o, n] of tree.moves) moveTo.set(o, n);
  const isDest = new Set(moveTo.values());
  const covered = new Set<string>();
  const doneStarts = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const [start] of tree.moves) {
    if (doneStarts.has(start) || isDest.has(start)) continue;
    doneStarts.add(start);
    let end = start;
    const seen = new Set<string>([start]);
    while (moveTo.has(end)) {
      const nx = moveTo.get(end)!;
      if (seen.has(nx)) {
        end = start;
        break;
      }
      seen.add(nx);
      end = nx;
    }
    if (end === start) continue;
    if (tree.original(start) !== null && tree.get(start) === null && tree.original(end) === null && tree.get(end) !== null) {
      rows.push({ key: end, text: `R ${start} -> ${end}` });
      covered.add(start);
      covered.add(end);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const texts = rows.map((r) => r.text);
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...texts, `ok: ${texts.length} ${texts.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
