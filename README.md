# Titli

A tiny butterfly that carries a short note onto someone's screen.

Tap a saved quick note (or just a heart), and a small butterfly drifts onto the other person's
screen, lands in the top-right corner, opens its wings and shows your note. They can react with an
emoji or send a butterfly back. No typing back, no chat: just a small moment.

Runs on **Mac and Windows**, and they talk to each other: Mac to Mac, Windows to Windows, Mac to Windows
and back. On a Mac it lives in the menu bar; on Windows, by the clock.

- **Quick notes**: save up to 12 short notes (60 characters max), reorder them, and send one with a click, a number key, or from the menu-bar icon's right-click menu.
- **One-to-one or groups**: pair with one person, or make a group where everyone gets the butterfly.
- **Never at a bad moment**: butterflies wait while you're on a call (camera or mic in use), something is full screen, the screen is locked, the laptop is asleep, or you've stepped away. They're also invisible to screen sharing and recordings.
- **Schedules**: a butterfly at a set time, once, every day or on weekdays. Handy as a gentle reminder. Tap one to change it or send it now.
- **Activity**: everything you sent and received in one timeline, with seen receipts and reactions.
- **No accounts**: everything stays on your computer. Butterflies travel through a free relay ([ntfy](https://ntfy.sh)), encrypted on your laptop so the relay can't read them.

## Run it on your Mac (from source)

You need [Node.js 20+](https://nodejs.org) and, for call detection, the Xcode command line tools (`xcode-select --install`).

```bash
git clone https://github.com/asrohit723-jpg/titli.git
cd titli
npm install
npm run build:helper   # optional: lets Titli notice calls and full-screen apps
npm start
```

A butterfly icon appears in the menu bar. Click it, or press **⌥ Space** anywhere (⌃⌥ Space if another app already uses ⌥ Space).

## Run it on Windows (from source)

You need [Node.js 20+](https://nodejs.org). The call-detection helper compiles with the .NET Framework
compiler that every Windows 10/11 PC already has.

```bash
git clone https://github.com/asrohit723-jpg/titli.git
cd titli
npm install
npm run build:helper   # optional: lets Titli notice calls and full-screen apps
npm start
```

A butterfly icon appears by the clock. Windows tucks new icons under the **^** arrow; drag it onto the
taskbar to keep it in sight. Click it, or press **Ctrl+Alt+Space** anywhere (Ctrl+Shift+Space if that's taken).

To try it alone: Settings (the gear) → **Show it on my screen**.
To try it with someone: both run Titli, one makes a code (People → Make a code), the other enters it.

## Build the installer

```bash
npm run dist          # Mac: dist/Titli-<version>-arm64.dmg (Apple Silicon) and dist/Titli-<version>-x64.dmg (Intel)
npm run dist:win      # Windows: dist/Titli-Setup-<version>-x64.exe
```

Or push a tag (`git tag v0.1.0 && git push --tags`) and GitHub Actions builds the `.dmg` and attaches it to a release.

The app isn't signed with an Apple Developer ID yet, so the first time people open it macOS will block it.
They right-click **Titli** in Applications and choose **Open**, or go to System Settings → Privacy & Security → **Open Anyway**.
Signing and notarising (Apple Developer Program, $99/year) removes that step.

On Windows the installer isn't code-signed either, so the first time SmartScreen says "Windows protected
your PC": click **More info** → **Run anyway**. It installs for the current user only (no admin needed) and
opens Titli. A code-signing certificate removes that step.

## In-app updates

Once Titli is installed, it updates itself: when a new version is out, an **Update** button appears at the
top of the panel (and in Settings → Updates and the menu-bar right-click menu). One click downloads it,
checks it, swaps it in and reopens Titli. There's no "Open Anyway" step for updates.

How it stays safe: every build publishes `latest-mac.json` and `latest-win.json`, signed with a private key
that only GitHub Actions has. The app checks that signature with the public key it ships with
(`src/main/update-key.pem`), then the download's size and SHA-256. On a Mac it also checks the bundle id,
the version and the code signature before swapping the app; on Windows it then runs the installer quietly,
which replaces Titli and reopens it. If any check fails, nothing is replaced.

Updates come from a separate **public** repo, `asrohit723-jpg/titli-releases`, which holds only the
downloads. The code stays private. One-time setup:

1. Create a public repo named `titli-releases` on GitHub, and tick **Add a README** so it isn't empty.
2. Make a token: GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token.
   Repository access: **Only select repositories** → `titli-releases`. Permissions: **Contents → Read and write**.
3. In this repo: Settings → Secrets and variables → Actions → New repository secret, twice:
   - `RELEASES_TOKEN`: the token from step 2
   - `UPDATE_SIGNING_KEY`: the private key (the whole `-----BEGIN PRIVATE KEY-----` block)

Then every run of the **Build** workflow (Actions → Build → Run workflow) gets a new version number
(`0.1.<run>`) and is published to `titli-releases`, where installed apps find it within a few hours or as
soon as someone opens the panel. Without the secrets, the build still runs and its installers are kept as a
workflow artifact; it just isn't published as an update.

## How it works

| Piece | Where |
| --- | --- |
| Pairing, groups, sending, receipts, schedules | `src/core/titli.js` (plain Node, tested) |
| Invite codes and key derivation | `src/core/codes.js` |
| Encryption (AES-256-GCM) | `src/core/seal.js` |
| Relay client (ntfy JSON stream, 12-hour catch-up) | `src/core/relay.js` |
| When a butterfly may land | `src/core/presence.js`, `src/main/delivery.js` |
| Camera / mic / full-screen checks | `native/mac/TitliPresence.swift`, `native/win/TitliPresence.cs` |
| Where the panel opens (menu bar, taskbar on any edge) | `src/main/position.js` |
| Menu bar, panel, shortcut, notifications | `src/main/main.js` |
| Updates (check, download, verify, swap) | `src/main/updater.js`, `src/core/update-manifest.js` |
| The see-through window the butterfly flies in | `src/main/overlay.js`, `src/renderer/overlay/` |
| The 3D butterfly | `src/renderer/overlay/overlay.js` (three.js) |

**Pairing.** An invite code (`P…`) is single-use. When the other person enters it, their Titli posts
"join" on a channel derived from the code; yours answers "welcome" with a fresh random secret for the
two of you, and the code is used up. A group code (`G…`) is the group's secret itself, so anyone
with it can join.

**Delivery.** Each pair or group has a relay topic and a key, both derived from its secret. Notes,
"arrived", "seen" and reactions are all encrypted before they leave your Mac. ntfy keeps messages
for 12 hours, so a laptop that was asleep catches up when it wakes.

**Relay.** `https://ntfy.sh` is free and needs no account. For more reliability or longer catch-up,
run your own ntfy server and set it in Settings → Relay (everyone paired must use the same one).

## Tests

```bash
npm test                                         # core: pairing, groups, offline catch-up, schedules
npx electron scripts/smoke.js                     # opens the app, lands a butterfly, saves screenshots to dist/smoke
```
