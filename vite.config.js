import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

/**
 * Serves the /api functions during `npm run dev`.
 *
 * Vercel runs everything under api/ as a serverless function in
 * production, but Vite's dev server knows nothing about them — without
 * this, Ask Tim works on the deployed site and 404s locally, which is a
 * miserable way to find out something is broken.
 *
 * Dev only: `apply: "serve"` keeps it out of the production build.
 */
function devApi() {
  return {
    name: "dev-api",
    apply: "serve",
    configureServer(server) {
      // Vite only exposes VITE_-prefixed vars, and only to client code.
      // The api/ handlers read process.env like they do on Vercel, so the
      // unprefixed ones have to be put there by hand — otherwise Tim
      // reports a missing key locally while working fine in production.
      Object.assign(process.env,
        // server.config.root, not process.cwd(): the dev server can be
        // launched from the repo root, and .env lives beside this config.
        loadEnv(server.config.mode, server.config.root, ""));

      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith("/api/")) return next();
        const name = req.url.split("?")[0].replace("/api/", "");
        try {
          const mod = await server.ssrLoadModule(`/api/${name}.js`);
          // Give the handler the Express-ish shape Vercel provides.
          res.status = (code) => { res.statusCode = code; return res; };
          res.json = (obj) => {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(obj));
            return res;
          };
          await mod.default(req, res);
        } catch (e) {
          server.config.logger.error(`dev-api /api/${name}: ${e.stack || e}`);
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "Dev API route failed — see the terminal." }));
        }
      });
    },
  };
}

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
    devApi(),
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: false, // we register manually in main.jsx to force a reload on update
      includeAssets: ["icons/favicon-32.png", "icons/apple-touch-icon.png"],
      manifest: false, // we ship public/manifest.webmanifest directly
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,svg,woff2}"],
        navigateFallback: "/index.html",
        cleanupOutdatedCaches: true,   // deletes stale caches left by previous deploys
        clientsClaim: true,            // new service worker takes control immediately
        skipWaiting: true,             // don't wait for old tabs to close before activating
      },
      devOptions: { enabled: true },
    }),
  ],
  server: { host: true, port: 5173 },
});
