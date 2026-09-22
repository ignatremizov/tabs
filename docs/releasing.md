# Release verification

## Version selection and immutable builds

Building and signing no longer increment the version implicitly. `make all`,
`make firefox-zip`, and `make chrome-zip` are current-version development builds.
`make bump-version` is the explicit, separate version increment. Update the
changelog, test, and commit the reviewed source before preparing a release.

`make release-current` builds clean committed source into Firefox and Chromium
ZIPs. Both manifests and `VERSION_BUILD` must agree exactly. The packager refuses
symlinks, untracked package candidates, and unexpected asset types; local agent
handoffs, environment files, tests, and developer-only documentation do not ship.
It records source commit, every payload hash, and the archive SHA256 in a build
receipt. ZIP timestamps/order/modes are fixed for reproducible bytes.

```sh
make test-node
node tests/node/browser-coverage.mjs
make test-release
ARTIFACTS_DIR=/tmp/tabs-release-candidate make release-current
```

Identical rebuilds are no-ops. Existing different ZIPs, XPIs, receipts, or unpacked
installations are never overwritten. Use a new output directory for development
previews; use a genuinely new version when publishing changed code. `make
chrome-dir` extracts a validated archive into a new `CHROMIUM_DIR` (default
`dist/chromium`) without deleting an existing development install.

## Signing one exact Firefox archive

Install the tested signing runtime in a private tooling directory, not as a
production extension dependency:

```sh
npm install --prefix "$HOME/.local/share/tabs-release-tools" --no-audit --no-fund web-ext@10.6.0
export WEB_EXT_BIN="$HOME/.local/share/tabs-release-tools/node_modules/.bin/web-ext"
```

Provide `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET`, or `JWT_ISSUER` and
`JWT_SECRET`, through the environment. Existing simple quoted assignments in
`.env` are also supported. The file is parsed as data, not sourced as executable
shell code. Do not put real credentials on a command line, in a commit, or in a
shared log. Source manifest name and addon ID are authoritative: `EXT_NAME` and
`FF_EXT_ID` no longer silently replace them during packaging.

```sh
FIREFOX_ARCHIVE=/tmp/tabs-release-candidate/ignatremizov-tabs-VERSION-firefox.zip \
ARTIFACTS_DIR=/tmp/tabs-release-candidate \
make firefox-sign
```

The command verifies the prebuilt archive against the clean source, checks the
pinned runtime, stages read-only payload files, and lints them without credentials.
Only the signing child receives AMO credentials, through its environment. Tool
output is redacted before printing or recording. No unpinned `npx` fallback is
used and no tests or build steps modify the payload during signing.

Before the single external submission, an exclusive version reservation is
written in the output directory. **An ambiguous timeout, nonzero exit, or missing
XPI must not cause another upload.** Collect the existing process/download first.
The reservation and temporary signing directory are intentionally retained.

When the original submission has already downloaded its XPI, verification can
be resumed without running a signing tool or reading credentials:

```sh
python3 -B bin/release.py sign --verify-only \
  --unsigned /tmp/tabs-release-candidate/ignatremizov-tabs-VERSION-firefox.zip \
  --output /tmp/tabs-release-candidate
```

Do not remove reservations to work around an uncertain submission. Check AMO's
state before deciding on a later release version. A changed source commit or
archive is not accepted as a continuation of the original submission.

## Independent verification

The verifier checks archive CRCs, safe paths, duplicate names, file sets, payload
bytes, and complete known signature-metadata sets. The only content difference
allowed is semantic-equivalent manifest JSON reformatting. Extra permissions,
changed identities/versions, modified code/assets, duplicate JSON keys, and extra
archive members are rejected.

```sh
python3 -B bin/release.py verify --source . \
  --unsigned /tmp/tabs-release-candidate/ignatremizov-tabs-VERSION-firefox.zip \
  --signed /tmp/tabs-release-candidate/SIGNED.xpi \
  --receipt /tmp/tabs-release-candidate/payload-verification.json

python3 -B tests/firefox-signed-smoke.py \
  --xpi /tmp/tabs-release-candidate/SIGNED.xpi \
  --expected-version VERSION \
  --output /tmp/tabs-signed-smoke-NEW
```

**Signature metadata alone is not cryptographic verification.** The second
command starts a fresh marked Firefox profile with signature enforcement enabled,
installs the XPI normally (not as a temporary addon), and checks Firefox's verified
signature/active state, version, stable ID, and the actual production sidebar's
container icon, shared-SVG frame centering, hover/accessibility name, and native
group. The report includes the XPI SHA256 and the inspected screenshot path.
It does not access the user's profile, export cookies, or alter a live install.

Archive success must be verified independently of the signing command's exit
status. A tool can return an ambiguous status after downloading a valid artifact;
only verified bytes and a successful signature-enforcing installation support
release completion.

## Local tests and CI

`make test-release` uses disposable git repositories and a fake local web-ext
executable. It never reads real signing credentials or contacts AMO. Tests cover
version drift, dirty/untracked input, archive safety, immutable output, env-only
credentials/redaction, lint failures, single submission, and verify-only recovery.

Keep release receipts and synthetic test diagnostics outside the repository's
packaged source. CI must never sign automatically or receive AMO credentials.

The `Extension reliability` workflow in `.github/workflows/tests.yml` runs on
trunk pushes, pull requests, and manual dispatch with read-only repository
permissions. Its jobs run the Node/DOM and synthetic release suites, reproduce
both exact-version packages, and exercise Firefox lifecycle, failed-startup
recovery, rendering, two-view convergence, and full process restart. Actions are
pinned to full commit IDs; the Mozilla driver download has a verified checksum.
Only synthetic evidence and unsigned test packages are uploaded. Browser test
profiles are newly created on the runner, and no signing job or credentials are
configured. A local pass of these commands is separate from a hosted workflow
result, which is available after the commits are pushed.
