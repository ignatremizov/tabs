#!/usr/bin/env python3
"""Exact-version packaging, immutable signing submissions, and payload verification.

Signing is explicit and never increments versions or retries an AMO submission.
Payload verification is not cryptographic signature verification: finish a real
release with tests/firefox-signed-smoke.py in a fresh, signature-enforcing profile.
"""
# SPDX-License-Identifier: AGPL-3.0-or-later
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import shlex
import stat
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
WEB_EXT_VERSION = "10.6.0"  # Tested release tool, intentionally not an unpinned latest.
ASSET_DIRS = {"_locales", "bkgd", "common", "docs", "img", "options", "themes", "view"}
ASSET_SUFFIXES = {".js", ".mjs", ".html", ".css", ".json", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".md"}
SIGNATURES = {"META-INF/cose.manifest", "META-INF/cose.sig", "META-INF/manifest.mf",
              "META-INF/mozilla.sf", "META-INF/mozilla.rsa"}
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_ARCHIVE_BYTES = 256 * 1024 * 1024


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def strict_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError(f"Duplicate JSON key: {key}")
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=pairs,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError(f"Invalid JSON number: {value}")))


def git(source, *args):
    return subprocess.check_output(["git", "-C", str(source), *args], stderr=subprocess.DEVNULL)


def require_clean(source):
    for args in (("diff", "--quiet"), ("diff", "--cached", "--quiet")):
        if subprocess.run(["git", "-C", str(source), *args], check=False).returncode:
            raise ValueError("Release source/index is dirty; commit the reviewed source first")
    return git(source, "rev-parse", "HEAD").decode().strip()


def metadata(source):
    for name in ("manifest-ff.json", "manifest.json", "VERSION_BUILD"):
        if (source / name).is_symlink():
            raise ValueError(f"Symlinked release metadata: {name}")
    manifests = [strict_json((source / name).read_bytes()) for name in ("manifest-ff.json", "manifest.json")]
    if not all(isinstance(value, dict) for value in manifests):
        raise ValueError("Manifests must be JSON objects")
    version = manifests[0].get("version")
    if not isinstance(version, str) or not re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", version):
        raise ValueError("Expected exact MAJOR.MINOR.PATCH.BUILD version")
    if any(int(part) > 65535 for part in version.split(".")) or manifests[1].get("version") != version:
        raise ValueError("Browser manifest versions differ or exceed browser limits")
    base, build = version.rsplit(".", 1)
    if (source / "VERSION_BUILD").read_text().split() != [base, build]:
        raise ValueError("VERSION_BUILD and manifest versions differ; no automatic bump is performed")
    addon_id = manifests[0].get("browser_specific_settings", {}).get("gecko", {}).get("id")
    if not isinstance(addon_id, str) or not addon_id:
        raise ValueError("A stable Firefox addon ID is required")
    return {"version": version, "addonId": addon_id}


def package_path(path):
    parts = PurePosixPath(path).parts
    if not parts or any(part.startswith(".") for part in parts):
        return False
    if len(parts) == 1:
        return path != "COMMUNICATION.md" and (Path(path).suffix in {".js", ".md", ".html"}
            or path == "Makefile" or path == "LICENSE" or path.startswith("LICENSE."))
    return parts[0] in ASSET_DIRS and parts[:2] != ("docs", "dev")


