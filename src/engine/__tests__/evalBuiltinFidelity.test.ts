// Table-driven fidelity check for every eval builtin (#512).
//
// Builtin fidelity was found defective one function at a time (trim ignoring
// its second argument, multivalue compare, NULL arguments past the first).
// One table probes every function the same ways: NULL in each argument
// position, a multivalue in each argument position, a non-finite result, an
// empty string and a non-BMP character.
//
// Doc-derived (Splunk Enterprise Search Reference, "Evaluation functions"),
// not captured from a running Splunk; no fixture covers eval, so every row
// cites the page section it relies on and is kept to what that section says.
// A row whose documented behaviour is unclear is a TODO with the reason, never
// an assertion of whatever the simulator happens to do.
import { describe, it, expect } from 'vitest';
import { evaluateExpression } from '../processors/eval/evaluator';
import { builtinNames } from '../processors/eval/builtins';
import type { EvalValue } from '../processors/eval/values';
import type { SplunkEvent } from '../types';

type Fields = Record<string, string | string[]>;

function event(fields: Fields): SplunkEvent {
  return {
    _raw: 'raw',
    _time: null,
    _meta: {},
    fields,
    metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
    lineNumbers: { start: 1, end: 1 },
    processingTrace: [],
  };
}

const run = (expr: string, fields: Fields = {}) =>
  evaluateExpression(expr, event(fields), undefined, 0);

// ── Citations ───────────────────────────────────────────

const BASE = 'Evaluation functions';
const TEXT = `${BASE} > Text functions`;
const MATH = `${BASE} > Mathematical functions`;
const MV = `${BASE} > Multivalue eval functions`;
const CONV = `${BASE} > Conversion functions`;
const INFO = `${BASE} > Informational functions`;
const COND = `${BASE} > Comparison and Conditional functions`;
const TIME = `${BASE} > Date and Time functions`;
const CRYPTO = `${BASE} > Cryptographic functions`;
/** The general rule for an argument that is NULL. */
const NULL_RULE = `${BASE} overview: a function given a NULL (nonexistent) field returns NULL`;
/** The rule the Math functions page states for a result that is not a number (see #446). */
const NOT_A_NUMBER = `${MATH}: no numeric result is NULL (Splunk shows no NaN or Infinity); #446`;

// ── Rows ────────────────────────────────────────────────

interface Row {
  fn: string;
  expr: string;
  fields: Fields;
  /** The value, or a predicate over it. */
  expected: EvalValue | ((v: EvalValue) => boolean);
  doc: string;
}
interface Todo {
  fn: string;
  expr: string;
  why: string;
  fields: Fields;
}

const rows: Row[] = [];
const todos: Todo[] = [];

/** One asserted row. */
function row(fn: string, expr: string, expected: Row['expected'], doc: string, fields: Fields = {}): void {
  rows.push({ fn, expr, expected, doc, fields });
}
/** A case whose documented behaviour is unclear: listed, not asserted. */
function todo(fn: string, expr: string, why: string, fields: Fields = {}): void {
  todos.push({ fn, expr, why, fields });
}
/** Every expression is NULL: the NULL-in, NULL-out rule. */
function nulls(fn: string, exprs: string[], doc: string = NULL_RULE): void {
  for (const e of exprs) row(fn, e, null, doc);
}

const MV_UNDOCUMENTED = 'the docs do not say what a multivalue argument does here';
const MV_AB = { mv: ['a', 'b'] };

// Text ────────────────────────────────────────────────────

nulls('lower', ['lower(missing)']);
row('lower', 'lower("")', '', `${TEXT} > lower(X)`);
row('lower', 'lower("😀A")', '😀a', `${TEXT} > lower(X)`);
todo('lower', 'lower(mv)', MV_UNDOCUMENTED, MV_AB);

nulls('upper', ['upper(missing)']);
row('upper', 'upper("")', '', `${TEXT} > upper(X)`);
row('upper', 'upper("😀a")', '😀A', `${TEXT} > upper(X)`);
todo('upper', 'upper(mv)', MV_UNDOCUMENTED, MV_AB);

