from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest import mock


CHECK = Path(__file__).parents[3] / "scripts" / "check.py"
SPEC = importlib.util.spec_from_file_location("wiki_check", CHECK)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
OPERATIONS = (
    Path(__file__).parents[1]
    / "skills"
    / "obsidian-memory"
    / "references"
    / "memory-operations.md"
)


class MemoryOperationsContractTests(unittest.TestCase):
    def test_operations_contract_does_not_depend_on_workspace_readme(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            with mock.patch.object(MODULE, "ROOT", Path(temporary)):
                MODULE.validate_memory_operations(OPERATIONS)

    def test_operations_contract_rejects_a_deleted_ordered_command(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            mutation = Path(temporary) / "memory-operations.md"
            mutation.write_text(
                OPERATIONS.read_text(encoding="utf-8").replace("qmd status\n", "", 1),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                MODULE.ValidationError,
                "memory operations omits ordered contract: qmd status",
            ):
                MODULE.validate_memory_operations(mutation)

    def test_rollback_contract_rejects_incremental_refresh_as_a_rebuild(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            mutation = Path(temporary) / "memory-operations.md"
            mutation.write_text(
                OPERATIONS.read_text(encoding="utf-8").replace(
                    "qmd update\nqmd embed\n",
                    'python3 "<plugin-root>/scripts/obsidian_memory.py" '
                    "refresh-index --embed\n",
                    1,
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                MODULE.ValidationError,
                "memory rollback omits ordered recovery: qmd update",
            ):
                MODULE.validate_memory_operations(mutation)

    def test_rollback_contract_requires_recoverable_exact_index_backup(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            mutation = Path(temporary) / "memory-operations.md"
            mutation.write_text(
                OPERATIONS.read_text(encoding="utf-8").replace(
                    'mv "$qmd_index" "$qmd_backup_dir/index.sqlite"\n', "", 1
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                MODULE.ValidationError,
                'memory rollback omits ordered recovery: mv "\\$qmd_index"',
            ):
                MODULE.validate_memory_operations(mutation)

    def test_rollback_contract_rejects_backup_after_downgrade(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            mutation = Path(temporary) / "memory-operations.md"
            original = OPERATIONS.read_text(encoding="utf-8")
            backup = 'mv "$qmd_index" "$qmd_backup_dir/index.sqlite"\n'
            apply = "python3 bun-global-tools/sync.py apply\n"
            if backup in original:
                moved = original.replace(backup, "", 1).replace(
                    apply, apply + backup, 1
                )
            else:
                moved = original
            mutation.write_text(moved, encoding="utf-8")
            with self.assertRaisesRegex(
                MODULE.ValidationError,
                'memory rollback omits ordered recovery: mv "\\$qmd_index"',
            ):
                MODULE.validate_memory_operations(mutation)

    def test_installed_package_rejects_an_escaping_relative_link(self) -> None:
        with tempfile.TemporaryDirectory(dir=MODULE.PLUGIN / "skills") as temporary:
            package = Path(temporary)
            (package / "references").mkdir()
            (package / "references" / "escape.md").write_text(
                "[outside](../../README.md)\n", encoding="utf-8"
            )
            with self.assertRaisesRegex(
                MODULE.ValidationError,
                "link escapes installed skill package",
            ):
                MODULE.validate_skill_package_links(package)