def source_payload(source, browser, *, index=False, allow_dirty=False):
    source = source.resolve()
    info = metadata(source)
    commit = git(source, "rev-parse", "HEAD").decode().strip() if allow_dirty else require_clean(source)
    tracked = set(git(source, "ls-files", "-z").decode().split("\0"))
    for name in ("manifest-ff.json", "manifest.json", "VERSION_BUILD"):
        if name not in tracked:
            raise ValueError(f"Untracked release metadata: {name}")
    paths = []
    for path in source.iterdir():
        if path.name in ASSET_DIRS and path.is_symlink():
            raise ValueError(f"Symlinked asset directory: {path.name}")
        if path.is_file() or path.is_symlink():
            paths.append(path)
        elif path.name in ASSET_DIRS:
            if path.is_symlink():
                raise ValueError(f"Symlinked asset directory: {path.name}")
            paths.extend(path.rglob("*"))
    payload = {}
    for path in paths:
        name = path.relative_to(source).as_posix()
        if not package_path(name):
            continue
        if path.is_symlink():
            raise ValueError(f"Symlinked package path: {name}")
        if not path.is_file():
            continue
        if len(PurePosixPath(name).parts) > 1 and path.suffix not in ASSET_SUFFIXES:
            raise ValueError(f"Unexpected asset type: {name}")
        if name not in tracked:
            raise ValueError(f"Untracked package file must be staged or removed: {name}")
        # Clean release reads use the immutable commit, which is equal to the
        # index; an editor/index update during the scan cannot mix revisions.
        data = git(source, "show", f"{commit}:{name}") if (index or not allow_dirty) else path.read_bytes()
        if len(data) > MAX_FILE_BYTES:
            raise ValueError(f"Package member too large: {name}")
        payload[name] = data
    manifest_name = "manifest-ff.json" if browser == "firefox" else "manifest.json"
    payload["manifest.json"] = git(source, "show", f"{commit}:{manifest_name}") if (index or not allow_dirty) else (source / manifest_name).read_bytes()
    if not allow_dirty and require_clean(source) != commit:
        raise ValueError("Release source changed while taking its snapshot")
    if sum(map(len, payload.values())) > MAX_ARCHIVE_BYTES:
        raise ValueError("Package payload exceeds size limit")
    info.update(browser=browser, sourceCommit=commit)
    return payload, info


def read_archive(path):
    path = Path(path)
    if path.is_symlink():
        raise ValueError("Refusing symlinked archive input")
    result, seen, total = {}, set(), 0
    with zipfile.ZipFile(path) as archive:
        for member in archive.infolist():
            name = member.filename
            parts = name.rstrip("/").split("/")
            if name != member.orig_filename or "\x00" in name or not name or name.startswith("/") or "\\" in name or ":" in parts[0] or any(part in ("", ".", "..") for part in parts):
                raise ValueError(f"Unsafe archive path: {name}")
            if name.rstrip("/").casefold() in seen:
                raise ValueError(f"Duplicate archive path: {name}")
            seen.add(name.rstrip("/").casefold())
            kind = stat.S_IFMT(member.external_attr >> 16)
            if (kind not in (0, stat.S_IFREG, stat.S_IFDIR) or member.flag_bits & 1
                or member.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                or (kind == stat.S_IFDIR and not member.is_dir())):
                raise ValueError(f"Unsupported archive member: {name}")
            if member.is_dir():
                continue
            total += member.file_size
            if member.file_size > MAX_FILE_BYTES or total > MAX_ARCHIVE_BYTES:
                raise ValueError("Archive exceeds payload size limit")
            result[name] = archive.read(member)  # Includes CRC verification.
    folded_files = {name.casefold() for name in result}
    for name in result:
        for parent in PurePosixPath(name).parents:
            if str(parent).casefold() in folded_files:
                raise ValueError(f"Archive file/directory conflict: {name}")
    if "manifest.json" not in result:
        raise ValueError("Archive has no manifest")
    if not isinstance(strict_json(result["manifest.json"]), dict):
        raise ValueError("Archive manifest must be a JSON object")
    return result


def exclusive_write(path, data):
    path = Path(path)
    if path.exists():
        if path.is_symlink() or path.read_bytes() != data:
            raise FileExistsError(f"Refusing to overwrite existing artifact: {path}")
        return  # An identical deterministic rebuild is a no-op, not an overwrite.
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temporary:
        temp = Path(temporary.name)
        temporary.write(data)
        temporary.flush()
        os.fsync(temporary.fileno())
    try:
        os.link(temp, path)  # Atomic, same-filesystem publication without replacement.
    finally:
        temp.unlink()


def write_json(path, value):
    exclusive_write(path, (json.dumps(value, indent=2, sort_keys=True) + "\n").encode())


