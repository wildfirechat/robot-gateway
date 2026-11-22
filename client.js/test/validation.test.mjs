import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    assertGroupMembers,
    assertLongId,
    assertStringMemberIds,
} from '../src/validation.js';

test('assertLongId accepts numeric strings and normalizes safe integers', () => {
    assert.equal(assertLongId('m', 'messageId', '581417166004289700'), '581417166004289700');
    assert.equal(assertLongId('m', 'messageId', 42), '42');
    assert.equal(assertLongId('m', 'messageId', '0'), '0');
});

test('assertLongId rejects unsafe numbers and malformed strings', () => {
    // Real Wildfire ids are > 2^53: a JS number is already lossy, so reject it.
    assert.throws(() => assertLongId('m', 'messageId', 581417166004289700), /numeric string/);
    assert.throws(() => assertLongId('m', 'messageId', -1), /numeric string/);
    assert.throws(() => assertLongId('m', 'messageId', 1.5), /numeric string/);
    assert.throws(() => assertLongId('m', 'messageId', ''), /numeric string/);
    assert.throws(() => assertLongId('m', 'messageId', '12a'), /numeric string/);
    assert.throws(() => assertLongId('m', 'messageId', null), /numeric string/);
});

test('assertGroupMembers requires object members with member_id', () => {
    const members = [{ member_id: 'u1', type: 0 }];
    assert.equal(assertGroupMembers('createGroup', members), members);
    assert.throws(() => assertGroupMembers('createGroup', []), /non-empty/);
    assert.throws(() => assertGroupMembers('createGroup', ['u1']), /object with member_id/);
    assert.throws(() => assertGroupMembers('createGroup', [{}]), /member_id is required/);
    assert.throws(() => assertGroupMembers('createGroup', [{ member_id: '' }]), /member_id is required/);
});

test('assertStringMemberIds requires bare user-id strings', () => {
    assert.deepEqual(assertStringMemberIds('kickoffGroupMembers', ['u1', 'u2']), ['u1', 'u2']);
    assert.throws(() => assertStringMemberIds('kickoffGroupMembers', []), /non-empty/);
    assert.throws(
        () => assertStringMemberIds('kickoffGroupMembers', [{ member_id: 'u1' }]),
        /user-id string/
    );
    assert.throws(() => assertStringMemberIds('kickoffGroupMembers', ['']), /user-id string/);
});
