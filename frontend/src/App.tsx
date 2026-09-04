import { useState, useCallback } from "react";

import Dashboard from "@/pages/Dashboard";
import Settings from "@/pages/Settings";
import ToastContainer from "@/components/Toast";
import Background from "@/theme/Background";
import { ThemeProvider } from "@/theme/ThemeContext";
import { UiPrefsProvider } from "@/ui/UiPrefsContext";

import styles from "./App.module.css";

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
            Stream<span className={styles.brandAccent}>Snap</span>
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
      </div>
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
      <ToastContainer />
      </UiPrefsProvider>
    </ThemeProvider>
  );
}
