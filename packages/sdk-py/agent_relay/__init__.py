"""Agent Relay Python SDK — re-exports from src/agent_relay/.

This directory exists for backward compatibility with codegen scripts.
The real package source lives in src/agent_relay/.
"""

import importlib.util as _util
import sys as _sys
from pathlib import Path as _Path

# Load the real package from src/agent_relay/ and replace this module
_src_init = _Path(__file__).resolve().parent.parent / "src" / "agent_relay" / "__init__.py"
_spec = _util.spec_from_file_location("agent_relay", str(_src_init),
                                       submodule_search_locations=[str(_src_init.parent)])
assert _spec is not None and _spec.loader is not None, f"Could not load {_src_init}"
_real = _util.module_from_spec(_spec)
_sys.modules[__name__] = _real
_spec.loader.exec_module(_real)
