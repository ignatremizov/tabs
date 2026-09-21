#!/usr/bin/env python3
"""Verify a signed XPI in a new signature-enforcing Firefox profile.

This checks installation/signature state and the actual production sidebar.
It does not load unsigned test hooks or modify an existing browser profile.
"""
# SPDX-License-Identifier: AGPL-3.0-or-later
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import zipfile

from firefox_driver import FirefoxSession, new_workspace


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--xpi", type=Path, required=True)
    parser.add_argument("--expected-version", required=True)
    parser.add_argument("--expected-id", default="tktsto-ignat@ignatremizov.com")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--geckodriver", default=shutil.which("geckodriver"))
    args = parser.parse_args()
    if not args.geckodriver:
        parser.error("geckodriver is required")
    package = args.xpi.resolve(strict=True)
    with zipfile.ZipFile(package) as archive:
        manifest = json.loads(archive.read("manifest.json"))
    if manifest.get("version") != args.expected_version:
        parser.error("XPI version does not match the requested release")
    if manifest.get("browser_specific_settings", {}).get("gecko", {}).get("id") != args.expected_id:
        parser.error("XPI identity does not match the requested addon")
    work = new_workspace(args.geckodriver)
    with FirefoxSession(args.geckodriver, work, args.output) as browser:
        addon_id = browser.install(package, temporary=False)
        assert addon_id == args.expected_id, "Firefox installed an unexpected addon ID"
        browser.command("POST", "moz/context", {"context": "chrome"})
        try:
            details = browser.script("""
              const done = arguments[arguments.length - 1];
              const {AddonManager} = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
              AddonManager.getAddonByID(arguments[0]).then(addon => done({
                id: addon.id, version: addon.version, signedState: addon.signedState,
                signatureVerified: [AddonManager.SIGNEDSTATE_SIGNED, AddonManager.SIGNEDSTATE_PRIVILEGED,
                  AddonManager.SIGNEDSTATE_SYSTEM].filter(Number.isInteger).includes(addon.signedState),
                signatureEnforcement: Services.prefs.getBoolPref('xpinstall.signatures.required'),
                isActive: addon.isActive, temporarilyInstalled: addon.temporarilyInstalled,
                appDisabled: addon.appDisabled
              }), error => done({error: String(error)}));
            """, addon_id, asynchronous=True)
        finally:
            browser.command("POST", "moz/context", {"context": "content"})
        assert details["version"] == args.expected_version, details
        assert details["signatureVerified"] and details["signatureEnforcement"], details
        assert details["isActive"] and not details["appDisabled"] and not details["temporarilyInstalled"], details
        browser.navigate(browser.addon_url(addon_id) + "view/sidepanel.html")
        browser.wait("return document.querySelector('.row') !== null;")
        badge = browser.script("""
          const done = arguments[arguments.length - 1];
          (async () => {
            const identity = await browser.contextualIdentities.create({
              name: 'Signed release fixture', color: 'green', icon: 'briefcase'});
            const tab = await browser.tabs.create({url: 'about:blank', cookieStoreId: identity.cookieStoreId, active: false});
            const groupId = await browser.tabs.group({tabIds: [tab.id], createProperties: {windowId: tab.windowId}});
            await browser.tabGroups.update(groupId, {title: 'Signed release group', color: 'blue'});
            const until = Date.now() + 15000;
            while (Date.now() < until) {
              const badge = [...document.querySelectorAll('.container-badge')].find(node => node.title.includes(identity.name));
              const group = [...document.querySelectorAll('.native-group')].find(node => node.textContent.includes('Signed release group'));
              if (badge && group) {
                badge.scrollIntoView({block: 'center'});
                const frame = badge.querySelector('.container-icon-frame'), glyph = badge.querySelector('path');
                if (!frame || !glyph || frame.ownerSVGElement !== glyph.ownerSVGElement)
                  throw new Error('Container badge does not share the frame/icon SVG');
                const a = frame.getBoundingClientRect(), b = glyph.getBoundingClientRect();
                const dx = Math.abs((a.left + a.right - b.left - b.right) / 2);
                const dy = Math.abs((a.top + a.bottom - b.top - b.bottom) / 2);
                if (dx >= 0.05 || dy >= 0.05 || getComputedStyle(badge).borderLeftWidth !== '0px')
                  throw new Error('Container icon/frame centering is incorrect');
                if (badge.textContent !== '' || badge.getAttribute('role') !== 'img'
                  || badge.getAttribute('aria-label') !== badge.title)
                  throw new Error('Container tooltip/accessibility regression');
                return {frameAndGlyphShareSvg: true, centerDx: dx, centerDy: dy,
                  title: badge.title, accessibleName: badge.getAttribute('aria-label'),
                  iconOnly: true, nativeGroupRendered: true};
              }
              await new Promise(resolve => setTimeout(resolve, 100));
            }
            throw new Error('Signed production build did not render the context fixture');
          })().then(done, err => done({error: String(err)}));
        """, asynchronous=True)
        assert "error" not in badge and badge["frameAndGlyphShareSvg"], badge
        browser.screenshot("signed-release.png")
        result = {"firefox": browser.capabilities["browserVersion"], "addon": details, "badge": badge,
                  "xpi": str(package), "sha256": hashlib.sha256(package.read_bytes()).hexdigest(),
                  "workspace": str(work), "passed": True}
        (args.output / "results.json").write_text(json.dumps(result, indent=2))
        print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
