"""Directory-plugin entry point for Hermes Wildfire IM adapter.

When this repository is dropped into ``~/.hermes/plugins/platforms/wildfire-platform/``
Hermes imports the plugin directory as a Python module and calls ``register(ctx)``.
This file adds ``src/`` to the import path and re-exports the registration hook.
"""

from __future__ import annotations

import sys
from pathlib import Path

_SRC = Path(__file__).parent / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from hermes_wildfire import register  # noqa: E402

__all__ = ["register"]
