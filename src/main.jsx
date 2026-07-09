import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App.jsx";

// Forces every deploy to actually reach installed home-screen apps, instead
// of a new service worker sitting activated-but-unused in the background
// (the exact problem that made the scroll-lock fix look like it "didn't
// apply" on a phone that had already installed an earlier version).
if ("serviceWorker" in navigator) {
  import("virtual:pwa-register").then(({ registerSW }) => {
    registerSW({
      immediate: true,
      onNeedRefresh() {
        window.location.reload();
      },
    });
  });
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
