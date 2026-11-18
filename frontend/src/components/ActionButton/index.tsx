import { useCallback, useEffect, useRef, useState } from "react";

import styles from "./ActionButton.module.css";

type Phase = "idle" | "busy" | "done" | "error";

interface Props {
  /** Runs on click. Return `false` to skip the success animation — use that
   *  when the click opened a dialog rather than finishing anything. */
  onAction: () => void | boolean | Promise<void | boolean>;
  children: React.ReactNode;
  /** Shown while the action is running. Falls back to the normal label. */
  busyLabel?: React.ReactNode;
  /** Shown briefly on success. Falls back to a tick alone. */
  doneLabel?: React.ReactNode;
  className?: string;
  disabled?: boolean;
  title?: string;
  /** How long the success state stays up. */
  doneMs?: number;
}

/** A button that reports the outcome of its own action, where the action was.
 *
 *  This is the replacement for a pop-up in the corner of the screen: the thing
 *  you clicked is the thing that tells you what happened, so there is nothing
 *  to read somewhere else and nothing to dismiss.
 */
export default function ActionButton({
  onAction,
  children,
  busyLabel,
  doneLabel,
  className = "",
  disabled,
  title,
  doneMs = 1600,
}: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const timer = useRef<number | undefined>(undefined);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      window.clearTimeout(timer.current);
    };
  }, []);

  const settle = useCallback(
    (next: Phase) => {
      if (!alive.current) return;
      setPhase(next);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        if (alive.current) setPhase("idle");
      }, doneMs);
    },
    [doneMs],
  );

  const run = async () => {
    if (phase === "busy") return;
    setPhase("busy");
    try {
      const result = await onAction();
      // `false` means "nothing finished" — e.g. a dialog opened instead.
      if (result === false) {
        if (alive.current) setPhase("idle");
        return;
      }
      settle("done");
    } catch {
      // The caller owns error reporting; this is only the visual cue.
      settle("error");
    }
  };

  return (
    <button
      type="button"
      className={`${className} ${styles.btn} ${styles[phase]}`.trim()}
      onClick={run}
      disabled={disabled || phase === "busy"}
      title={title}
      data-phase={phase}
    >
      <span className={styles.label}>
        {phase === "busy" ? busyLabel ?? children : phase === "done" ? doneLabel ?? children : children}
      </span>
      {phase === "busy" && <span className={styles.spinner} aria-hidden="true" />}
      {phase === "done" && (
        <svg className={styles.tick} viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 8.5l3.2 3.2L13 5" />
        </svg>
      )}
      {phase === "done" && <span className={styles.ring} aria-hidden="true" />}
    </button>
  );
}
