# Titli

A tiny butterfly that carries a short note onto someone's screen.

Tap a saved quick note (or just a heart) in your menu bar, and a small butterfly drifts onto the
other person's Mac, lands in the top-right corner, opens its wings and shows your note. They can
react with an emoji or send a butterfly back. No typing back, no chat: just a small moment.

- **Quick notes**: save up to 12 short notes (60 characters max) and send one with a click, a number key, or from the menu-bar icon's right-click menu.
- **One-to-one or groups**: pair with one person, or make a group where everyone gets the butterfly.
- **Never at a bad moment**: butterflies wait while you're on a call (camera or mic in use), something is full screen, the screen is locked, the laptop is asleep, or you've stepped away. They're also invisible to screen sharing and recordings.
- **Schedules**: a butterfly at a set time, once, every day or on weekdays. Handy as a gentle reminder.
- **No accounts**: everything stays on your Mac. Butterflies travel through a free relay ([ntfy](https://ntfy.sh)), encrypted on your laptop so the relay can't read them.

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

To try it alone: Settings → **Show a butterfly on my screen**.
To try it with someone: both run Titli, one makes an invite code (People → Make an invite code), the other enters it.

## Build the installer

```bash
npm run dist          # makes dist/Titli-<version>-universal.dmg
```

Or push a tag (`git tag v0.1.0 && git push --tags`) and GitHub Actions builds the `.dmg` and attaches it to a release.

The app isn't signed with an Apple Developer ID yet, so the first time people open it macOS will block it.
They right-click **Titli** in Applications and choose **Open**, or go to System Settings → Privacy & Security → **Open Anyway**.
Signing and notarising (Apple Developer Program, $99/year) removes that step.

## How it works

| Piece | Where |
| --- | --- |
| Pairing, groups, sending, receipts, schedules | `src/core/titli.js` (plain Node, tested) |
| Invite codes and key derivation | `src/core/codes.js` |
| Encryption (AES-256-GCM) | `src/core/seal.js` |
| Relay client (ntfy JSON stream, 12-hour catch-up) | `src/core/relay.js` |
| When a butterfly may land | `src/core/presence.js`, `src/main/delivery.js` |
| Camera / mic / full-screen checks | `native/mac/TitliPresence.swift` |
| Menu bar, panel, shortcut, notifications | `src/main/main.js` |
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
