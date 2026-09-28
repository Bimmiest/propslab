import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  ERROR_DEPTHLIMIT,
  ERROR_MATCHLIMIT,
  getModule,
  init,
  initSync,
  isReady,
  Regex,
  RegexMatchError,
  RegexSyntaxError,
  version,
} from '../src/index.ts';

const wasmPath = new URL('../pcre2.wasm', import.meta.url);
const bytes = readFileSync(wasmPath);
initSync(bytes);

const spans = (re: Regex, s: string) => [...re.matchAll(s)].map((m) => [m.index, m[0]]);

test('the committed module matches its recorded checksum', () => {
  const recorded = readFileSync(new URL('../pcre2.wasm.sha256', import.meta.url), 'utf8').split(/\s+/)[0];
  assert.equal(createHash('sha256').update(bytes).digest('hex'), recorded);
});

test('initialises from bytes, a compiled module, or a promise, and reports its version', async () => {
  assert.ok(isReady());
  assert.match(version(), /^10\.48 /);
  initSync(getModule());
  await init(Promise.resolve(bytes));
  await init(getModule());
  assert.ok(new Regex('a').test('a'));
});

test('offsets are UTF-16 indices, astral characters included', () => {
  const m = new Regex('(.)(x)').exec('é😀x')!;
  assert.equal(m.index, 1);
  assert.equal(m.end, 4);
  assert.equal(m[1], '😀');
  assert.deepEqual(m.indices[1], [1, 3]);
  assert.deepEqual(m.indices[2], [3, 4]);
});

test('named groups, unset groups and duplicate names', () => {
  const m = new Regex('(?<k>\\w+)=(?P<v>\\w+)(x)?').exec(' a=b')!;
  // Null-prototype, like a RegExp's, so a group named __proto__ is just a key.
  assert.equal(Object.getPrototypeOf(m.groups), null);
  assert.deepEqual({ ...m.groups }, { k: 'a', v: 'b' });
  assert.equal(new Regex('(?<__proto__>x)').exec('x')!.groups?.['__proto__'], 'x');
  assert.equal(m[3], undefined);
  assert.equal(m.indices[3], undefined);
  assert.deepEqual(m.indices.groups?.v, [3, 4]);

  const dup = new Regex('(?:(?<n>a)|(?<n>b))', 'J');
  assert.deepEqual(dup.names, ['n']);
  assert.equal(dup.exec('b')!.groups?.n, 'b');
  assert.equal(new Regex('x').exec('x')!.groups, undefined);
});

test('flags', () => {
  assert.ok(new Regex('abc', 'i').test('ABC'));
  assert.ok(new Regex('^b', 'm').test('a\nb'));
  assert.ok(new Regex('a.b', 's').test('a\nb'));
  assert.ok(new Regex('a b # comment', 'x').test('ab'));
  assert.equal(new Regex('(a)', 'n').captureCount, 0);
  assert.equal(new Regex('a+', 'U').exec('aaa')![0], 'a');
  assert.ok(!new Regex('\\w').test('é'));
  assert.ok(new Regex('\\w', 'u').test('é'));
  assert.equal(new Regex('b', 'A').exec('ab'), null);
  assert.ok(!new Regex('a$', 'D').test('a\n'));
  assert.throws(() => new Regex('a', 'g'), /Unknown flag/);
});

test('PCRE semantics JS regexes lack', () => {
  // `$` also matches before a final newline; `\z` does not, `\Z` does.
  assert.ok(new Regex('a$').test('a\n'));
  assert.ok(!new Regex('a\\z').test('a\n'));
  assert.ok(new Regex('a\\Z').test('a\n'));
  // With LF newlines, `.` matches `\r`.
  assert.ok(new Regex('a.b').test('a\rb'));
  assert.ok(!new Regex('a.b').test('a\nb'));
  // `\A` anchors to the subject start even in multiline mode.
  assert.ok(!new Regex('\\Ab', 'm').test('a\nb'));
  // Possessive quantifiers and atomic groups do not give back.
  assert.ok(!new Regex('a++a').test('aaa'));
  assert.ok(!new Regex('(?>a+)a').test('aaa'));
  // Recursion.
  assert.equal(new Regex('\\((?:[^()]|(?R))*\\)').exec('x(a(b)c)y')![0], '(a(b)c)');
  // \K resets the reported start.
  const k = new Regex('foo\\Kbar').exec('foobar')!;
  assert.equal(k[0], 'bar');
  assert.equal(k.index, 3);
  // Conditionals.
  const cond = new Regex('^(<)?\\w+(?(1)>)$');
  assert.ok(cond.test('<a>') && cond.test('a') && !cond.test('<a'));
  // Unicode properties.
  assert.ok(new Regex('^\\p{Lu}').test('Éa'));
});