nulls('len', ['len(missing)']);
row('len', 'len("")', 0, `${TEXT} > len(X)`);
row('len', 'len("abc")', 3, `${TEXT} > len(X)`);
todo('len', 'len("😀")', 'documented as characters (1); the simulator counts UTF-16 units (2): #446 item 4');
todo('len', 'len(mv)', MV_UNDOCUMENTED, MV_AB);

nulls('substr', ['substr(missing, 1)', 'substr("abc", missing)', 'substr("abc", 1, missing)']);
row('substr', 'substr("", 1)', '', `${TEXT} > substr(X,Y,Z)`);
row('substr', 'substr("abc", 2, 1)', 'b', `${TEXT} > substr(X,Y,Z): 1-based start`);
todo('substr', 'substr("😀abc", 2)', 'documented as characters; the simulator slices UTF-16 units: #446 item 4');
todo('substr', 'substr(mv, 1)', MV_UNDOCUMENTED, MV_AB);
todo('substr', 'substr("abc", mv)', MV_UNDOCUMENTED, MV_AB);
todo('substr', 'substr("abc", 1, mv)', MV_UNDOCUMENTED, MV_AB);

nulls('replace', ['replace(missing, "a", "b")']);
row('replace', 'replace("", "a", "b")', '', `${TEXT} > replace(X,Y,Z)`);
row('replace', 'replace("a😀b", "😀", "X")', 'aXb', `${TEXT} > replace(X,Y,Z)`);
row('replace', 'replace("abc", "b", "X")', 'aXc', `${TEXT} > replace(X,Y,Z)`);
todo('replace', 'replace("abc", missing, "X")', 'the docs do not say what a NULL regex or replacement gives');
todo('replace', 'replace("abc", "b", missing)', 'the docs do not say what a NULL regex or replacement gives');
todo('replace', 'replace(mv, "a", "b")', MV_UNDOCUMENTED, MV_AB);

for (const fn of ['trim', 'ltrim', 'rtrim']) {
  const sides = fn === 'trim' ? 'both sides' : fn === 'ltrim' ? 'the left side' : 'the right side';
  const doc = `${TEXT} > ${fn}(X,Y): removes the characters in Y from ${sides}`;
  nulls(fn, [`${fn}(missing)`, `${fn}(missing, "x")`]);
  row(fn, `${fn}("")`, '', doc);
  row(fn, `${fn}("", "x")`, '', doc);
  row(fn, `${fn}("😀a😀", "😀")`, fn === 'trim' ? 'a' : fn === 'ltrim' ? 'a😀' : '😀a', doc);
  todo(fn, `${fn}("abc", missing)`, 'the docs do not say what a NULL character set gives');
  todo(fn, `${fn}(mv)`, MV_UNDOCUMENTED, MV_AB);
  todo(fn, `${fn}("abc", mv)`, MV_UNDOCUMENTED, MV_AB);
}
row('trim', 'trim("xyyx", "x")', 'yy', `${TEXT} > trim(X,Y): removes the characters in Y from both sides`);
row('ltrim', 'ltrim("xyyx", "x")', 'yyx', `${TEXT} > ltrim(X,Y)`);
row('rtrim', 'rtrim("xyyx", "x")', 'xyy', `${TEXT} > rtrim(X,Y)`);

nulls('urldecode', ['urldecode(missing)']);
row('urldecode', 'urldecode("")', '', `${TEXT} > urldecode(X)`);
row('urldecode', 'urldecode("%F0%9F%98%80")', '😀', `${TEXT} > urldecode(X)`);
todo('urldecode', 'urldecode(mv)', MV_UNDOCUMENTED, MV_AB);

nulls('split', ['split(missing, ",")', 'split("a,b", missing)']);
row('split', 'split("a😀b", "😀")', ['a', 'b'], `${MV} > split(X,"Y")`);
row('split', 'split("a,b", ",")', ['a', 'b'], `${MV} > split(X,"Y")`);
todo('split', 'split("", ",")', 'the docs do not say whether an empty string gives no values or one empty value');
todo('split', 'split(mv, ",")', MV_UNDOCUMENTED, MV_AB);
todo('split', 'split("a,b", mv)', MV_UNDOCUMENTED, MV_AB);

