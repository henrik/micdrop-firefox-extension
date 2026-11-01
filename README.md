# Mic Drop for Firefox (unofficial port)

> [!WARNING]
> **This port was adapted entirely by Claude (an AI model from Anthropic) and has not been reviewed by a human.** It has been tested end to end once, in Zen 1.23.4b on macOS, but nobody has read the changes line by line. Use it at your own risk.

[Mic Drop](https://getmicdrop.com/) is a macOS app that gives you one global mute switch for your microphone. Its official [Chrome extension](https://chromewebstore.google.com/detail/mic-drop/nmhilhflkmmhmcighoickfgdlfeklgbe) keeps Google Meet's mute button in sync with the app, in both directions: mute with Mic Drop's shortcut and Meet follows, click mute in Meet and Mic Drop follows.

This repository is that extension (version 3.2.0) adapted for Firefox and Firefox-based browsers such as Zen: a lightweight [semport](https://factory.strongdm.ai/techniques/semport), with the same language and nearly the same code, retargeted from Chrome to Firefox. It's meant as a proof of concept for the Mic Drop developers, showing how little is needed for official Firefox support.

The extension code is Mic Drop's, taken unchanged from the Chrome Web Store package; only the manifest and one small extra script are new. It isn't affiliated with or endorsed by the Mic Drop developers. The original package ships without a licence, so all rights to the original code remain with its authors.

## How it works

The extension's background script connects to the Mic Drop app over a WebSocket on `ws://localhost:13400`–`13420`. A content script on `meet.google.com` watches Meet's mute button and passes mute changes back and forth via the background script.

## Installation

Requirements: macOS with the [Mic Drop app](https://getmicdrop.com/download-on-the-app-store) running, and Firefox 140 or later, or a Firefox-based browser such as Zen.

### Quick test (temporary add-on)

1. Clone this repository.
2. In Firefox, open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and pick `src/manifest.json`.
4. In `about:addons`, open Mic Drop → **Permissions** and make sure access to `meet.google.com` and `localhost` is on.
5. Open a Google Meet and toggle mute in Mic Drop or Meet.

A temporary add-on is removed when the browser restarts.

### Permanent install

Firefox only installs signed add-ons permanently. Signing is free:

1. Run `./build.sh` to build `mic-drop.xpi`. Change the `version` in `src/manifest.json` first if you've signed a build before, since each version can only be signed once.
2. Sign in at [addons.mozilla.org](https://addons.mozilla.org/developers/addon/submit/distribution), choose **On your own** (unlisted: signed but not published), and upload `mic-drop.xpi`.
3. Download the signed `.xpi` and open it in Firefox.

To debug, click **Inspect** next to Mic Drop in `about:debugging`; the extension's log lines start with `[Mic Drop]`.

## What changed from the Chrome version

The JavaScript is unchanged apart from the extra `origin-shim.js` and one fix in `content.js`: Meet in Firefox can ignore the extension's click on its mic button while the pre-join page is loading, and then report the old state. The original code takes that as a change made in Meet, which could unmute Mic Drop when opening a meeting page. The port ignores it instead and clicks again.

Changes in `src/manifest.json`:

- **Background script:** `"background": { "scripts": [...], "type": "module" }` instead of `service_worker`, since Firefox's Manifest V3 doesn't support service workers.
- **Firefox settings:** `browser_specific_settings.gecko` with an add-on `id`, `strict_min_version: "140.0"` (the first version with `data_collection_permissions`), and `data_collection_permissions: { "required": ["none"] }`, which addons.mozilla.org asks new add-ons to declare.
- **Content security policy:** `extension_pages` set to `"script-src 'self'"`. Firefox's default MV3 policy adds `upgrade-insecure-requests`, which could interfere with the `ws://localhost` connection to the app.
- **Removed:** the Chrome-only `update_url` and `minimum_chrome_version`.
- **Origin workaround:** the `webRequest`, `webRequestBlocking`, `ws://localhost/*` and `http://localhost/*` permissions, and `origin-shim.js` (see below).

Also, `unsupported.html` now says "remove it from your browser" instead of "from Chrome".

The package passes Mozilla's `web-ext lint` with 0 errors, 0 warnings and 0 notices.

## The workaround, and the proper fix

**The problem:** the Mic Drop app's WebSocket server only accepts connections from the Chrome extension's origin. Sending the same handshake with different `Origin` headers gives:

| `Origin` header | Response |
|---|---|
| `chrome-extension://nmhilhflkmmhmcighoickfgdlfeklgbe` | `101 Switching Protocols` |
| `moz-extension://…` | `400 Bad Request` |
| none | `400 Bad Request` |

**The workaround:** `src/origin-shim.js` uses Firefox's blocking `webRequest` API to rewrite the `Origin` header on WebSocket handshakes to `localhost`, so the app sees the Chrome extension's origin. With it, syncing works in both directions. It's a stopgap that pretends to be another extension, and it shouldn't ship.

**The proper fix is in the app:** also accept origins that start with `moz-extension://`. Firefox gives each installed copy of an extension its own random UUID (`moz-extension://<uuid>`), so an exact-match allowlist like the Chrome one can't work. Accepting the prefix is about as safe as the current check: ordinary web pages can't send a `moz-extension://` origin, only installed extensions can.

Once the app does that, an official Firefox build needs only:

1. The manifest changes above, minus the origin workaround: delete `origin-shim.js`, drop it from `background.scripts`, and remove the `webRequest`, `webRequestBlocking` and localhost permissions.
2. Publishing on [addons.mozilla.org](https://addons.mozilla.org/developers/), which is free.

Since Firefox also runs the `chrome.*` APIs this extension uses, the same JavaScript can serve both browsers.
