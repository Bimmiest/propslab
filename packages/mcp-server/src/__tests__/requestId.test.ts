import { describe, expect, it } from 'vitest';
import { findRequestId, idFromHead, idFromTail } from '../requestId';

/** Bounded, parse-free recovery of an oversize request's id (#402). */
describe('idFromHead', () => {
  it.each([
    ['{"jsonrpc":"2.0","id":7,"method":"x"', 7],
    ['{"id":"abc","params":{', 'abc'],
    ['{ "jsonrpc" : "2.0" ,\n\t"id" : -3 , "p', -3],
    ['{"id":"a\\"b\\u0063"}', 'a"bc'],
    // After other members, including nested ones holding an "id" of their own.
    ['{"method":"m","meta":{"id":1,"s":"}\\""},"list":[{"id":2}],"id":3,', 3],
    ['{"\\u0069d":4,', 4],
    // Values it has to step over without parsing them.
    ['{"method":"tools/call, then \\"more\\"","id":5,', 5],
    ['{"n":1,"id":2,', 2],
    ['{"a":1,"b":true,"c":null,"d":-2.5e3 ,"id":9,', 9],
    ['{"a":{"b":[1,{"c":"]"}],"d":{}},"e":[],"id":6,', 6],
    ['{"id":8}', 8],
  ])('finds the id in %j', (head, id) => {
    expect(idFromHead(head)).toBe(id);
  });

  it.each([
    ['{"method":"m","params":{"raw":"xxxxx', 'id beyond a value the window cuts off'],
    ['{"jsonrpc":"2.0","id":12', 'number cut off by the window'],
    ['{"id":"ab', 'string cut off by the window'],
    ['{"id":null,', 'null id'],
    ['{"id":1.5,', 'non-integer id'],
    ['{"id":{"a":1},', 'object id'],
    ['{"method":"m"}', 'no id at all'],
    ['[{"id":1}]', 'a batch'],
    ['garbage', 'not JSON'],
    ['', 'empty'],
    ['{"id":12x,', 'number run into other characters'],
    ['{"id":true,', 'boolean id'],
    ['x"id":1,', 'not an object'],
    ['{x":1,"id":2,', 'an unquoted key'],
    ['{"a" 1,"id":2,', 'a member without a colon'],
    ['{"a":"x"x"id":2,', 'junk between members'],
    ['{"a":1} ,"id":2,', 'members after the object closes'],
    ['{"a":1],"id":2,', 'a stray bracket'],
    ['{"a":{"b":1', 'nested object cut off by the window'],
    ['{"a":12', 'number cut off before the id'],
  ])('gives up on %j (%s)', (head) => {
    expect(idFromHead(head)).toBeUndefined();
  });
});

describe('idFromTail', () => {
  it.each([
    ['"x"}},"jsonrpc":"2.0","id":0}', 0],
    ['aaa"},"id" : "req-1" }\r', 'req-1'],
    ['a"},"id":"q\\"}"}', 'q"}'],
    ['{"id":5}', 5],
    [',\n "id":\n12\n}\n', 12],
  ])('finds the id in %j', (tail, id) => {
    expect(idFromTail(tail)).toBe(id);
  });

  it.each([
    ['"params":{"id":5}}', 'nested last member'],
    ['"x":"\\"id\\":5}', 'inside a string'],
    ['id":5}', 'key cut off by the window'],
    ['"id":5}', 'key at the window edge'],
    ['"id":5', 'no closing brace'],
    ['"a":1,"id":null}', 'null id'],
    ['"a":1,"id":2.5}', 'non-integer id'],
    ['"a":1,"xid":2}', 'a different key'],
    ['"a":1,"ab":2}', 'a different key of the same length'],
    [',"id":57', 'no closing brace, where dropping the last character would read 5'],
    [',"id"=5}', 'a separator other than a colon'],
    ['', 'empty'],
  ])('gives up on %j (%s)', (tail) => {
    expect(idFromTail(tail)).toBeUndefined();
  });
});

describe('findRequestId', () => {
  it('prefers the head and falls back to the tail', () => {
    const b = (s: string) => Buffer.from(s);
    expect(findRequestId(b('{"id":1,"p":"'), b('","id":2}'))).toBe(1);
    expect(findRequestId(b('{"p":"'), b('","id":2}'))).toBe(2);
    expect(findRequestId(b('{"p":"'), b('"}'))).toBeUndefined();
  });
});