def build(source, browser, output, allow_dirty=False):
    payload, info = source_payload(source, browser, allow_dirty=allow_dirty)
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, content in sorted(payload.items()):
            entry = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = (stat.S_IFREG | 0o644) << 16
            archive.writestr(entry, content, compresslevel=9)
    package = Path(output) / f"ignatremizov-tabs-{info['version']}-{browser}.zip"
    info.update(sha256=sha256(data.getvalue()), files={name: sha256(value) for name, value in sorted(payload.items())})
    # Preflight both immutable outputs before writing either one.
    receipt = package.with_suffix(".build.json")
    receipt_bytes = (json.dumps(info, indent=2, sort_keys=True) + "\n").encode()
    for path, content in ((package, data.getvalue()), (receipt, receipt_bytes)):
        if path.exists() and (path.is_symlink() or path.read_bytes() != content):
            raise FileExistsError(f"Refusing to overwrite existing artifact: {path}")
    exclusive_write(package, data.getvalue())
    exclusive_write(receipt, receipt_bytes)
    return {**info, "archive": str(package)}


def verify(unsigned, signed, source=None):
    expected = read_archive(unsigned)
    if any(name.startswith("META-INF/") for name in expected):
        raise ValueError("Unsigned input unexpectedly contains signing metadata")
    manifest = strict_json(expected["manifest.json"])
    version = manifest.get("version")
    addon_id = manifest.get("browser_specific_settings", {}).get("gecko", {}).get("id")
    if not isinstance(version, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError("The signed Firefox payload requires an exact four-part version")
    if not isinstance(addon_id, str) or not addon_id:
        raise ValueError("The signed Firefox payload requires a stable addon ID")
    if source:
        payload, info = source_payload(Path(source), "firefox", index=True)
        if expected != payload:
            raise ValueError("Unsigned payload differs from the clean source index")
    actual = read_archive(signed)
    signatures = {name for name in actual if name.startswith("META-INF/")}
    cose = {"META-INF/cose.manifest", "META-INF/cose.sig"}
    legacy = SIGNATURES - cose
    if not signatures or not signatures <= SIGNATURES:
        raise ValueError("Missing or unexpected signature members")
    for group in (cose, legacy):
        if signatures & group and not group <= signatures:
            raise ValueError("Incomplete signature metadata")
    if not all(actual[name] for name in signatures):
        raise ValueError("Empty signature metadata")
    content = {name: data for name, data in actual.items() if name not in signatures}
    if content.keys() != expected.keys():
        raise ValueError("Signed payload has missing or extra files")
    normalized = []
    for name, data in expected.items():
        if content[name] == data:
            continue
        if name != "manifest.json" or json.dumps(strict_json(content[name]), sort_keys=True) != json.dumps(strict_json(data), sort_keys=True):
            raise ValueError(f"Signed payload differs: {name}")
        normalized.append(name)
    return {"version": version, "addonId": addon_id, "sha256": sha256(Path(signed).read_bytes()),
            "payloadFiles": len(expected), "normalizedFiles": normalized,
            "signatureMembers": sorted(signatures), "payloadVerified": True,
            "signatureVerified": False, "requiresFirefoxInstallCheck": True,
            "sourceCommit": info["sourceCommit"] if source else None}


def load_signing_environment(source):
    path = source / ".env"
    if not path.is_file():
        return
    allowed = {"JWT_ISSUER", "JWT_SECRET", "WEB_EXT_API_KEY", "WEB_EXT_API_SECRET",
               "WEB_EXT_BIN", "WEB_EXT_TIMEOUT_MS"}
    # Parse simple quoted assignments without executing shell code or exposing
    # file contents. Existing exported environment values take precedence.
    for number, line in enumerate(path.read_text().splitlines(), 1):
        try:
            parts = shlex.split(line, comments=True, posix=True)
        except ValueError as err:
            raise ValueError(f"Invalid signing environment assignment at line {number}") from err
        if parts and parts[0] == "export":
            parts = parts[1:]
        if not parts:
            continue
        if len(parts) != 1 or "=" not in parts[0]:
            raise ValueError(f"Unsupported signing environment syntax at line {number}")
        key, value = parts[0].split("=", 1)
        if key in allowed:
            os.environ.setdefault(key, value)


def tool_environment(credentials=False):
    # Do not inherit web-ext config flags, NODE_OPTIONS, or unrelated secrets.
    allowed = {"PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LANGUAGE",
               "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "XDG_CACHE_HOME"}
    env = {key: value for key, value in os.environ.items() if key in allowed or key.startswith("LC_")}
    if credentials:
        key = os.environ.get("WEB_EXT_API_KEY") or os.environ.get("JWT_ISSUER")
        secret = os.environ.get("WEB_EXT_API_SECRET") or os.environ.get("JWT_SECRET")
        if not key or not secret:
            raise ValueError("Signing requires environment credentials WEB_EXT_API_KEY/WEB_EXT_API_SECRET (or JWT_ISSUER/JWT_SECRET)")
        env.update(WEB_EXT_API_KEY=key, WEB_EXT_API_SECRET=secret)
    env.update(WEB_EXT_VERBOSE="false", WEB_EXT_NO_INPUT="true", WEB_EXT_CONFIG_DISCOVERY="false")
    return env


def redact(text):
    for key in ("WEB_EXT_API_KEY", "WEB_EXT_API_SECRET", "JWT_ISSUER", "JWT_SECRET"):
        value = os.environ.get(key)
        if value:
            text = text.replace(value, "[redacted]")
    return text


def run_tool(args, logfile, *, credentials=False):
    with Path(logfile).open("x") as log:
        process = subprocess.Popen(args, env=tool_environment(credentials), stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, text=True, errors="replace")
        try:
            with process.stdout:
                for line in process.stdout:
                    line = redact(line)
                    log.write(line)
                    log.flush()
                    print(line, end="", flush=True)
            return process.wait()
        except BaseException:
            # Only stop the child we launched. A submitted version remains
            # reserved even on interruption; this never retries the upload.
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            raise


def sign(source, unsigned, output, *, verify_only=False):
    source, unsigned, output = Path(source).resolve(), Path(unsigned).resolve(), Path(output).resolve()
    payload, info = source_payload(source, "firefox", index=True)
    if read_archive(unsigned) != payload:
        raise ValueError("Prebuilt Firefox archive does not match the clean reviewed source index")
    output.mkdir(parents=True, exist_ok=True)
    marker = output / f".tabs-submission-{info['version']}.json"
    if verify_only:
        state = strict_json(marker.read_bytes())
        if state["unsignedSha256"] != sha256(unsigned.read_bytes()) or state["sourceCommit"] != info["sourceCommit"]:
            raise ValueError("Recorded submission differs from this source/archive")
        stage = Path(state["stage"]).resolve()
        if not stage.is_relative_to(output) or not stage.name.startswith(".tabs-sign-"):
            raise ValueError("Recorded signing workspace is outside the artifact directory")
        status = None
    else:
        load_signing_environment(source)
        timeout = int(os.environ.get("WEB_EXT_TIMEOUT_MS", "900000"))
        if timeout <= 0:
            raise ValueError("WEB_EXT_TIMEOUT_MS must be a positive integer")
        if marker.exists():
            raise ValueError("This version was already submitted. Do not resubmit; collect its existing process/artifact, then use --verify-only")
        for path in output.glob("*.xpi"):
            if strict_json(read_archive(path)["manifest.json"]).get("version") == info["version"]:
                raise FileExistsError("A signed artifact with this version already exists")
        tool = os.environ.get("WEB_EXT_BIN") or shutil.which("web-ext")
        if not tool:
            raise ValueError(f"Install web-ext@{WEB_EXT_VERSION} in a private tool directory and set WEB_EXT_BIN; no unpinned npx fallback is used")
        installed = subprocess.check_output([tool, "--version"], env=tool_environment(), text=True).strip()
        if installed != WEB_EXT_VERSION:
            raise ValueError(f"Expected web-ext {WEB_EXT_VERSION}, found a different version")
        # Validate credentials before reserving an external submission.
        tool_environment(credentials=True)
        stage = Path(tempfile.mkdtemp(prefix=f".tabs-sign-{info['version']}-", dir=output))
        source_dir = stage / "source"
        source_dir.mkdir()
        for name, data in payload.items():
            dest = source_dir / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
            dest.chmod(0o444)
        for path in sorted(source_dir.rglob("*"), reverse=True):
            if path.is_dir():
                path.chmod(0o555)
        source_dir.chmod(0o555)
        if run_tool([tool, "lint", "--source-dir", str(source_dir), "--no-config-discovery"], stage / "lint.log"):
            raise ValueError("Prebuilt source failed lint; no AMO submission was made")
        state = {**info, "unsignedSha256": sha256(unsigned.read_bytes()), "stage": str(stage), "phase": "submitted"}
        # Exclusive reservation, including ambiguous failures and timeouts.
        with marker.open("x") as handle:
            json.dump(state, handle, indent=2)
        artifacts = stage / "artifacts"
        artifacts.mkdir()
        status = run_tool([tool, "sign", "--source-dir", str(source_dir), "--artifacts-dir", str(artifacts),
                           "--channel", "unlisted", "--no-config-discovery", "--timeout", str(timeout)],
                          stage / "sign.log", credentials=True)
    candidates = list((stage / "artifacts").glob("*.xpi"))
    if len(candidates) != 1:
        raise ValueError("No unique downloaded XPI. Submission remains recorded; do not restart signing automatically")
    if require_clean(source) != info["sourceCommit"]:
        raise ValueError("Source commit changed while signing; downloaded artifact retained without publication")
    candidate = candidates[0]
    result = verify(unsigned, candidate, source)
    target = output / candidate.name
    exclusive_write(target, candidate.read_bytes())
    result.update(archive=str(target), webExtExitCode=status)
    receipt = target.with_suffix(".verification.json")
    if receipt.exists():
        previous = strict_json(receipt.read_bytes())
        if previous["sha256"] != result["sha256"] or previous["sourceCommit"] != result["sourceCommit"]:
            raise ValueError("Existing verification receipt differs")
        result = previous
    else:
        write_json(receipt, result)
    return result


def unpack(unsigned, output):
    payload = read_archive(unsigned)
    output = Path(output)
    if output.is_symlink() or output.exists():
        raise FileExistsError("Unpacked destination already exists; choose a new development directory")
    output.parent.mkdir(parents=True, exist_ok=True)
    staged = Path(tempfile.mkdtemp(prefix=".tabs-unpack-", dir=output.parent))
    try:
        for name, data in payload.items():
            path = staged / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        # mkdir is an exclusive reservation; never recursively remove an old
        # development install, even if another command races this extraction.
        output.mkdir()
        for child in staged.iterdir():
            child.rename(output / child.name)
    finally:
        shutil.rmtree(staged)
    return {"directory": str(output.resolve()), "files": len(payload)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    packaging = commands.add_parser("build", help="Build exact current version without changing manifests or counters")
    packaging.add_argument("--source", type=Path, default=ROOT)
    packaging.add_argument("--browser", choices=("firefox", "chromium"), required=True)
    packaging.add_argument("--output", type=Path, required=True)
    packaging.add_argument("--allow-dirty", action="store_true", help="Development build only; package files must still be tracked/staged")
    verification = commands.add_parser("verify", help="Verify source payload; does not replace Firefox signature enforcement")
    verification.add_argument("--unsigned", type=Path, required=True)
    verification.add_argument("--signed", type=Path, required=True)
    verification.add_argument("--source", type=Path)
    verification.add_argument("--receipt", type=Path)
    extraction = commands.add_parser("unpack", help="Extract a validated package into a new development directory")
    extraction.add_argument("--unsigned", type=Path, required=True)
    extraction.add_argument("--output", type=Path, required=True)
    signing = commands.add_parser("sign", help="Submit one immutable prebuilt Firefox version, or verify its existing download")
    signing.add_argument("--source", type=Path, default=ROOT)
    signing.add_argument("--unsigned", type=Path, required=True)
    signing.add_argument("--output", type=Path, required=True)
    signing.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    try:
        if args.command == "build":
            result = build(args.source, args.browser, args.output, args.allow_dirty)
        elif args.command == "unpack":
            result = unpack(args.unsigned, args.output)
        elif args.command == "verify":
            result = verify(args.unsigned, args.signed, args.source)
            if args.receipt:
                write_json(args.receipt, result)
        else:
            result = sign(args.source, args.unsigned, args.output, verify_only=args.verify_only)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, subprocess.SubprocessError) as err:
        print(redact(f"Release operation failed: {err}"), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
