/**
 * Wire-level argument validation for the robot-gateway client SDK.
 *
 * Wildfire message/feed/comment ids are 64-bit integers. A JS `number` loses
 * precision above 2^53, so ids must travel as numeric strings; small safe
 * integers are accepted and normalized to strings for convenience. Group
 * members use different shapes depending on the API (objects for
 * createGroup/addGroupMembers, bare user-id strings for the manager APIs).
 *
 * Kept dependency-free so it can be unit-tested with `node --test`.
 */

/** Numeric string, or a safe integer number; returns the canonical string form. */
export function assertLongId(method, field, value) {
    if (typeof value === 'string') {
        if (/^\d+$/.test(value)) return value;
        throw new TypeError(`${method}: ${field} must be a non-empty numeric string`);
    }
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
        return String(value);
    }
    throw new TypeError(
        `${method}: ${field} must be a numeric string (64-bit ids exceed JS Number precision)`
    );
}

/** createGroup/addGroupMembers members: non-empty array of { member_id, type? }. */
export function assertGroupMembers(method, members) {
    if (!Array.isArray(members) || members.length === 0) {
        throw new TypeError(`${method}: members must be a non-empty array of { member_id, type? } objects`);
    }
    members.forEach((member, index) => {
        if (typeof member === 'string') {
            throw new TypeError(
                `${method}: members[${index}] must be an object with member_id; `
                + 'bare string ids are invalid (use [{ member_id: "..." }])'
            );
        }
        if (!member || typeof member !== 'object'
            || typeof member.member_id !== 'string' || member.member_id.length === 0) {
            throw new TypeError(`${method}: members[${index}].member_id is required`);
        }
    });
    return members;
}

/** Manager/mute/allow/kick members: non-empty array of bare user-id strings. */
export function assertStringMemberIds(method, members) {
    if (!Array.isArray(members) || members.length === 0) {
        throw new TypeError(`${method}: members must be a non-empty array of user-id strings`);
    }
    members.forEach((member, index) => {
        if (typeof member !== 'string' || member.length === 0) {
            throw new TypeError(
                `${method}: members[${index}] must be a user-id string (this API does not take { member_id } objects)`
            );
        }
    });
    return members;
}
