# PDF Reader

A barebones Android PDF reader with a highlighter. No ads, no accounts, no tracking, and no internet permission: your documents and markings never leave the phone.

## Features
- Opens PDFs from a file manager ("Open with") or, when launched from the home screen, from the system file picker.
- Full screen: status and navigation bars hidden (swipe from an edge shows them briefly). All pages stacked at full width; pinch to zoom.
- **Double tap** toggles mark mode (a thin orange line at the top of the screen). In mark mode, drag over text to mark it like a highlighter; drags that start off text still scroll.
- **Triple tap** opens the menu: *Undo* reverts the last marking or reset (repeatable while the document is open); *Reset markings* removes all markings of the document (after a confirm). Tap beside the menu to close it.
- Markings and the reading position are saved per document, keyed by a SHA-256 of the file, so the same file keeps them wherever it is opened from.

## Install
1. On your phone, open the [latest release](../../releases/latest) and download `pdf-reader-vX.Y.Z.apk`.
2. Open the downloaded file. Android asks once to allow installing apps from your browser or file manager ("Install unknown apps"); allow it.
3. Updates: install the APK of a newer release over the old one; markings and reading positions are kept.

The pre-release *Development build* holds the newest build of the main branch. It installs next to the released app as "PDF Reader (dev)".

## How it works
One `Activity` (`app/src/main/java/.../MainActivity.java`, no library dependencies) hosting a WebView. The viewer is `app/src/main/assets/` (`index.html`, `app.js`, `app.css`) on top of [pdf.js](https://mozilla.github.io/pdf.js/) (legacy build, copied from `node_modules` into `assets/pdfjs/`, not committed). Markings are rectangles in fractions of the page, stored in SharedPreferences through a small JS bridge.

## Build
- `npm ci && npm run assets` copies pdf.js into the assets; `./gradlew assembleDebug` builds a debug APK (needs JDK 17+ and the Android SDK).
- CI (`.github/workflows/android.yml`) builds on every push and pull request. Pushes to the default branch update the *Development build* pre-release; a tag `v1.2.3` builds a signed release APK and publishes it as release `v1.2.3` (versionName `1.2.3`; `versionCode` = CI run number).
- Repository secrets (Settings → Secrets and variables → Actions):
  - `RELEASE_KEYSTORE_BASE64`, `RELEASE_KEYSTORE_PASSWORD`, `RELEASE_KEY_ALIAS`: the release signing key (base64-encoded PKCS12 keystore; key and store share the password). Required for tag builds. Keep a backup: without the same key, users can't update.
  - `DEBUG_KEYSTORE_BASE64` (optional): a fixed debug key (alias `androiddebugkey`, passwords `android`) so development builds update in place.
- Dependabot opens weekly update PRs for pdf.js, the CI actions and the Android Gradle plugin; CI validates the Gradle wrapper.

## Test
`npm run check` runs `scripts/web-check.mjs`: the viewer in headless mobile Chromium with a generated PDF (render, text layer alignment, double tap, marking, reload, reading position, rotated page, menu, undo, reset). It needs a Chromium: set `CHROMIUM=/path/to/chrome`, or install Playwright's with `npx playwright-core install chromium`.

## License
MIT, see [LICENSE](LICENSE). Bundles [pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0; its license ships in the APK at `assets/pdfjs/LICENSE`).
