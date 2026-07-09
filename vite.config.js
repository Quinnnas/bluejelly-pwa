import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// PWA setup notes:
// - `registerType: "autoUpdate"` means a new deploy is picked up automatically
//   on next app open — no store review, no manual update step for users.
// - `workbox` config below caches the app shell so it opens instantly and
//   works offline for anything already loaded; live data (sales, orders)
//   still needs a network call to Supabase/Takealot, same as any app.
// - iOS note: push notifications and "add to home screen" behaviour are
//   controlled by Safari, not by this config — see the PWA_NOTES.md file
//   for the iOS install flow to walk users through once.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/favicon-32.png", "icons/apple-touch-icon.png"],
      manifest: false, // we ship public/manifest.webmanifest directly
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,svg,woff2}"],
        navigateFallback: "/index.html",
      },
      devOptions: { enabled: true },
    }),
  ],
  server: { host: true, port: 5173 },
});
