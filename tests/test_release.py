"""Release safety tests: all signing commands are synthetic, never sent to AMO."""
# SPDX-License-Identifier: AGPL-3.0-or-later
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("release_tools", ROOT / "bin/release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tabs release fixture ")
        self.root = Path(self.temp.name) / "source with spaces"
        self.root.mkdir()
        self.output = Path(self.temp.name) / "artifacts with spaces"
        self.output.mkdir()
        manifest = {"manifest_version": 3, "version": "0.0.3.10", "name": "Synthetic release",
                    "browser_specific_settings": {"gecko": {"id": "release-tests@tktsto.invalid"}},
                    "permissions": ["storage"], "incognito": "spanning"}
        for filename in ("manifest-ff.json", "manifest.json"):
            (self.root / filename).write_text(json.dumps(manifest, indent=2))
        (self.root / "VERSION_BUILD").write_text("0.0.3 10\n")
        (self.root / "api.js").write_text('"use strict";\n')
        (self.root / "view").mkdir()
        (self.root / "view/main.js").write_text('export const value = 42;\n')
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        self.git("config", "user.name", "Synthetic release test")
        self.git("config", "user.email", "release-tests@tktsto.invalid")
        self.git("add", ".")
        self.git("commit", "-qm", "Synthetic source")
        self.unsigned = Path(release.build(self.root, "firefox", self.output)["archive"])
        self.before = {name: (self.root / name).read_bytes() for name in ("manifest-ff.json", "manifest.json", "VERSION_BUILD")}

    def tearDown(self):
        # The signing source was intentionally read-only. Relax only our own
        # disposable fixture directories so TemporaryDirectory can remove them.
        for path in Path(self.temp.name).rglob("*"):
            if path.is_dir() and not path.is_symlink():
                path.chmod(0o755)
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.root), *args], stderr=subprocess.DEVNULL)

    def signed(self, mutate=None, *, name="signed.xpi"):
        files = release.read_archive(self.unsigned)
        files["manifest.json"] = json.dumps(json.loads(files["manifest.json"])).encode()
        files.update({member: b"synthetic signature metadata" for member in release.SIGNATURES})
        if mutate:
            mutate(files)
        path = self.output / name
        with zipfile.ZipFile(path, "w") as archive:
            for member, data in files.items():
                archive.writestr(member, data)
        return path

    def fake_tool(self, *, status=0, produce=True, lint_status=0):
        path = Path(self.temp.name) / "fake web-ext"
        path.write_text('''#!/usr/bin/env python3
import json, os, pathlib, sys, zipfile
args=sys.argv[1:]
if args == ['--version']:
    print('10.6.0'); raise SystemExit(0)
assert '--no-config-discovery' in args
assert '--api-key' not in args and '--api-secret' not in args
if args[0] == 'lint':
    assert 'WEB_EXT_API_SECRET' not in os.environ
    raise SystemExit(LINT_STATUS)
assert args[0] == 'sign'
assert os.environ['WEB_EXT_API_KEY'] == 'synthetic-issuer-private'
assert os.environ['WEB_EXT_API_SECRET'] == 'synthetic-secret-private'
source=pathlib.Path(args[args.index('--source-dir')+1])
out=pathlib.Path(args[args.index('--artifacts-dir')+1])
(out/'argv.json').write_text(json.dumps(args))
# Even unexpected tool output is redacted by the wrapper before logs/console.
print(os.environ['WEB_EXT_API_SECRET'])
if PRODUCE:
    version=json.loads((source/'manifest.json').read_text())['version']
    with zipfile.ZipFile(out/f'test-{version}.xpi', 'w') as archive:
        for file in source.rglob('*'):
            if file.is_file():
                data=file.read_bytes()
                if file.name == 'manifest.json': data=json.dumps(json.loads(data)).encode()
                archive.writestr(file.relative_to(source).as_posix(), data)
        for name in SIGNATURE_MEMBERS: archive.writestr(name,b'synthetic-signature')
raise SystemExit(SIGN_STATUS)
'''.replace("LINT_STATUS", str(lint_status)).replace("PRODUCE", str(produce))
          .replace("SIGNATURE_MEMBERS", repr(sorted(release.SIGNATURES))).replace("SIGN_STATUS", str(status)))
        path.chmod(0o755)
        return path

    @contextlib.contextmanager
    def signing_env(self, tool):
        with patch.dict(os.environ, {"WEB_EXT_BIN": str(tool), "WEB_EXT_API_KEY": "synthetic-issuer-private",
                                     "WEB_EXT_API_SECRET": "synthetic-secret-private"}, clear=False):
            yield

    def install_entrypoints(self):
        for name in ('Makefile', 'make-zip.sh', 'bin/release.py',
                     'bin/firefox-sign.sh', 'bin/update-version.sh', 'bin/version-utils.sh'):
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / name, target)
        (self.root / '.gitignore').write_text('dist/\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'Synthetic build entrypoints')
        self.git('tag', 'v0.0.3')

    def run_make(self, *goals, succeeds=True):
        # Never inherit the user's signing configuration into a child test.
        env = {key: value for key, value in os.environ.items()
               if key in {'PATH', 'HOME', 'LANG', 'SYSTEMROOT', 'PYTHONDONTWRITEBYTECODE'}}
        env['ARTIFACTS_DIR'] = str(self.output / 'workflow')
        if hasattr(self, 'workflow_signer'):
            env.update(WEB_EXT_BIN=str(self.workflow_signer),
                       WEB_EXT_API_KEY='synthetic-issuer-private',
                       WEB_EXT_API_SECRET='synthetic-secret-private')
        result = subprocess.run(['make', '--no-print-directory', *goals], cwd=self.root,
                                env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        if succeeds:
            self.assertEqual(result.returncode, 0, result.stdout)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout)
        return result

    def assert_version(self, build):
        for name in ('manifest.json', 'manifest-ff.json'):
            self.assertEqual(json.loads((self.root / name).read_text())['version'], f'0.0.3.{build}')
        self.assertEqual((self.root / 'VERSION_BUILD').read_text().split(), ['0.0.3', str(build)])

    def test_default_make_and_all_bump_once_for_both_browsers(self):
        self.install_entrypoints()
        head = self.git('rev-parse', 'HEAD')
        old = self.unsigned.read_bytes()
        self.run_make()
        self.assert_version(11)
        destination = self.output / 'workflow'
        first = {p.name: p.read_bytes() for p in destination.glob('*.zip')}
        self.assertEqual(len(first), 2)
        for contents in first.values():
            with zipfile.ZipFile(io.BytesIO(contents)) as archive:
                self.assertEqual(json.loads(archive.read('manifest.json'))['version'], '0.0.3.11')
        self.run_make('all')
        self.assert_version(12)
        for name, contents in first.items():
            self.assertEqual((destination / name).read_bytes(), contents)
        self.assertEqual(self.unsigned.read_bytes(), old)
        self.assertEqual(self.git('rev-parse', 'HEAD'), head, 'Building must not commit automatically')
        self.assertEqual(self.git('diff', '--cached', '--name-only'), b'')

    def test_single_browser_and_parallel_build_goals_increment_once(self):
        self.install_entrypoints()
        self.run_make('firefox-zip')
        self.assert_version(11)
        self.run_make('chrome-zip')
        self.assert_version(12)
        self.run_make('-j2', 'firefox-zip', 'chrome-zip')
        self.assert_version(13)
        for browser in ('firefox', 'chromium'):
            self.assertTrue((self.output / 'workflow' / f'ignatremizov-tabs-0.0.3.13-{browser}.zip').is_file())

    def test_chrome_dir_bumps_but_current_builds_do_not(self):
        self.install_entrypoints()
        self.run_make('chrome-dir')
        self.assert_version(11)
        destination = self.output / 'workflow'
        self.assertEqual(json.loads((destination / 'chromium/manifest.json').read_text())['version'], '0.0.3.11')
        self.run_make('firefox-zip-current', 'chrome-zip-current')
        self.assert_version(11)
        before = {p.name: p.read_bytes() for p in destination.glob('*.zip')}
        self.run_make('firefox-zip-current', 'chrome-zip-current')
        self.assertEqual({p.name: p.read_bytes() for p in destination.glob('*.zip')}, before)
        self.assert_version(11)

    def test_signing_default_bumps_builds_and_signs_same_new_version(self):
        self.install_entrypoints()
        self.workflow_signer = self.fake_tool()
        self.run_make('firefox-sign')
        self.assert_version(11)
        destination = self.output / 'workflow'
        result = json.loads((destination / 'test-0.0.3.11.verification.json').read_text())
        self.assertTrue(result['payloadVerified'])
        self.assertEqual(result['version'], '0.0.3.11')
        self.assertTrue(result['versionOverrides'], 'Receipt must identify uncommitted version metadata')
        first = (destination / 'test-0.0.3.11.xpi').read_bytes()
        self.run_make('firefox-sign')
        self.assert_version(12)
        self.assertEqual(len(list(destination.rglob('argv.json'))), 2)
        self.assertEqual((destination / 'test-0.0.3.11.xpi').read_bytes(), first)
        self.assertTrue((destination / 'test-0.0.3.12.xpi').is_file())
        self.assertEqual(self.git('diff', '--cached', '--name-only'), b'')

    def test_sign_current_uses_configured_artifact_dir_and_resume_never_bumps(self):
        self.install_entrypoints()
        self.workflow_signer = self.fake_tool(status=1)
        self.run_make('firefox-zip')
        self.assert_version(11)
        self.run_make('firefox-sign-current')
        self.assert_version(11)
        destination = self.output / 'workflow'
        before = (destination / 'test-0.0.3.11.xpi').read_bytes()
        self.run_make('firefox-sign-current', 'SIGN_ARGS=--verify-only')
        self.assert_version(11)
        self.assertEqual(len(list(destination.rglob('argv.json'))), 1)
        self.assertEqual((destination / 'test-0.0.3.11.xpi').read_bytes(), before)

    def test_new_signing_does_not_bypass_an_unresolved_submission(self):
        self.install_entrypoints()
        self.workflow_signer = self.fake_tool(status=1, produce=False)
        self.run_make('firefox-sign', succeeds=False)
        self.assert_version(11)
        second = self.run_make('firefox-sign', succeeds=False)
        self.assertIn('unresolved', second.stdout.lower())
        self.assert_version(11)
        self.assertEqual(len(list((self.output / 'workflow').rglob('argv.json'))), 1)

    def test_default_signing_refuses_nonversion_changes_before_bumping(self):
        self.install_entrypoints()
        self.workflow_signer = self.fake_tool()
        for filename in ('api.js', 'manifest-ff.json'):
            with self.subTest(filename=filename):
                original = (self.root / filename).read_bytes()
                if filename.endswith('.json'):
                    doc = json.loads(original); doc['permissions'].append('tabs')
                    (self.root / filename).write_text(json.dumps(doc))
                else:
                    (self.root / filename).write_text('changed code')
                self.run_make('firefox-sign', succeeds=False)
                self.assert_version(10)
                self.assertEqual(list((self.output / 'workflow').rglob('argv.json')), [])
                (self.root / filename).write_bytes(original)

    def test_version_overlay_rejects_code_changes_even_when_staged(self):
        (self.root / 'api.js').write_text('staged different code')
        self.git('add', 'api.js')
        with self.assertRaises(ValueError):
            release.source_payload(self.root, 'firefox', allow_version_bump=True)

    def test_version_overlay_cannot_hide_staged_permission_changes(self):
        name = 'manifest-ff.json'
        original = (self.root / name).read_bytes()
        doc = json.loads(original); doc['permissions'].append('tabs')
        (self.root / name).write_text(json.dumps(doc))
        self.git('add', name)
        (self.root / name).write_bytes(original)
        with self.assertRaises(ValueError):
            release.source_payload(self.root, 'firefox', allow_version_bump=True)

    def test_metadata_changes_during_auto_signing_retain_download_without_publication(self):
        self.install_entrypoints()
        self.workflow_signer = self.fake_tool()
        code = self.workflow_signer.read_text()
        where = code.rfind('raise SystemExit(0)')
        edit = f"""root=pathlib.Path({str(self.root)!r})
for name in ('manifest.json', 'manifest-ff.json'):
    doc=json.loads((root/name).read_text()); doc['version']='0.0.3.12'
    (root/name).write_text(json.dumps(doc))
(root/'VERSION_BUILD').write_text('0.0.3 12\\n')
"""
        self.workflow_signer.write_text(code[:where] + edit + code[where:])
        self.run_make('firefox-sign', succeeds=False)
        destination = self.output / 'workflow'
        self.assertEqual(list(destination.glob('*.xpi')), [])
        self.assertEqual(len(list(destination.rglob('*.xpi'))), 1)
        self.assertTrue((destination / '.tabs-submission-0.0.3.11.json').exists())
        self.run_make('firefox-sign', succeeds=False)
        self.assert_version(12)
        self.assertEqual(len(list(destination.rglob('argv.json'))), 1)

    def test_auto_signing_and_other_build_goals_cannot_race_the_counter(self):
        self.install_entrypoints()
        self.workflow_signer = self.fake_tool()
        self.run_make('-j2', 'firefox-sign', 'all', succeeds=False)
        self.assert_version(10)
        self.assertEqual(list((self.output / 'workflow').rglob('argv.json')), [])

    def test_clean_release_current_and_direct_verify_only_do_not_increment(self):
        self.install_entrypoints()
        self.workflow_signer = self.fake_tool()
        self.run_make('release-current')
        self.assert_version(10)
        self.run_make('firefox-sign-current')
        self.run_make('firefox-sign', 'SIGN_ARGS=--verify-only')
        self.assert_version(10)
        self.assertEqual(len(list((self.output / 'workflow').rglob('argv.json'))), 1)

    def test_default_signing_rejects_prebuilt_override_before_bumping(self):
        self.install_entrypoints()
        self.workflow_signer = self.fake_tool()
        result = self.run_make('firefox-sign', f'FIREFOX_ARCHIVE={self.unsigned}', succeeds=False)
        self.assertIn('current', result.stdout.lower())
        self.assert_version(10)

    def test_build_counter_failure_leaves_manifests_and_packages_unchanged(self):
        self.install_entrypoints()
        for name in ('manifest.json', 'manifest-ff.json'):
            doc = json.loads((self.root / name).read_text()); doc['version'] = '0.0.3.65535'
            (self.root / name).write_text(json.dumps(doc))
        (self.root / 'VERSION_BUILD').write_text('0.0.3 65535\n')
        self.run_make('all', succeeds=False)
        self.assert_version(65535)
        self.assertEqual(list((self.output / 'workflow').glob('*.zip')), [])

    def test_build_is_reproducible_and_existing_archives_are_not_overwritten(self):
        before = self.unsigned.read_bytes(), self.unsigned.stat().st_mtime_ns
        same = release.build(self.root, "firefox", self.output)
        self.assertEqual((self.unsigned.read_bytes(), self.unsigned.stat().st_mtime_ns), before)
        elsewhere = release.build(self.root, "firefox", self.output / "second")
        self.assertEqual(same["sha256"], elsewhere["sha256"])
        (self.root / "api.js").write_text('"changed";\n')
        with self.assertRaises(ValueError):
            release.build(self.root, "firefox", self.output / "dirty")
        with self.assertRaises(FileExistsError):
            release.build(self.root, "firefox", self.output, allow_dirty=True)
        self.assertEqual(self.unsigned.read_bytes(), before[0])

    def test_version_mismatch_never_bumps_metadata(self):
        (self.root / "VERSION_BUILD").write_text("0.0.3 11\n")
        with self.assertRaises(ValueError):
            release.build(self.root, "firefox", self.output / "mismatch", allow_dirty=True)
        self.assertEqual((self.root / "manifest-ff.json").read_bytes(), self.before["manifest-ff.json"])
        self.assertEqual((self.root / "VERSION_BUILD").read_text(), "0.0.3 11\n")

    def test_untracked_or_symlinked_package_files_are_refused(self):
        (self.root / "private.md").write_text("Not for publication")
        with self.assertRaises(ValueError):
            release.build(self.root, "firefox", self.output / "private", allow_dirty=True)
        (self.root / "private.md").unlink()
        shutil.rmtree(self.root / "view")
        (self.root / "view").symlink_to(self.output, target_is_directory=True)
        with self.assertRaises(ValueError):
            release.build(self.root, "firefox", self.output / "symlink", allow_dirty=True)

    def test_only_manifest_formatting_may_differ(self):
        result = release.verify(self.unsigned, self.signed(), self.root)
        self.assertTrue(result["payloadVerified"])
        self.assertFalse(result["signatureVerified"])
        self.assertEqual(result["normalizedFiles"], ["manifest.json"])
        bad = self.signed(lambda files: files.update({"api.js": b"different code"}), name="wrong-code.xpi")
        with self.assertRaises(ValueError):
            release.verify(self.unsigned, bad, self.root)

    def test_manifest_permissions_version_identity_and_duplicate_keys_are_strict(self):
        mutations = [lambda doc: doc.update(version="0.0.3.11"),
                     lambda doc: doc.update(permissions=["storage", "tabs"]),
                     lambda doc: doc["browser_specific_settings"]["gecko"].update(id="different@test.invalid")]
        for index, mutate in enumerate(mutations):
            def change(files):
                doc = json.loads(files["manifest.json"]); mutate(doc)
                files["manifest.json"] = json.dumps(doc).encode()
            with self.assertRaises(ValueError):
                release.verify(self.unsigned, self.signed(change, name=f"manifest-{index}.xpi"), self.root)
        duplicate = self.signed(lambda files: files.update({"manifest.json": b'{"version":"0.0.3.10","version":"0.0.3.11"}'}), name="duplicates.xpi")
        with self.assertRaises(ValueError):
            release.verify(self.unsigned, duplicate)

    def test_zip_traversal_duplicate_symlink_and_extra_members_are_rejected(self):
        for index, extra in enumerate(("../outside", "/absolute", "extra.js", "META-INF/unexpected.sig")):
            package = self.signed(lambda files: files.update({extra: b"unexpected"}), name=f"extra-{index}.xpi")
            with self.assertRaises(ValueError):
                release.verify(self.unsigned, package)
        package = self.signed(name="duplicate-path.xpi")
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            with zipfile.ZipFile(package, "a") as archive:
                archive.writestr("api.js", b"duplicate")
        with self.assertRaises(ValueError):
            release.verify(self.unsigned, package)
        package = self.signed(name="symlink.xpi")
        with zipfile.ZipFile(package, "a") as archive:
            member = zipfile.ZipInfo("link")
            member.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(member, b"../../outside")
        with self.assertRaises(ValueError):
            release.read_archive(package)

    def test_incomplete_signatures_are_not_accepted(self):
        bad = self.signed(lambda files: files.pop("META-INF/cose.sig"))
        with self.assertRaises(ValueError):
            release.verify(self.unsigned, bad)

    def test_sign_uses_environment_credentials_and_submits_once_without_bumping(self):
        tool = self.fake_tool(status=1)
        destination = self.output / "sign results"
        capture = io.StringIO()
        with self.signing_env(tool), contextlib.redirect_stdout(capture):
            result = release.sign(self.root, self.unsigned, destination)
            self.assertTrue(result["payloadVerified"])
            self.assertEqual(result["webExtExitCode"], 1)
            with self.assertRaises(ValueError):
                release.sign(self.root, self.unsigned, destination)
            again = release.sign(self.root, self.unsigned, destination, verify_only=True)
            self.assertEqual(again["sha256"], result["sha256"])
        self.assertNotIn("synthetic-secret-private", capture.getvalue())
        self.assertIn("[redacted]", capture.getvalue())
        argv_files = list(destination.rglob("argv.json"))
        self.assertEqual(len(argv_files), 1)
        for path in destination.rglob("*"):
            if path.is_file() and path.suffix in (".json", ".log"):
                self.assertNotIn("synthetic-secret-private", path.read_text())
                self.assertNotIn("synthetic-issuer-private", path.read_text())
        for name, contents in self.before.items():
            self.assertEqual((self.root / name).read_bytes(), contents)

    def test_ambiguous_no_artifact_submission_remains_reserved(self):
        tool = self.fake_tool(status=1, produce=False)
        destination = self.output / "ambiguous"
        with self.signing_env(tool), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(ValueError):
                release.sign(self.root, self.unsigned, destination)
            with self.assertRaisesRegex(ValueError, "already submitted"):
                release.sign(self.root, self.unsigned, destination)
        self.assertTrue((destination / ".tabs-submission-0.0.3.10.json").is_file())
        self.assertEqual(len(list(destination.rglob("argv.json"))), 1)

    def test_failed_lint_does_not_submit_or_reserve_a_version(self):
        tool = self.fake_tool(lint_status=1)
        destination = self.output / "bad lint"
        with self.signing_env(tool), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(ValueError, "failed lint"):
                release.sign(self.root, self.unsigned, destination)
        self.assertFalse((destination / ".tabs-submission-0.0.3.10.json").exists())
        self.assertEqual(list(destination.rglob("argv.json")), [])

    def test_unpack_refuses_existing_installs_and_extracts_only_validated_files(self):
        directory = self.output / "unpacked development"
        result = release.unpack(self.unsigned, directory)
        self.assertEqual((directory / "api.js").read_bytes(), (self.root / "api.js").read_bytes())
        self.assertGreater(result["files"], 1)
        with self.assertRaises(FileExistsError):
            release.unpack(self.unsigned, directory)
        bad = self.signed(lambda files: files.update({"../outside": b"no"}), name="unsafe-unpack.zip")
        with self.assertRaises(ValueError):
            release.unpack(bad, self.output / "not-created")
        self.assertFalse((self.output / "not-created").exists())

    def test_an_existing_same_version_xpi_blocks_signing(self):
        self.signed()
        with self.signing_env(self.fake_tool()), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(FileExistsError):
                release.sign(self.root, self.unsigned, self.output)
        self.assertEqual(list(self.output.rglob("argv.json")), [])

    def test_source_changes_during_signing_do_not_publish_the_download(self):
        tool = self.fake_tool()
        code = tool.read_text()
        code = code.replace("raise SystemExit(SIGN_STATUS)", "raise SystemExit(SIGN_STATUS)")
        code = code.replace("raise SystemExit(0)\n", "raise SystemExit(0)\n", 1)
        # Add a source edit at the sign-only exit, after the fake download.
        where = code.rfind('raise SystemExit(0)')
        self.assertGreater(where, 0)
        code = code[:where] + f"pathlib.Path({str(self.root / 'api.js')!r}).write_text('changed during submission')\n" + code[where:]
        tool.write_text(code)
        destination = self.output / "source-race"
        with self.signing_env(tool), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(ValueError):
                release.sign(self.root, self.unsigned, destination)
        self.assertEqual(list(destination.glob('*.xpi')), [])
        self.assertTrue((destination / '.tabs-submission-0.0.3.10.json').exists())
        self.assertEqual(len(list(destination.rglob('*.xpi'))), 1)

    def test_signing_env_is_parsed_as_data_not_shell_code(self):
        marker = self.root / "must-not-exist"
        (self.root / ".env").write_text(f'JWT_SECRET="$(touch {marker})"\nEXT_NAME="Local display name"\n')
        with patch.dict(os.environ, {}, clear=True):
            release.load_signing_environment(self.root)
            self.assertEqual(os.environ["JWT_SECRET"], f"$(touch {marker})")
            self.assertFalse(marker.exists())
            self.assertNotIn("EXT_NAME", os.environ)


if __name__ == "__main__":
    unittest.main()
