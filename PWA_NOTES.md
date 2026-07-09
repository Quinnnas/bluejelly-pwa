# PWA notes — what to expect on iOS vs Android

Quick reference for what actually works once BlueJelly is installed as a
home-screen app, so there are no surprises when the team starts using it.

## Android (Chrome)
- Install prompt appears automatically on first visit (or via menu → Add to
  Home screen).
- Opens full-screen, own icon, shows up in the app switcher like any app.
- Push notifications work directly, no extra steps.
- Offline: the app shell (layout, styles) loads instantly from cache even
  with no signal; live data still needs a connection.

## iOS (Safari)
- **Must be installed via Safari specifically.** Chrome/Firefox on iOS are
  required by Apple to use Safari's engine underneath, but the "Add to Home
  Screen" action only appears in Safari's own share sheet.
- No automatic install prompt — walk each person through it once:
  Safari → Share icon → **Add to Home Screen**.
- Once installed, it opens full-screen with the BlueJelly icon, no browser
  address bar — looks and feels like a real app.
- **Push notifications work, but only for the installed home-screen version**
  — a Safari tab can never receive them, and the person must grant
  notification permission the first time the app asks.
- iOS can occasionally clear cached data if the app goes unused for a long
  stretch — not a bug, just how Apple manages storage. Reopening and
  reloading fixes it.
- Not listed in the App Store — people only get it via a link you send them
  (or a QR code, which is a nice option for onboarding new team members).

## Why this is fine for BlueJelly specifically
This isn't a public consumer app where losing the install-prompt-on-first-
visit convenience matters — it's an internal tool for a small, known team.
Showing everyone the "Add to Home Screen" step once, in person or over a
quick message, closes the entire gap. Once installed, the day-to-day
experience is effectively identical to a native app.

## When to move to a real App Store / Play Store listing
Worth doing once the app is stable and proven, via Capacitor (see README).
Reasons to prioritise it:
- Real native push (more reliable delivery than Safari's web push)
- No manual "Add to Home Screen" step for new teammates
- A searchable, professional store presence if that ever matters
Costs: Apple $99/year, Google $25 once — both cover unlimited updates.
