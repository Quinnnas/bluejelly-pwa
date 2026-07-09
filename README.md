# BlueJelly — PWA

A Progressive Web App shell for the BlueJelly Takealot seller dashboard.
`src/App.jsx` is the actual app (dashboard, orders, offers, automations,
settings, login) — everything else in this project exists to make it
installable on a phone as a real app icon, with offline app-shell caching
and update-on-open behaviour.

## Run it locally

```bash
npm install
npm run dev
```

Opens at `http://localhost:5173`. On your phone, use your computer's local
network IP instead of `localhost` (e.g. `http://192.168.1.23:5173`) so you
can open it on the same Wi-Fi and test "Add to Home Screen" for real.

## Build for deployment

```bash
npm run build
```

Outputs a static `dist/` folder — plain HTML/CSS/JS plus the generated
service worker and manifest. This can be hosted on **any** static host:
Vercel, Netlify, Cloudflare Pages, GitHub Pages, or a Supabase Storage
bucket with a custom domain. No server required for the frontend itself.

**Requirement: HTTPS.** PWAs (service workers, install prompts, push) only
work over HTTPS. Every host listed above provides this automatically.

## Installing on a phone

**Android (Chrome):** open the site → Chrome shows an "Add BlueJelly to
Home screen" prompt automatically, or use the menu → *Add to Home screen*.

**iOS (Safari only — Chrome/Firefox on iOS can't do this, it's an Apple
restriction):** open the site in Safari → tap the Share icon → *Add to
Home Screen*. There's no automatic prompt on iOS; walk each teammate
through this once. After that it behaves like a normal app icon, including
notifications (see PWA_NOTES.md for exact iOS behaviour and limits).

## What's wired vs. still a placeholder

This is the frontend only. It currently runs on realistic sample data.
Before this is truly "live":
- Swap the hardcoded data (`ROWS`, `SERIES`, `REPORT_DEFS`, `BUYBOX`, `ORDERS`,
  `OFFERS`) for real calls to Supabase / the Takealot API.
- Move `APPROVED_EMAILS`, `USER_PROFILES`, and `SHARED_AUTOS` (currently
  in-memory arrays that reset on page reload) into real Supabase tables.
- See `DATA_CONTRACT.md` for the full screen-by-screen source-of-truth map.

## Later: native app store listing

This same codebase wraps into a real iOS/Android app later via
[Capacitor](https://capacitorjs.com) with minimal changes — see the
"App delivery" notes from planning. Nothing here needs to be rebuilt for
that step; Capacitor packages this same `dist/` build.