nulls('mvjoin', ['mvjoin(missing, ",")', 'mvjoin(mv, missing)']);
row('mvjoin', 'mvjoin(mv, ",")', 'a,b', `${MV} > mvjoin(MVFIELD,STR)`, MV_AB);
row('mvjoin', 'mvjoin(mv, "")', 'ab', `${MV} > mvjoin(MVFIELD,STR)`, MV_AB);
row('mvjoin', 'mvjoin(mv, "😀")', 'a😀b', `${MV} > mvjoin(MVFIELD,STR)`, MV_AB);
row('mvjoin', 'mvjoin("", ",")', '', `${MV} > mvjoin(MVFIELD,STR): a single empty value joins to itself`);
todo('mvjoin', 'mvjoin("a", mv)', MV_UNDOCUMENTED, MV_AB);

nulls('nullif', ['nullif(missing, "x")']);
row('nullif', 'nullif("", "")', null, `${COND} > nullif(X,Y): NULL when X and Y are equal`);
row('nullif', 'nullif("😀", "😀")', null, `${COND} > nullif(X,Y)`);
row('nullif', 'nullif("a", "b")', 'a', `${COND} > nullif(X,Y)`);
todo('nullif', 'nullif("a", missing)', 'the docs do not say how a NULL second argument compares');
todo('nullif', 'nullif(mv, "a")', MV_UNDOCUMENTED, MV_AB);
todo('nullif', 'nullif("a", mv)', MV_UNDOCUMENTED, MV_AB);

// Conversion ──────────────────────────────────────────────

nulls('tonumber', ['tonumber(missing)']);
row('tonumber', 'tonumber("")', null, `${CONV} > tonumber(NUMSTR,BASE): no number is NULL`);
row('tonumber', 'tonumber("😀")', null, `${CONV} > tonumber(NUMSTR,BASE): no number is NULL`);
row('tonumber', 'tonumber("1e3")', 1000, `${CONV} > tonumber(NUMSTR,BASE)`);
row('tonumber', 'tonumber("ff", 16)', 255, `${CONV} > tonumber(NUMSTR,BASE)`);
todo('tonumber', 'tonumber("ff", missing)', 'the docs do not say what a NULL base gives');
todo('tonumber', 'tonumber("Infinity")', 'the docs do not say whether the text Infinity or NaN is a number');
todo('tonumber', 'tonumber(mv)', MV_UNDOCUMENTED, MV_AB);
todo('tonumber', 'tonumber("ff", mv)', MV_UNDOCUMENTED, MV_AB);

nulls('tostring', ['tostring(missing)']);
row('tostring', 'tostring("")', '', `${CONV} > tostring(X,Y)`);
row('tostring', 'tostring("😀")', '😀', `${CONV} > tostring(X,Y)`);
row('tostring', 'tostring(5)', '5', `${CONV} > tostring(X,Y)`);
todo('tostring', 'tostring(1==1)', 'documented "True"; the simulator gives "true": #446 item 2');
todo('tostring', 'tostring(255, missing)', 'the docs do not say what a NULL format gives');
todo('tostring', 'tostring(mv)', MV_UNDOCUMENTED, MV_AB);

// Informational ───────────────────────────────────────────

row('typeof', 'typeof(missing)', 'Invalid', `${INFO} > typeof(X): a nonexistent field is Invalid`);
row('typeof', 'typeof("")', 'String', `${INFO} > typeof(X)`);
row('typeof', 'typeof("😀")', 'String', `${INFO} > typeof(X)`);
row('typeof', 'typeof(sqrt(-1))', 'Invalid', NOT_A_NUMBER);
todo('typeof', 'typeof(mv)', 'the docs list the possible type names without saying which a multivalue field gets', MV_AB);

