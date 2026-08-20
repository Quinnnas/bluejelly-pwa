import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App.jsx";

// Getting a deploy through to an installed home-screen app.
//
// The previous version relied on `onNeedRefresh`, but that callback only
// fires when registerType is "prompt". We use "autoUpdate", where the new
// service worker installs and claims control silently — while the page
// that is already open carries on running the JavaScript it booted with.
// Nothing reloaded, so a phone kept showing the old app until it happened
// to be fully closed and reopened.
//
// `controllerchange` is the event that actually means "the cached assets
// under you have just changed", so that is what we reload on.
if ("serviceWorker" in navigator) {
  // Captured before registering: on a FIRST install there is no previous
  // controller, and controllerchange fires anyway. Reloading then would
  // be a pointless refresh on someone's first ever visit.
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    reloading = true;
    window.location.reload();
  });

  import("virtual:pwa-register").then(({ registerSW }) => {
    registerSW({
      immediate: true,
      onRegisteredSW(_swUrl, registration) {
        if (!registration) return;
        // An installed app is usually resumed rather than launched, so
        // waking from the background is the moment most likely to need a
        // fresh check. The interval covers a dashboard left open all day.
        const checkForUpdate = () => {
          if (document.visibilityState === "visible") registration.update();
        };
        document.addEventListener("visibilitychange", checkForUpdate);
        setInterval(checkForUpdate, 5 * 60 * 1000);
      },
    });
  });
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
