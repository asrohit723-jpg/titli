# Titli

A tiny butterfly that carries a short note onto someone's screen: for family, friends, or someone special.

Tap a saved quick note (or just a heart), and a small butterfly drifts onto the other person's
screen, lands in the top-right corner, opens its wings and shows your note. They can react with an
emoji or send a butterfly back. No typing back, no chat: just a small moment.

Runs on **Mac and Windows**, and they talk to each other: Mac to Mac, Windows to Windows, Mac to Windows
and back. On a Mac it lives in the menu bar; on Windows, by the clock.

- **Quick notes**: save up to 12 short notes for everyone, plus up to 8 just for each person or group (they show first when you send to them). Reorder them, and send one with a click, a number key, or from the menu-bar icon's right-click menu.
- **One-to-one or groups**: pair with one person, or make a group where everyone gets the butterfly.
- **One tap, your way**: for each person or group, pick what one tap sends: a heart, a wave, a kiss, or any emoji you like.
- **Seven butterflies**: Blush Rose, Blush Peony, Gold Leaf, Midnight, Sky Morpho, Spring Leaf and Monarch. The app itself keeps one warm coral, whichever you pick.
- **Never at a bad moment**: butterflies wait while you're on a call (camera or mic in use), something is full screen, the screen is locked, the laptop is asleep, or you've stepped away. They're also invisible to screen sharing and recordings.
- **Lands somewhere new**: a corner or the middle of a side, never the same spot twice running, keeping clear of the menu bar, Dock and taskbar (or always top right, if you prefer).
- **A different flight every time**: it arrives one of 8 ways (a wide sweep, a lazy loop, a figure eight, a dive, a fly-by from beside you...) and leaves one of 6, each re-shaped on every visit and flown in a calm, easy or playful mood. It never repeats its last few routes.
- **Activity**: everything you sent and received in one timeline, with seen receipts and reactions.
- **No accounts**: everything stays on your computer. Butterflies travel through a free relay ([ntfy](https://ntfy.sh)), encrypted on your laptop so the relay can't read them.
- **Private by design**: pairing uses a key exchange, so an invite code someone else sees is useless; every message is signed, so nobody can send as you; group keys change when someone leaves; and your saved data stays in a file only your account can open (encrypted on Windows; on a Mac, Titli never asks for your password or the Keychain). See [Security](#security).

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

How it stays safe: every build publishes `latest-mac.json` and `latest-win.json`, signed with private keys
that only GitHub has. The app checks the signature against the public keys it ships with
(`src/main/update-key.pem`, the original, and `update-key-2.pem`, the release key), ignores a manifest older
than one it has already seen, then checks the download's size and SHA-256. On a Mac it also checks the bundle id,
the version and the code signature before swapping the app; on Windows it then runs the installer quietly,
which replaces Titli and reopens it. If any check fails, nothing is replaced.

Updates come from a separate **public** repo, `asrohit723-jpg/titli-releases`, which holds only the
downloads. The code stays private. One-time setup:

1. Create a public repo named `titli-releases` on GitHub, and tick **Add a README** so it isn't empty.
2. Make a token: GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token.
   Repository access: **Only select repositories** → `titli-releases`. Permissions: **Contents → Read and write**.
3. In this repo: Settings → Secrets and variables → Actions → New repository secret:
   `RELEASES_TOKEN`, the token from step 2. (`UPDATE_SIGNING_KEY`, the original signing key, is here too
   until everyone has updated past 0.1.32; then delete it.)
4. Settings → Environments → **New environment** named `release`:
   - **Required reviewers**: yourself, so no release goes out without your click.
   - **Deployment branches**: Selected branches → `main`.
   - **Environment secret** `RELEASE_KEYS`: the release key blob (the new update-signing key and the Mac
     signing certificate). Only jobs you approve can read it.

Then every run of the **Build** workflow (Actions → Build → Run workflow) gets a new version number
(`0.1.<run>`). The `release` job waits for your approval, then builds the Mac apps, signs the update
manifests and publishes to `titli-releases`, where installed apps find it within a few hours or as soon as
someone opens the panel.

## How it works

| Piece | Where |
| --- | --- |
| Pairing, groups, sending, receipts | `src/core/titli.js` (plain Node, tested) |
| Invite codes and key derivation | `src/core/codes.js` |
| Encryption (AES-256-GCM) | `src/core/seal.js` |
| Device keys, signatures, key exchange, safety codes | `src/core/identity.js` |
| Relay client (ntfy JSON stream, 12-hour catch-up) | `src/core/relay.js` |
| When a butterfly may land | `src/core/presence.js`, `src/main/delivery.js` |
| Camera / mic / full-screen checks | `native/mac/TitliPresence.swift`, `native/win/TitliPresence.cs` |
| Where the panel opens (menu bar, taskbar on any edge) | `src/main/position.js` |
| Menu bar, panel, shortcut, notifications | `src/main/main.js` |
| Updates (check, download, verify, swap) | `src/main/updater.js`, `src/core/update-manifest.js` |
| The see-through window the butterfly flies in | `src/main/overlay.js`, `src/renderer/overlay/` |
| The 3D butterfly | `src/renderer/overlay/overlay.js` (three.js) |
| Its flight routes (planned and checked for smooth turns) | `src/renderer/overlay/flight-paths.js` |

**Pairing.** An invite code (`P…`) is single-use and lasts 24 hours. When the other person enters it,
their Titli posts "join" with a one-off public key on a channel derived from the code; yours answers
"welcome" with its own. Each side works out the pair's secret from the two keys (X25519), so it never
crosses the relay and someone who only saw the code learns nothing. The code is used up. Pairs made by
0.1.32 or earlier do the same exchange over their old channel once both people have updated.

**Groups.** A group code (`H…`) is an invite that lasts 24 hours. Whoever made it answers each joiner with
the group's random secret, sealed so only that joiner can open it. The owner can remove people; when
someone leaves or is removed, the owner makes a new secret and seals a copy for each remaining member,
and open codes are cancelled. Old groups (`G…` codes, where the code was the secret) switch over once
everyone in them has updated.

**Delivery.** Each pair or group has a relay topic and a key, both derived from its secret. Notes,
"arrived", "seen" and reactions are all encrypted before they leave your Mac. ntfy keeps messages
for 12 hours, so a laptop that was asleep catches up when it wakes.

**Signed messages.** Each computer has its own signing key (Ed25519). Every message is signed, the
signature covers which channel it was sent to and when, and once Titli knows someone's key it only
accepts messages signed by it. So nobody, not even someone in your group, can send as you, fake a "Seen",
or remove you. Messages more than 14 hours old are refused, so old ones can't be played back.

**Relay.** `https://ntfy.sh` is free and needs no account. Relays must use `https://`. For more reliability or longer catch-up,
run your own ntfy server and set it in Settings → Relay (everyone paired must use the same one).

## Security

| Risk | What Titli does |
| --- | --- |
| Someone sees your invite code | The key comes from a key exchange, not the code; the code works once |
| Someone in a group pretends to be someone else | Every message is signed by its sender's own key |
| Someone left or was removed but kept the key | A new key for everyone else; old keys and codes let no one back in |
| Someone between you (rare, needs the code *and* to act first) | Compare the **Safety code** in People → ••• with the other person |
| Another account on your computer reads your files | Saved data is in a file only your account can open; on Windows it's also encrypted with a key Windows keeps for you |
| A fake update | Updates must be signed by a key only GitHub's approved release job has |
| Old messages replayed | Refused after 14 hours, and duplicates are ignored |

What it can't hide: the relay sees which computers are online, when they send something, and that two
computers share a channel (not who you are or what you say). Run your own relay if that matters. Without
paid Apple and Microsoft developer certificates, the first install still shows the "Open Anyway" /
"Run anyway" step, so only download Titli from the link you trust. You can turn off "Arrived"/"Seen"
in Settings → Privacy.

## Tests

```bash
npm test                                         # core, security (each attack tried), updates, flight paths
npx electron scripts/smoke.js                     # opens the app, lands a butterfly, saves screenshots to dist/smoke
```