test('global iteration follows pcre2_next_match', () => {
  assert.deepEqual(spans(new Regex('x*'), 'axxb'), [
    [0, ''],
    [1, 'xx'],
    [3, ''],
    [4, ''],
  ]);
  // After an empty match the same place is retried with non-empty required.
  assert.deepEqual(spans(new Regex('a??'), 'aa'), [
    [0, ''],
    [0, 'a'],
    [1, ''],
    [1, 'a'],
    [2, ''],
  ]);
  assert.deepEqual(spans(new Regex('\\d+'), 'a1b22', ), [
    [1, '1'],
    [3, '22'],
  ]);
  assert.deepEqual(spans(new Regex('\\d'), 'a1b2c3').length, 3);
  assert.deepEqual([...new Regex('\\d').matchAll('123', 1)].map((m) => m[0]), ['2', '3']);
  // An empty match never splits a surrogate pair.
  assert.deepEqual(spans(new Regex(''), '😀'), [
    [0, ''],
    [2, ''],
  ]);
});

test('interleaving patterns does not disturb an iteration in progress', () => {
  const outer = new Regex('\\w');
  const inner = new Regex('(\\d)');
  const seen: string[] = [];
  for (const m of outer.matchAll('a1b')) {
    inner.exec('xyz9');
    seen.push(m[0]);
  }
  assert.deepEqual(seen, ['a', '1', 'b']);
});

test('substitute', () => {
  const re = new Regex('(?<k>\\w+)=(\\w+)');
  assert.equal(re.substitute('a=1 b=2', '$2:${k}'), '1:a b=2');
  assert.equal(re.substitute('a=1 b=2', '$2:${k}', { global: true }), '1:a 2:b');
  assert.equal(re.substitute('a=1 b=2', '$$', { global: true, start: 4 }), 'a=1 $');
  assert.equal(re.substitute('a=1', '\\U$1', { extended: true }), 'A');
  assert.equal(new Regex('(x)?y').substitute('y', '[$1]'), '[]');
  // Output longer than the first buffer guess.
  assert.equal(new Regex('a').substitute('aaaa', 'x'.repeat(100), { global: true }).length, 400);
  assert.throws(() => re.substitute('a=1', '${nope}'), RegexSyntaxError);
});

test('replace with a callback', () => {
  const re = new Regex('\\d+');
  assert.equal(re.replace('a1b22', (m) => `<${m[0]}>`, true), 'a<1>b<22>');
  assert.equal(re.replace('a1b22', (m) => `<${m[0]}>`), 'a<1>b22');
  assert.equal(new Regex('x*').replace('ab', () => '-', true), '-a-b-');
});

test('a pattern PCRE2 rejects throws with the offset', () => {
  try {
    new Regex('ab(c');
    assert.fail('expected a throw');
  } catch (e) {
    assert.ok(e instanceof RegexSyntaxError);
    assert.equal(e.offset, 4);
    assert.match(e.message, /missing closing parenthesis/);
  }
});

test('match and depth limits stop a runaway match', () => {
  const subject = `${'a'.repeat(28)}b`;
  const limited = new Regex('(a+)+$', '', { matchLimit: 10000 });
  assert.throws(
    () => limited.test(subject),
    (e: unknown) => e instanceof RegexMatchError && e.code === ERROR_MATCHLIMIT,
  );
  const deep = new Regex('^(?:a|b)*$', '', { depthLimit: 10 });
  assert.throws(
    () => deep.test('ab'.repeat(50)),
    (e: unknown) => e instanceof RegexMatchError && e.code === ERROR_DEPTHLIMIT,
  );
  // The default limits still stop it, eventually.
  assert.throws(() => new Regex('(a+)+$').test(`${'a'.repeat(40)}b`), RegexMatchError);
});

test('a lone surrogate matches as U+FFFD without shifting offsets', () => {
  const m = new Regex('\\x{FFFD}(b)').exec('a\ud800b')!;
  assert.equal(m.index, 1);
  assert.equal(m[0], '\ud800b');
  assert.deepEqual(m.indices[1], [2, 3]);
});

test('free releases the pattern; using it afterwards throws', () => {
  const re = new Regex('a');
  re.free();
  re.free();
  assert.ok(re.freed);
  assert.throws(() => re.test('a'), /freed/);
});

test('a Regex from an earlier init is refused rather than run', () => {
  const before = new Regex('a');
  initSync(getModule());
  assert.throws(() => before.test('a'), /earlier init/);
});

test('long subjects iterate in linear time', () => {
  const subject = 'x'.repeat(200_000);
  const start = performance.now();
  let n = 0;
  for (const _ of new Regex('x').matchAll(subject)) n++;
  assert.equal(n, 200_000);
  // Quadratic re-validation of the subject would take minutes here.
  assert.ok(performance.now() - start < 5000);
});
