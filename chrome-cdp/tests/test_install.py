import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import unittest

INSTALL = Path(__file__).resolve().parents[1] / "scripts/install.sh"


class InstallerRecovery(unittest.TestCase):
    def run_fixture(self, root, command):
        return subprocess.run(["bash", "-c", 'source "$INSTALL_SCRIPT"\n' + command],
                              cwd=root, env={**os.environ, "INSTALL_SCRIPT": str(INSTALL)},
                              text=True, capture_output=True, timeout=10)

    def test_backup_paths_are_resolved_before_containment_checks(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "backups/stamp").mkdir(parents=True)
            (root / "outside").mkdir()
            (root / "backups/escape").symlink_to(root / "outside")
            good = self.run_fixture(root, 'BACKUP_ROOT="$PWD/backups"\ncanonical_backup backups/stamp')
            self.assertEqual(good.returncode, 0, good.stderr)
            self.assertEqual(good.stdout.strip(), str((root / "backups/stamp").resolve()))
            for candidate in ("backups/../outside", "backups/escape", "backups"):
                result = self.run_fixture(root, f'BACKUP_ROOT="$PWD/backups"\ncanonical_backup {candidate}')
                self.assertNotEqual(result.returncode, 0, candidate)

    def test_recovery_reports_success_only_after_publish_signature_and_content_match(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            for directory in ("scripts", "stage", "installed"):
                (root / directory).mkdir()
            manifest = root / "scripts/bundle-manifest.sh"
            manifest.write_text('#!/bin/bash\ncat "$1/content"\n')
            manifest.chmod(0o755)
            (root / "expected").write_text("old\n")
            setup = '''PROJECT_ROOT="$PWD"
INSTALLED_APP="$PWD/installed"
strict_signature() { return 0; }
'''
            cases = (
                ('fake_installer() { return 9; }', False),
                ('fake_installer() { echo wrong > "$INSTALLED_APP/content"; }', False),
                ('fake_installer() { echo old > "$INSTALLED_APP/content"; }\nstrict_signature() { return 1; }', False),
                ('fake_installer() { echo old > "$INSTALLED_APP/content"; }', True),
            )
            for installer, succeeds in cases:
                with self.subTest(installer=installer):
                    result = self.run_fixture(root, setup + installer + '\nrestore_previous_app stage fake_installer expected recovered')
                    self.assertEqual(result.returncode == 0, succeeds, result.stderr)
                    self.assertEqual("previous app restored and verified" in result.stderr, succeeds)
                    self.assertEqual("recovery failed" in result.stderr, not succeeds)


if __name__ == "__main__":
    unittest.main()
