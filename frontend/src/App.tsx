import { useState, useCallback } from "react";

import Dashboard from "@/pages/Dashboard";
import Settings from "@/pages/Settings";
import Footer from "@/components/Footer";
import ToastContainer from "@/components/Toast";
import Background from "@/theme/Background";
import { ThemeProvider } from "@/theme/ThemeContext";
import { UiPrefsProvider } from "@/ui/UiPrefsContext";

import styles from "./App.module.css";

// StreamSnap mark — a hex "aperture" ring around a play triangle. Ring picks
// up the theme accent; the triangle inherits the wordmark's text colour.
const LogoMark = () => (
  <svg
    width="19"
    height="19"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
    focusable="false"
  >
    <path
      d="M12 2.6 20.1 7.3V16.7L12 21.4 3.9 16.7V7.3Z"
      fill="none"
      stroke="var(--color-accent)"
      strokeWidth="2.1"
      strokeLinejoin="round"
    />
    <path d="M10 8.6 15.6 12 10 15.4Z" fill="currentColor" />
  </svg>
);

const GearIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeCount, setActiveCount] = useState(0);
  const [speed, setSpeed] = useState({ value: 0, unit: "MB/s" });

  const handleActiveCount = useCallback((count: number) => setActiveCount(count), []);
  const handleSpeedReport = useCallback((value: number, unit: string) => setSpeed({ value, unit }), []);

  return (
    <ThemeProvider>
      <UiPrefsProvider>
      <Background paused={settingsOpen} />
      <div className={styles.shell}>
        <nav className={styles.topNav}>
          <span className={styles.brand}>
            <LogoMark />
            <span>Stream<span className={styles.brandAccent}>Snap</span></span>
          </span>


          <div className={styles.navRight}>
            {activeCount > 0 && (
              <>
                <span className={styles.statBadge}>{activeCount} downloading</span>
                {speed.value > 0 && (
                  <span className={styles.statSpeed}>
                    {speed.value.toFixed(2)} {speed.unit}
                  </span>
                )}
              </>
            )}
            <button
              className={styles.settingsBtn}
              onClick={() => setSettingsOpen(true)}
              title="Settings"
            >
              <GearIcon />
            </button>
          </div>
        </nav>

        <Dashboard
          settingsOpen={settingsOpen}
          onCloseSettings={() => setSettingsOpen(false)}
          activeDownloadCount={handleActiveCount}
          totalSpeedReport={handleSpeedReport}
        />
        <Footer />
      </div>
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
      <ToastContainer />
      </UiPrefsProvider>
    </ThemeProvider>
  );
}