row('isnull', 'isnull(missing)', true, `${INFO} > isnull(X)`);
row('isnull', 'isnull("")', false, `${INFO} > isnull(X): an empty string is a value`);
row('isnull', 'isnull(sqrt(-1))', true, NOT_A_NUMBER);
row('isnull', 'isnull(mv)', false, `${INFO} > isnull(X): a field with values is not NULL`, MV_AB);

row('isnotnull', 'isnotnull(missing)', false, `${INFO} > isnotnull(X)`);
row('isnotnull', 'isnotnull("")', true, `${INFO} > isnotnull(X): an empty string is a value`);
row('isnotnull', 'isnotnull(sqrt(-1))', false, NOT_A_NUMBER);
row('isnotnull', 'isnotnull(mv)', true, `${INFO} > isnotnull(X)`, MV_AB);

for (const [fn, yes] of [['isint', '3'], ['isnum', '3.5'], ['isstr', '"a"'], ['isbool', '1==1']] as const) {
  const doc = `${INFO} > ${fn}(X)`;
  row(fn, `${fn}(missing)`, false, `${doc}: a nonexistent field is none of these types`);
  row(fn, `${fn}(${yes})`, true, doc);
  todo(fn, `${fn}(mv)`, MV_UNDOCUMENTED, MV_AB);
}
row('isnum', 'isnum("")', false, `${INFO} > isnum(X)`);
row('isnum', 'isnum("😀")', false, `${INFO} > isnum(X)`);
row('isnum', 'isnum(sqrt(-1))', false, NOT_A_NUMBER);
row('isint', 'isint("")', false, `${INFO} > isint(X)`);
row('isstr', 'isstr("")', true, `${INFO} > isstr(X)`);
row('isstr', 'isstr("😀")', true, `${INFO} > isstr(X)`);
row('isbool', 'isbool("")', false, `${INFO} > isbool(X)`);

// Math ────────────────────────────────────────────────────

for (const fn of ['abs', 'ceiling', 'ceil', 'floor', 'sqrt', 'ln', 'exp', 'round']) {
  nulls(fn, [`${fn}(missing)`]);
  nulls(fn, [`${fn}("")`, `${fn}("😀")`], `${MATH} > ${fn}(X): a non-numeric argument is NULL`);
  todo(fn, `${fn}(mv)`, MV_UNDOCUMENTED, MV_AB);
}
todo('round', 'round(1.5, missing)', 'the docs do not say what a NULL precision gives (the simulator rounds to 0 places)');
todo('round', 'round(1.5, mv)', MV_UNDOCUMENTED, MV_AB);
row('round', 'round(2.5)', 3, `${MATH} > round(X,Y)`);
row('round', 'round(1.234, 2)', 1.23, `${MATH} > round(X,Y)`);
row('abs', 'abs(-3)', 3, `${MATH} > abs(X)`);
row('ceiling', 'ceiling(1.2)', 2, `${MATH} > ceiling(X)`);
row('ceil', 'ceil(1.2)', 2, `${MATH} > ceiling(X): ceil is its alias`);
row('floor', 'floor(1.8)', 1, `${MATH} > floor(X)`);
row('sqrt', 'sqrt(16)', 4, `${MATH} > sqrt(X)`);
row('exp', 'exp(0)', 1, `${MATH} > exp(X)`);
row('ln', 'ln(1)', 0, `${MATH} > ln(X)`);

row('sqrt', 'sqrt(-1)', null, NOT_A_NUMBER);
row('ln', 'ln(0)', null, NOT_A_NUMBER);
row('ln', 'ln(-1)', null, NOT_A_NUMBER);
row('exp', 'exp(1000)', null, NOT_A_NUMBER);
row('round', 'round(1, 400)', null, NOT_A_NUMBER);
row('log', 'log(0)', null, NOT_A_NUMBER);
row('log', 'log(-1)', null, NOT_A_NUMBER);
row('log', 'log(10, 1)', null, NOT_A_NUMBER);
row('pow', 'pow(0, -1)', null, NOT_A_NUMBER);
row('pow', 'pow(-8, 0.5)', null, NOT_A_NUMBER);
row('pow', 'pow(10, 1000)', null, NOT_A_NUMBER);
row('abs', 'abs(sqrt(-1))', null, NOT_A_NUMBER);
row('sqrt', 'sqrt(-1) + 1', null, `${NOT_A_NUMBER}; NULL propagates through arithmetic`);

