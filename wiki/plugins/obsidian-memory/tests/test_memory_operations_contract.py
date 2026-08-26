from __future__ import annotations

import importlib.util
import os
import subprocess
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
    def recovery_shell(self) -> str:
        recovery = OPERATIONS.read_text(encoding="utf-8").split(
            "### Failed-rollback recovery", 1
        )[1]
        shell_blocks = recovery.split("```sh\n")[1:]
        self.assertGreaterEqual(len(shell_blocks), 2)
        script = shell_blocks[1].split("\n```", 1)[0]
        return script.replace(
            'qmd_backup_dir="/recorded/pre-rollback/backup-directory"',
            'qmd_backup_dir="$QMD_ROLLBACK_BACKUP_DIR"',
        )

    def run_recovery_shell(
        self,
        root: Path,
        *,
        dangling_target: str | None = None,
        symlinked_source: str | None = None,
        nonregular_source: tuple[str, str] | None = None,
    ) -> tuple[subprocess.CompletedProcess[str], Path, Path, Path]:
        cache = root / "cache"
        qmd_dir = cache / "qmd"
        qmd_dir.mkdir(parents=True)
        index = qmd_dir / "index.sqlite"
        backup = Path(f"{index}.pre-rollback.TEST")
        backup.mkdir()
        outside = root / "outside"
        outside.mkdir()
        (backup / "index.sqlite").write_text("saved-db", encoding="utf-8")
        (backup / "index.sqlite-wal").write_text("saved-wal", encoding="utf-8")
        (backup / "index.sqlite-shm").write_text("saved-shm", encoding="utf-8")

        if dangling_target:
            target = index if dangling_target == "db" else Path(f"{index}-{dangling_target}")
            target.symlink_to(outside / f"missing-{dangling_target}")
        if symlinked_source:
            source = (
                backup / "index.sqlite"
                if symlinked_source == "db"
                else backup / f"index.sqlite-{symlinked_source}"
            )
            source.unlink()
            real_source = outside / f"saved-{symlinked_source}"
            real_source.write_text("outside-source", encoding="utf-8")
            source.symlink_to(real_source)
        if nonregular_source:
            source_name, kind = nonregular_source
            source = backup / f"index.sqlite-{source_name}"
            source.unlink()
            if kind == "directory":
                source.mkdir()
            else:
                os.mkfifo(source)

        env = {
            **os.environ,
            "HOME": str(root),
            "XDG_CACHE_HOME": str(cache),
            "QMD_ROLLBACK_BACKUP_DIR": str(backup),
        }
        result = subprocess.run(
            ["sh", "-c", self.recovery_shell()],
            text=True,
            capture_output=True,
            check=False,
            env=env,
        )
        return result, index, backup, outside

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

    def test_failed_rollback_recovery_quarantines_only_an_existing_database(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            mutation = Path(temporary) / "memory-operations.md"
            mutation.write_text(
                OPERATIONS.read_text(encoding="utf-8").replace(
                    'if [ -f "$qmd_index" ]; then\n', "", 1
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                MODULE.ValidationError,
                "memory recovery omits conditional quarantine",
            ):
                MODULE.validate_memory_operations(mutation)

    def test_failed_rollback_recovery_restores_runtime_before_saved_database(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            mutation = Path(temporary) / "memory-operations.md"
            original = OPERATIONS.read_text(encoding="utf-8")
            marker = "### Failed-rollback recovery"
            if marker in original:
                prefix, recovery = original.split(marker, 1)
                runtime = (
                    "python3 bun-global-tools/sync.py apply\n"
                    "python3 scripts/plugins.py install --force\n"
                )
                restore = (
                    'cp -p "$qmd_backup_dir/index.sqlite" "$qmd_index"\n'
                )
                recovery = recovery.replace(runtime, "", 1).replace(
                    restore, restore + runtime, 1
                )
                mutated = prefix + marker + recovery
            else:
                mutated = original
            mutation.write_text(mutated, encoding="utf-8")
            with self.assertRaisesRegex(
                MODULE.ValidationError,
                "memory recovery omits ordered restoration: python3 "
                "bun-global-tools/sync.py apply",
            ):
                MODULE.validate_memory_operations(mutation)

    def test_recovery_shell_rejects_dangling_database_and_sidecar_targets(
        self,
    ) -> None:
        for target in ("db", "wal", "shm"):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as temporary:
                result, index, backup, outside = self.run_recovery_shell(
                    Path(temporary), dangling_target=target
                )

                self.assertNotEqual(result.returncode, 0, result.stdout)
                target_path = index if target == "db" else Path(f"{index}-{target}")
                self.assertTrue(target_path.is_symlink())
                self.assertFalse((outside / f"missing-{target}").exists())
                self.assertEqual(
                    (backup / "index.sqlite").read_text(encoding="utf-8"),
                    "saved-db",
                )

    def test_recovery_shell_rejects_symlinked_saved_database_and_sidecars(
        self,
    ) -> None:
        for source in ("db", "wal", "shm"):
            with self.subTest(source=source), tempfile.TemporaryDirectory() as temporary:
                result, index, backup, _outside = self.run_recovery_shell(
                    Path(temporary), symlinked_source=source
                )

                self.assertNotEqual(result.returncode, 0, result.stdout)
                source_path = (
                    backup / "index.sqlite"
                    if source == "db"
                    else backup / f"index.sqlite-{source}"
                )
                self.assertTrue(source_path.is_symlink())
                self.assertFalse(index.exists())
                self.assertFalse(index.is_symlink())

    def test_recovery_contract_requires_non_dereferencing_target_absence(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            mutation = Path(temporary) / "memory-operations.md"
            mutation.write_text(
                OPERATIONS.read_text(encoding="utf-8").replace(
                    'if [ -e "$qmd_index" ] || [ -L "$qmd_index" ] ||',
                    'if [ -e "$qmd_index" ] ||',
                    1,
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                MODULE.ValidationError,
                "memory recovery omits symlink-safe target absence",
            ):
                MODULE.validate_memory_operations(mutation)

    def test_recovery_contract_requires_non_symlink_saved_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            mutation = Path(temporary) / "memory-operations.md"
            mutation.write_text(
                OPERATIONS.read_text(encoding="utf-8").replace(
                    'if [ -L "$qmd_backup_dir/index.sqlite-wal" ] ||',
                    "if",
                    1,
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(
                MODULE.ValidationError,
                "memory recovery omits saved-input symlink guard",
            ):
                MODULE.validate_memory_operations(mutation)

    def test_recovery_contract_requires_complete_saved_sidecar_predicates(
        self,
    ) -> None:
        for sidecar in ("wal", "shm"):
            with self.subTest(sidecar=sidecar), tempfile.TemporaryDirectory() as temporary:
                mutation = Path(temporary) / "memory-operations.md"
                full_guard = (
                    f'if [ -L "$qmd_backup_dir/index.sqlite-{sidecar}" ] || '
                    f'{{ [ -e "$qmd_backup_dir/index.sqlite-{sidecar}" ] && '
                    f'[ ! -f "$qmd_backup_dir/index.sqlite-{sidecar}" ]; }}; then'
                )
                mutation.write_text(
                    OPERATIONS.read_text(encoding="utf-8").replace(
                        full_guard,
                        f'if [ -L "$qmd_backup_dir/index.sqlite-{sidecar}" ] || false; then',
                        1,
                    ),
                    encoding="utf-8",
                )
                with self.assertRaisesRegex(
                    MODULE.ValidationError,
                    "memory recovery omits complete saved-sidecar guard",
                ):
                    MODULE.validate_memory_operations(mutation)

    def test_recovery_shell_rejects_directory_and_fifo_saved_sidecars(self) -> None:
        cases = (("wal", "directory"), ("shm", "fifo"))
        for sidecar, kind in cases:
            with (
                self.subTest(sidecar=sidecar, kind=kind),
                tempfile.TemporaryDirectory() as temporary,
            ):
                result, index, backup, _outside = self.run_recovery_shell(
                    Path(temporary), nonregular_source=(sidecar, kind)
                )

                self.assertNotEqual(result.returncode, 0, result.stdout)
                source = backup / f"index.sqlite-{sidecar}"
                self.assertTrue(source.exists())
                self.assertFalse(index.exists())
                self.assertFalse(index.is_symlink())

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
