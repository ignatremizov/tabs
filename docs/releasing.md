# Release verification

## Version selection and immutable builds

Normal build and sign commands increment the visible build number automatically.
`make` / `make all` increment once and build both browser ZIPs at the same new
version. `make firefox-zip`, `make chrome-zip`, and `make chrome-dir` increment
for their new build. `make firefox-sign` increments once, builds, and signs that
exact Firefox iteration; there is no second bump inside the signing step.

Separate normal commands intentionally produce separate iterations. Running
`make all` and then `make firefox-sign` advances twice. To sign the ZIP just
built without advancing again, use `make firefox-sign-current`. Do not combine
automatic signing with another build/bump goal in one make invocation; the
Makefile rejects that combination before either changes the counter.

The explicitly named `*-current` targets preserve the version: Firefox/Chromium
ZIPs, Chromium unpacking, and prebuilt Firefox signing. `make bump-version` is
also available for selecting a version without building. Update the changelog,
test, and commit reviewed code before signing; generated version metadata need
not be committed first. Nothing stages, commits, or pushes automatically.

`make release-current` builds clean committed source into Firefox and Chromium
ZIPs. Both manifests and `VERSION_BUILD` must agree exactly. The packager refuses
symlinks, untracked package candidates, and unexpected asset types; local agent
handoffs, environment files, tests, and developer-only documentation do not ship.
It records source commit, every payload hash, and the archive SHA256 in a build
receipt. ZIP timestamps/order/modes are fixed for reproducible bytes. CI uses
this explicit no-bump path, not the normal iteration-building commands.

```sh
make test-node
node tests/node/browser-coverage.mjs
make test-release
ARTIFACTS_DIR=/tmp/tabs-release-candidate make release-current
```

Identical current-version rebuilds are no-ops. Existing different ZIPs, XPIs, receipts, or unpacked
installations are never overwritten. Use a new output directory for development
previews; use a genuinely new version when publishing changed code. `make
chrome-dir` extracts a validated archive into a new `CHROMIUM_DIR` (default
`dist/chromium`) without deleting an existing development install. Version
increments are not rolled back after a later build/sign failure.

## Signing a new iteration or a prebuilt current version

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

The normal workflow validates code/tooling, increments, builds, and signs:

```sh
ARTIFACTS_DIR=/tmp/tabs-release-candidate make firefox-sign
```

All code must match the committed source. The only permitted uncommitted changes
for signing are the versions in both manifests and the matching `VERSION_BUILD`.
Manifest permissions, identities, and other fields must still match the commit,
including staged changes. Receipts record the commit plus hashes of generated
`versionOverrides`, rather than pretending the entire package was committed.
Source and version metadata are rechecked before upload and after download.

To sign an already-built iteration without another bump, use:

```sh
FIREFOX_ARCHIVE=/tmp/tabs-release-candidate/ignatremizov-tabs-VERSION-firefox.zip \
ARTIFACTS_DIR=/tmp/tabs-release-candidate \
make firefox-sign-current
```

`FIREFOX_ARCHIVE` defaults to the current version's ZIP under `ARTIFACTS_DIR`.
It is rejected by automatic signing to avoid ignoring an explicitly chosen
package. Direct `bin/firefox-sign.sh` also increments by default; `--current`
and `--verify-only` retain the selected version.

The command verifies the prebuilt archive against the reviewed source, checks the
pinned runtime, stages read-only payload files, and lints them without credentials.
Only the signing child receives AMO credentials, through its environment. Tool
output is redacted before printing or recording. No unpinned `npx` fallback is
used and no tests or build steps modify the payload during signing.

Before the single external submission, an exclusive version reservation is
written in the output directory. **An ambiguous timeout, nonzero exit, or missing
XPI must not cause another upload.** Collect the existing process/download first.
The reservation and temporary signing directory are intentionally retained.
Unresolved reservations block a fresh automatic signing attempt before a bump:
a new build number must not conceal an uncertain previous submission. Successful
payload verification records completion, allowing the next deliberate iteration.

When the original submission has already downloaded its XPI, verification can
be resumed without running a signing tool or reading credentials:

```sh
ARTIFACTS_DIR=/tmp/tabs-release-candidate \
make firefox-sign-current SIGN_ARGS=--verify-only
```

Do not remove reservations to work around an uncertain submission. Check AMO's
state before deciding on a later release version. A changed source commit or
archive is not accepted as a continuation of the original submission. Finish
collecting the submission before committing its generated version metadata.

## Independent verification

The verifier checks archive CRCs, safe paths, duplicate names, file sets, payload
bytes, and complete known signature-metadata sets. The only content difference
allowed is semantic-equivalent manifest JSON reformatting. Extra permissions,
changed identities/versions, modified code/assets, duplicate JSON keys, and extra
archive members are rejected.

```sh
python3 -B bin/release.py verify --source . --allow-version-bump \
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
automatic and paired-build increments, current-version exceptions, overflow,
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
