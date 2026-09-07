import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import "./styles/global.css";

// One-time rebrand migration: carry any `metubeplus.*` browser prefs over to
// the `streamsnap.*` namespace so themes / layout survive the rename. The old
// keys are left in place (harmless) as a safety net.
try {
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith("metubeplus.")) continue;
    const next = `streamsnap.${key.slice("metubeplus.".length)}`;
    if (localStorage.getItem(next) === null) {
      localStorage.setItem(next, localStorage.getItem(key) ?? "");
    }
  }
} catch {
  /* private mode / disabled storage — ignore */
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
