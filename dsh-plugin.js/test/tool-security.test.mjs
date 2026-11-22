import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    assertConfigSendablePath,
    assertSendablePath,
    isOwnerOrAdmin,
    requireOwnerTurn,
    resolveSessionKey,
} from '../dist/toolSecurity.js';
import { turnOwners } from '../dist/turnContext.js';

const OWNER = 'owner1';
const ADMIN = 'admin1';
const GUEST = 'guest1';

function fakeApi(overrides = {}) {
    const api = {
        robotOwner: OWNER,
        config: {
            access: { adminUsers: [ADMIN] },
            security: { toolsOwnerOnly: true },
            workspace: { path: '/tmp/ws', root: '/tmp/ws' },
        },
        wildfireAgents: {
            keyForSessionId: (sid) =>
                sid === 'sess-owner' ? 'k-owner'
                    : sid === 'sess-guest' ? 'k-guest'
                        : sid === 'sess-local' ? 'k-local'
                            : undefined,
        },
        bridge: { isBridged: (key) => key === 'k-local' },
        ...overrides,
    };
    return api;
}

function execFor(sessionId) {
    return { agent: { id: sessionId } };
}

test('isOwnerOrAdmin recognises owner and admins only', () => {
    const api = fakeApi();
    assert.equal(isOwnerOrAdmin(api, OWNER), true);
    assert.equal(isOwnerOrAdmin(api, ADMIN), true);
    assert.equal(isOwnerOrAdmin(api, GUEST), false);
    assert.equal(isOwnerOrAdmin(api, ''), false);
    assert.equal(isOwnerOrAdmin(api, undefined), false);
});

test('requireOwnerTurn allows owner, admin and bridged local sessions', () => {
    const api = fakeApi();
    turnOwners.clear();
    turnOwners.set('k-owner', OWNER);
    turnOwners.set('k-guest', GUEST);
    assert.doesNotThrow(() => requireOwnerTurn(api, execFor('sess-owner'), 'im_bot_api'));

    turnOwners.set('k-admin', ADMIN);
    api.wildfireAgents.keyForSessionId = (sid) =>
        (sid === 'sess-admin' ? 'k-admin' : sid === 'sess-local' ? 'k-local' : undefined);
    assert.doesNotThrow(() => requireOwnerTurn(api, execFor('sess-admin'), 'im_bot_api'));

    // Local bridged session (web UI / desktop) without an IM sender is trusted.
    assert.doesNotThrow(() => requireOwnerTurn(api, execFor('sess-local'), 'im_bot_api'));
});

test('requireOwnerTurn denies guest turns and unmapped sub-agent sessions', () => {
    const api = fakeApi();
    turnOwners.clear();
    turnOwners.set('k-guest', GUEST);
    assert.throws(() => requireOwnerTurn(api, execFor('sess-guest'), 'im_bot_api'), /仅限/);
    // Unknown session that is not a bridged local session (e.g. a sub-agent).
    assert.throws(() => requireOwnerTurn(api, execFor('sess-subagent'), 'im_user_contacts'), /仅限/);
    assert.equal(resolveSessionKey(api, execFor('sess-subagent')), undefined);
});

test('toolsOwnerOnly=false opts out of the sender gate', () => {
    const api = fakeApi();
    api.config = { ...api.config, security: { toolsOwnerOnly: false } };
    turnOwners.clear();
    turnOwners.set('k-guest', GUEST);
    api.wildfireAgents.keyForSessionId = () => 'k-guest';
    assert.doesNotThrow(() => requireOwnerTurn(api, execFor('anything'), 'im_bot_api'));
});

test('assertSendablePath keeps file sends inside the workspace', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wf-tools-'));
    try {
        const inside = path.join(root, 'report.txt');
        await writeFile(inside, 'hello');
        await mkdir(path.join(root, 'nested'));
        const nested = path.join(root, 'nested', 'a.txt');
        await writeFile(nested, 'nested');

        assert.equal(await assertSendablePath(inside, [root]), await realpath(inside));
        assert.equal(await assertSendablePath(nested, [root]), await realpath(nested));

        // Outside the root: must be rejected (arbitrary file exfiltration guard).
        const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'wf-tools-out-'));
        try {
            const outside = path.join(outsideDir, 'secret.txt');
            await writeFile(outside, 'secret');
            await assert.rejects(() => assertSendablePath(outside, [root]), /outside the workspace/);
        } finally {
            await rm(outsideDir, { recursive: true, force: true });
        }

        // Symlink escaping the root must be rejected too (realpath is compared).
        const link = path.join(root, 'escape.txt');
        const outsideDir2 = await mkdtemp(path.join(os.tmpdir(), 'wf-tools-out2-'));
        try {
            const outside2 = path.join(outsideDir2, 'secret.txt');
            await writeFile(outside2, 'secret');
            try {
                const { symlink } = await import('node:fs/promises');
                await symlink(outside2, link);
                await assert.rejects(() => assertSendablePath(link, [root]), /outside the workspace/);
            } catch (err) {
                if (!String(err?.message || '').includes('outside the workspace')) throw err;
            }
        } finally {
            await rm(outsideDir2, { recursive: true, force: true });
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('assertConfigSendablePath uses configured workspace roots and extra roots', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wf-cfg-'));
    try {
        const file = path.join(root, 'a.txt');
        await writeFile(file, 'a');
        const config = { workspace: { root, path: root } };
        assert.equal(await assertConfigSendablePath(file, config), await realpath(file));

        const other = await mkdtemp(path.join(os.tmpdir(), 'wf-cfg2-'));
        try {
            const otherFile = path.join(other, 'b.txt');
            await writeFile(otherFile, 'b');
            await assert.rejects(() => assertConfigSendablePath(otherFile, config), /outside the workspace/);
            assert.equal(
                await assertConfigSendablePath(otherFile, config, [other]),
                await realpath(otherFile)
            );
        } finally {
            await rm(other, { recursive: true, force: true });
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
