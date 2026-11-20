"""Access policy tests: fail-closed defaults and DM/group separation."""

from __future__ import annotations

from hermes_wildfire.access import AccessPolicy


def test_default_policy_is_fail_closed():
    policy = AccessPolicy()
    assert policy.is_dm_allowed("alice") is False
    assert policy.is_group_allowed("group-1", "alice") is False
    assert policy.is_authorized("alice", "group-1", True) is False


def test_allow_all_users_opens_dm_and_groups():
    policy = AccessPolicy(allow_all_users=True)
    assert policy.is_dm_allowed("stranger") is True
    assert policy.is_group_allowed("any-group", "stranger") is True


def test_blank_sender_is_never_allowed():
    policy = AccessPolicy(allow_all_users=False, allowed_users=frozenset({"alice"}))
    assert policy.is_dm_allowed("") is False
    assert policy.is_dm_allowed("   ") is False


def test_dm_allowlist_and_owner():
    policy = AccessPolicy(
        allowed_users=frozenset({"alice"}), owner_id="owner-1"
    )
    assert policy.is_dm_allowed("alice") is True
    assert policy.is_dm_allowed("owner-1") is True
    assert policy.is_dm_allowed("bob") is False


def test_group_requires_configured_group():
    policy = AccessPolicy(allowed_groups=frozenset({"group-1"}))
    assert policy.is_group_allowed("group-1", "alice") is True
    # A group allowlist is fail-closed: missing groups are not admitted.
    assert policy.is_group_allowed("group-2", "alice") is False
    assert policy.is_group_allowed("", "alice") is False


def test_group_sender_allowlist_and_owner_bypass():
    policy = AccessPolicy(
        allowed_groups=frozenset({"group-1"}),
        group_allowed_users=frozenset({"bob"}),
        owner_id="owner-1",
    )
    assert policy.is_group_allowed("group-1", "bob") is True
    assert policy.is_group_allowed("group-1", "owner-1") is True
    assert policy.is_group_allowed("group-1", "alice") is False
    # Sender allowlist does not open other groups.
    assert policy.is_group_allowed("group-2", "bob") is False


def test_dm_owner_allowlist_does_not_restrict_group_members():
    """Regression: owner auto-added to the DM allowlist used to block all group members."""
    policy = AccessPolicy(
        allowed_users=frozenset({"owner-1"}),
        allowed_groups=frozenset({"group-1"}),
        owner_id="owner-1",
    )
    assert policy.is_dm_allowed("owner-1") is True
    assert policy.is_dm_allowed("member-1") is False
    assert policy.is_group_allowed("group-1", "member-1") is True


def test_describe_does_not_leak_ids():
    policy = AccessPolicy(
        allowed_users=frozenset({"alice"}),
        allowed_groups=frozenset({"group-1"}),
        group_allowed_users=frozenset({"bob"}),
        owner_id="owner-1",
    )
    summary = policy.describe()
    assert "alice" not in summary
    assert "group-1" not in summary
    assert "dm_users=1" in summary
    assert "groups=1" in summary
