"""Inbound access policy for the Wildfire IM adapter (DM vs group).

The policy is **fail-closed**: when neither an allow-all opt-in nor an allowlist
is configured, nobody is admitted. This matters because the adapter declares
``enforces_own_access_policy = True`` to Hermes, so the gateway trusts this
decision instead of applying its own env allowlist a second time.

Semantics:

* **DM** — allowed when the sender is the robot owner, or is listed in
  ``WILDFIRE_ALLOWED_USERS`` (``allowed_users``), or ``WILDFIRE_ALLOW_ALL_USERS``
  is enabled. An empty user allowlist admits nobody.
* **Group** — the chat must be listed in ``WILDFIRE_ALLOWED_GROUPS``
  (``allowed_groups``; empty = no groups, fail-closed) and, when
  ``WILDFIRE_GROUP_ALLOWED_USERS`` (``group_allowed_users``) is configured, the
  sender must be listed there. The robot owner bypasses the group sender
  allowlist (but still needs the group to be allowed). Without a group sender
  allowlist, every member of an allowed group may talk to the robot.

Keeping DM and group rules separate prevents the robot owner's DM allowlist
entry from silently turning groups into "owner-only" chats.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class AccessPolicy:
    """Effective inbound access policy for one adapter instance."""

    allowed_users: frozenset[str] = frozenset()
    allowed_groups: frozenset[str] = frozenset()
    group_allowed_users: frozenset[str] = frozenset()
    allow_all_users: bool = False
    owner_id: str | None = None

    def is_dm_allowed(self, sender: str) -> bool:
        """Whether *sender* may use the robot in a private chat."""
        sender = str(sender or "").strip()
        if not sender:
            return False
        if self.allow_all_users:
            return True
        if self.owner_id and sender == self.owner_id:
            return True
        return sender in self.allowed_users

    def is_group_allowed(self, chat_id: str, sender: str = "") -> bool:
        """Whether a message in group/channel *chat_id* from *sender* is allowed."""
        chat_id = str(chat_id or "").strip()
        sender = str(sender or "").strip()
        if not chat_id:
            return False
        if self.allow_all_users:
            return True
        # Fail-closed: no group allowlist means the robot does not talk in groups.
        if not self.allowed_groups:
            return False
        if chat_id not in self.allowed_groups:
            return False
        # No per-group sender allowlist: every member of the allowed group is trusted.
        if not self.group_allowed_users:
            return True
        if sender and sender in self.group_allowed_users:
            return True
        if self.owner_id and sender == self.owner_id:
            return True
        return False

    def is_authorized(self, sender: str, chat_id: str, is_group: bool) -> bool:
        if is_group:
            return self.is_group_allowed(chat_id, sender)
        return self.is_dm_allowed(sender)

    def describe(self) -> str:
        """Compact description for startup logs (ids omitted)."""
        mode = "allow-all" if self.allow_all_users else "allowlist"
        owner = self.owner_id or "unknown"
        return (
            f"mode={mode} owner={owner} "
            f"dm_users={len(self.allowed_users)} groups={len(self.allowed_groups)} "
            f"group_users={len(self.group_allowed_users)}"
        )