nulls('pow', ['pow(missing, 2)', 'pow(2, missing)']);
nulls('pow', ['pow("", 2)', 'pow(2, "😀")'], `${MATH} > pow(X,Y): a non-numeric argument is NULL`);
row('pow', 'pow(2, 10)', 1024, `${MATH} > pow(X,Y)`);
todo('pow', 'pow(mv, 2)', MV_UNDOCUMENTED, MV_AB);
todo('pow', 'pow(2, mv)', MV_UNDOCUMENTED, MV_AB);

nulls('log', ['log(missing)', 'log(8, missing)']);
nulls('log', ['log("")', 'log(8, "😀")'], `${MATH} > log(X,Y): a non-numeric argument is NULL`);
row('log', 'log(100)', 2, `${MATH} > log(X,Y): base 10 by default`);
row('log', 'log(8, 2)', 3, `${MATH} > log(X,Y)`);
todo('log', 'log(mv)', MV_UNDOCUMENTED, MV_AB);
todo('log', 'log(8, mv)', MV_UNDOCUMENTED, MV_AB);

row('pi', 'pi()', Math.PI, `${MATH} > pi()`);

row('random', 'random()', (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 2 ** 31,
  `${MATH} > random(): an integer from 0 to 2^31-1`);

row('min', 'min(missing)', null, `${COND} > min(X,...): NULL values are not candidates`);
row('min', 'min(missing, 3)', 3, `${COND} > min(X,...): NULL values are not candidates`);
row('max', 'max(missing)', null, `${COND} > max(X,...): NULL values are not candidates`);
row('max', 'max(3, missing)', 3, `${COND} > max(X,...): NULL values are not candidates`);
row('min', 'min("", "a")', '', `${COND} > min(X,...): strings compare lexicographically`);
row('max', 'max("", "a")', 'a', `${COND} > max(X,...): strings compare lexicographically`);
row('max', 'max("😀", "a")', '😀', `${COND} > max(X,...): strings compare lexicographically`);
row('min', 'min(1, "a")', 1, `${COND} > min(X,...): numbers order before strings`);
row('max', 'max(sqrt(-1), 2)', 2, `${NOT_A_NUMBER}; a NULL is not a candidate`);
todo('min', 'min(mv)', 'the docs do not say whether the values of a multivalue field are candidates', MV_AB);
todo('max', 'max(mv, "z")', 'the docs do not say whether the values of a multivalue field are candidates', MV_AB);
todo('exact', 'exact(1.1 + 2.2)', 'not simulated (returns the value unrounded, with a warning)');
todo('sigfig', 'sigfig(3.14159)', 'not simulated (returns the value unrounded, with a warning)');

// Multivalue ──────────────────────────────────────────────

row('mvcount', 'mvcount(missing)', null, `${MV} > mvcount(MVFIELD): NULL for a nonexistent field`);
row('mvcount', 'mvcount(mv)', 2, `${MV} > mvcount(MVFIELD)`, MV_AB);
row('mvcount', 'mvcount("😀")', 1, `${MV} > mvcount(MVFIELD): a single value counts as 1`);
todo('mvcount', 'mvcount("")', 'the docs do not say whether an empty string is one value or none');

row('mvindex', 'mvindex(missing, 0)', null, `${MV} > mvindex(MVFIELD,STARTINDEX,ENDINDEX): nothing to index is NULL`);
row('mvindex', 'mvindex(mv, 0)', 'a', `${MV} > mvindex(MVFIELD,STARTINDEX,ENDINDEX): 0-based`, MV_AB);
row('mvindex', 'mvindex(mv, -1)', 'b', `${MV} > mvindex(MVFIELD,STARTINDEX,ENDINDEX): negative counts from the end`, MV_AB);
row('mvindex', 'mvindex(mv, 0, 1)', ['a', 'b'], `${MV} > mvindex(MVFIELD,STARTINDEX,ENDINDEX)`, MV_AB);
row('mvindex', 'mvindex("", 0)', '', `${MV} > mvindex(MVFIELD,STARTINDEX,ENDINDEX): an empty string is a value`);
row('mvindex', 'mvindex(split("😀,b", ","), 0)', '😀', `${MV} > mvindex(MVFIELD,STARTINDEX,ENDINDEX)`);
todo('mvindex', 'mvindex(mv, missing)', 'the docs do not say what a NULL index gives', MV_AB);
todo('mvindex', 'mvindex(mv, 0, missing)', 'the docs do not say what a NULL index gives', MV_AB);
todo('mvindex', 'mvindex(mv, mv)', MV_UNDOCUMENTED, MV_AB);

todo('mvfilter', 'mvfilter(mv != "a")', 'not simulated (returns the field unfiltered, with a warning)', MV_AB);

row('mvappend', 'mvappend(mv, "c")', ['a', 'b', 'c'], `${MV} > mvappend(...)`, MV_AB);
row('mvappend', 'mvappend("😀", "a")', ['😀', 'a'], `${MV} > mvappend(...)`);
todo('mvappend', 'mvappend(missing)', 'whether a NULL-only append is NULL or an empty multivalue is open: #446 item 3');
todo('mvappend', 'mvappend("", "a")', 'the docs do not say whether an empty string is appended as a value');

row('mvdedup', 'mvdedup(split("a,b,a", ","))', ['a', 'b'], `${MV} > mvdedup(MVFIELD): duplicates removed, order kept`);
row('mvdedup', 'mvdedup(split("😀,😀", ","))', ['😀'], `${MV} > mvdedup(MVFIELD)`);
todo('mvdedup', 'mvdedup(missing)', 'whether a NULL argument is NULL or an empty multivalue is open: #446 item 3');
todo('mvdedup', 'mvdedup("")', 'the docs do not say what a single empty string gives');

row('mvsort', 'mvsort(split("b,a", ","))', ['a', 'b'], `${MV} > mvsort(X): lexicographic order`);
todo('mvsort', 'mvsort(split("10,9", ","))',
  'documented as sorting numbers numerically before strings ("9","10"); the simulator sorts as strings');
todo('mvsort', 'mvsort(missing)', 'whether a NULL argument is NULL or an empty multivalue is open: #446 item 3');
todo('mvsort', 'mvsort("")', 'the docs do not say what a single empty string gives');

row('mvfind', 'mvfind(missing, "a")', null, `${MV} > mvfind(MVFIELD,"REGEX"): no match is NULL`);
row('mvfind', 'mvfind(mv, "b")', 1, `${MV} > mvfind(MVFIELD,"REGEX"): the 0-based index of the first match`, MV_AB);
row('mvfind', 'mvfind(mv, "z")', null, `${MV} > mvfind(MVFIELD,"REGEX"): no match is NULL`, MV_AB);
row('mvfind', 'mvfind(split("x,😀", ","), "😀")', 1, `${MV} > mvfind(MVFIELD,"REGEX")`);
todo('mvfind', 'mvfind(mv, missing)', 'the docs do not say what a NULL regex gives', MV_AB);
todo('mvfind', 'mvfind("", "^$")', 'the docs do not say whether an empty string is a value to match');

row('mvzip', 'mvzip(a, b, "-")', ['1-x', '2-y'], `${MV} > mvzip(MVFIELD_X,MVFIELD_Y,"Z")`, { a: ['1', '2'], b: ['x', 'y'] });
row('mvzip', 'mvzip(a, b)', ['1,x', '2,y'], `${MV} > mvzip(MVFIELD_X,MVFIELD_Y,"Z"): comma by default`, { a: ['1', '2'], b: ['x', 'y'] });
row('mvzip', 'mvzip("😀", "b", "")', ['😀b'], `${MV} > mvzip(MVFIELD_X,MVFIELD_Y,"Z")`);
todo('mvzip', 'mvzip(missing, "b")', 'whether a NULL argument is NULL or an empty multivalue is open: #446 item 3');
todo('mvzip', 'mvzip(mv, mv, missing)', 'the docs do not say what a NULL delimiter gives', MV_AB);

// Cryptographic and time (not simulated / clock) ──────────

for (const fn of ['md5', 'sha1', 'sha256', 'sha512']) {
  todo(fn, `${fn}("a")`, `${CRYPTO} > ${fn}(X): not simulated (a visible placeholder, with a warning)`);
}

row('now', 'now()', 0, `${TIME} > now(): the run's injected clock (0 here)`);
row('time', 'time()', 0, `${TIME} > time(): the run's injected clock (0 here)`);
nulls('strftime', ['strftime(missing, "%Y")']);
nulls('strftime', ['strftime("", "%Y")', 'strftime("😀", "%Y")', 'strftime(sqrt(-1), "%Y")'],
  `${TIME} > strftime(X,Y): a value that is not a time is NULL`);
row('strftime', 'strftime(0, "%Y")', '1970', `${TIME} > strftime(X,Y): %Y is the year`);
row('strftime', 'strftime(0, "😀%Y")', '😀1970', `${TIME} > strftime(X,Y): other text is literal`);
row('strftime', 'strftime(0, "")', '', `${TIME} > strftime(X,Y): an empty format is empty`);
todo('strftime', 'strftime(0, missing)', 'the docs do not say what a NULL format gives');
todo('strftime', 'strftime(mv, "%Y")', MV_UNDOCUMENTED, MV_AB);
todo('strftime', 'strftime(0, mv)', MV_UNDOCUMENTED, MV_AB);
todo('strptime', 'strptime("2024-01-01", "%Y-%m-%d")', 'not simulated (returns its input, with a warning)');
todo('relative_time', 'relative_time(0, "-1d")', 'not simulated (returns its input, with a warning)');

// Predicates and constants ────────────────────────────────

row('null', 'null()', null, `${INFO} > null()`);
row('true', 'true()', true, `${COND} > true()`);
row('false', 'false()', false, `${COND} > false()`);

nulls('like', ['like(missing, "%")', 'like("a", missing)']);
row('like', 'like("", "%")', true, `${COND} > like(TEXT,PATTERN): % matches any run, including none`);
row('like', 'like("", "_")', false, `${COND} > like(TEXT,PATTERN): _ matches exactly one character`);
row('like', 'like("abc", "a_c")', true, `${COND} > like(TEXT,PATTERN)`);
todo('like', 'like("😀", "_")', 'one character or two UTF-16 units: the same open question as #446 item 4');
todo('like', 'like(mv, "a")', MV_UNDOCUMENTED, MV_AB);
todo('like', 'like("a", mv)', MV_UNDOCUMENTED, MV_AB);

nulls('match', ['match(missing, "a")', 'match("a", missing)']);
row('match', 'match("", "^$")', true, `${COND} > match(SUBJECT,"REGEX")`);
row('match', 'match("a😀b", "😀")', true, `${COND} > match(SUBJECT,"REGEX")`);
row('match', 'match("abc", "^b")', false, `${COND} > match(SUBJECT,"REGEX")`);
todo('match', 'match("😀", "^.$")', 'one character or two UTF-16 units: the same open question as #446 item 4');
todo('match', 'match(mv, "a")', MV_UNDOCUMENTED, MV_AB);
todo('match', 'match("a", mv)', MV_UNDOCUMENTED, MV_AB);

nulls('cidrmatch', ['cidrmatch(missing, "10.0.0.1")', 'cidrmatch("10.0.0.0/8", missing)']);
row('cidrmatch', 'cidrmatch("10.0.0.0/8", "10.1.2.3")', true, `${COND} > cidrmatch("CIDR",IP)`);
row('cidrmatch', 'cidrmatch("10.0.0.0/8", "11.1.2.3")', false, `${COND} > cidrmatch("CIDR",IP)`);
row('cidrmatch', 'cidrmatch("", "10.1.2.3")', false, `${COND} > cidrmatch("CIDR",IP): an unparseable range matches nothing`);
row('cidrmatch', 'cidrmatch("10.0.0.0/8", "😀")', false, `${COND} > cidrmatch("CIDR",IP): an unparseable address matches nothing`);
todo('cidrmatch', 'cidrmatch("10.0.0.0/8", mv)', MV_UNDOCUMENTED, MV_AB);

todo('searchmatch', 'searchmatch("a")', 'not simulated (always false, with a warning)');

// Branching (evaluated in the evaluator, not builtins.ts) ─

row('if', 'if(missing, 1, 2)', 2, `${COND} > if(X,Y,Z): a NULL condition is not true`);
row('if', 'if(1==1, "😀", 2)', '😀', `${COND} > if(X,Y,Z)`);
todo('if', 'if(mv, 1, 2)', MV_UNDOCUMENTED, MV_AB);
row('case', 'case(missing, 1, true(), 2)', 2, `${COND} > case(X,"Y",...): a NULL condition is not true`);
row('case', 'case(1==2, 1)', null, `${COND} > case(X,"Y",...): no true condition is NULL`);
todo('case', 'case(mv, 1, true(), 2)', MV_UNDOCUMENTED, MV_AB);
row('validate', 'validate(1==1, "x")', null, `${COND} > validate(X,Y,...): all conditions true is NULL`);
row('validate', 'validate(1==2, "😀")', '😀', `${COND} > validate(X,Y,...): the first false condition's value`);
todo('validate', 'validate(mv, "x")', MV_UNDOCUMENTED, MV_AB);
row('coalesce', 'coalesce(missing, missing)', null, `${COND} > coalesce(X,...): all NULL is NULL`);
row('coalesce', 'coalesce(missing, "")', '', `${COND} > coalesce(X,...): an empty string is not NULL`);
row('coalesce', 'coalesce(missing, "😀")', '😀', `${COND} > coalesce(X,...)`);
row('coalesce', 'coalesce(missing, mv)', ['a', 'b'], `${COND} > coalesce(X,...): the first non-NULL value, as it is`, MV_AB);

// ── The checks ──────────────────────────────────────────

/** The branching functions live in the evaluator; every other name comes from the builtin registry. */
const BRANCHING = ['if', 'case', 'validate', 'coalesce'];

describe('every eval builtin has documented rows', () => {
  it('has at least one row for every builtin, so a new builtin cannot land without one', () => {
    const covered = new Set([...rows.map((r) => r.fn), ...todos.map((t) => t.fn)]);
    const missingRows = [...builtinNames(), ...BRANCHING].filter((fn) => !covered.has(fn));
    expect(missingRows).toEqual([]);
  });

  it('has an asserted row (not only TODOs) for every function the simulator computes', () => {
    const notSimulated = new Set([
      'exact', 'sigfig', 'mvfilter', 'md5', 'sha1', 'sha256', 'sha512', 'strptime', 'relative_time', 'searchmatch',
    ]);
    const asserted = new Set(rows.map((r) => r.fn));
    const missing = [...builtinNames(), ...BRANCHING].filter((fn) => !notSimulated.has(fn) && !asserted.has(fn));
    expect(missing).toEqual([]);
  });

  it('names only functions that exist', () => {
    const known = new Set([...builtinNames(), ...BRANCHING]);
    const unknown = [...rows, ...todos].map((r) => r.fn).filter((fn) => !known.has(fn));
    expect(unknown).toEqual([]);
  });

  it('cites the docs on every row', () => {
    expect(rows.filter((r) => r.doc.trim() === '')).toEqual([]);
  });
});

describe('eval builtin fidelity table', () => {
  it.each(rows.map((r) => [`${r.fn}: ${r.expr}`, r] as const))('%s', (_name, r) => {
    const out = run(r.expr, r.fields);
    if (typeof r.expected === 'function') expect(r.expected(out)).toBe(true);
    else expect(out).toEqual(r.expected);
  });

  for (const t of todos) it.todo(`${t.fn}: ${t.expr} (${t.why})`);
});
