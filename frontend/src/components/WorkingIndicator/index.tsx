import { useEffect, useRef, useState } from "react";

import styles from "./WorkingIndicator.module.css";

/** Honest status lines and genuinely true tips, cycled while a slow job runs.
 *
 *  Nothing here claims progress it cannot measure: reading a playlist gives no
 *  percentage until it is done, so inventing a bar would be a lie. What the
 *  user needs to know is that work is still happening and roughly why it is
 *  slow — plus something worth reading while they wait.
 */
const PLAYLIST_MESSAGES = [
  "Reading the playlist…",
  "Asking the site for every video in it…",
  "Large channels can take a minute.",
  "Nothing is queued yet — you get to review the list first.",
  "Collecting titles and durations…",
  "Tip: a playlist is tagged as one album, so Plex won't split it into one album per track.",
  "Still going — long channels can run to thousands of videos.",
  "Tip: if the site asks for sign-in, StreamSnap skips that video and carries on.",
  "Tip: FLAC from YouTube is repackaged Opus — larger, not better quality.",
  "Tip: Settings → Auth can borrow cookies from your browser for members-only videos.",
  "Almost there — building the review list…",
];

interface Props {
  /** Lines to cycle through. Defaults to the playlist set. */
  messages?: string[];
  /** How long each line stays up. */
  intervalMs?: number;
  /** Short label for screen readers, e.g. "Reading playlist". */
  label?: string;
}

function useElapsed(): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const id = window.setInterval(
      () => setSeconds(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => window.clearInterval(id);
  }, []);
  return seconds;
}

/** An equaliser-style "still working" indicator with rotating status lines.
 *
 *  Mount it only while the work is running — it starts its own timers on mount
 *  and clears them on unmount.
 */
export default function WorkingIndicator({
  messages = PLAYLIST_MESSAGES,
  intervalMs = 3200,
  label = "Working",
}: Props) {
  const [index, setIndex] = useState(0);
  const elapsed = useElapsed();
  const count = messages.length;
  const lastIndex = useRef(0);

  useEffect(() => {
    if (count <= 1) return;
    const id = window.setInterval(() => {
      setIndex((i) => {
        lastIndex.current = i;
        return (i + 1) % count;
      });
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [count, intervalMs]);

  return (
    <div className={styles.wrap} role="status" aria-live="polite" aria-label={label}>
      <span className={styles.bars} aria-hidden="true">
        <i /><i /><i /><i /><i />
      </span>
      <span className={styles.text}>
        {/* keyed so each line re-runs the fade-in */}
        <span key={index} className={styles.line}>
          {messages[index]}
        </span>
      </span>
      {elapsed >= 5 && (
        <span className={styles.elapsed} aria-hidden="true">
          {elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`}
        </span>
      )}
    </div>
  );
}
