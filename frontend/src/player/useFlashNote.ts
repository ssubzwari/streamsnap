import { useCallback, useEffect, useRef, useState } from "react";

const NOTE_MS = 4000;

/** A short confirmation message that clears itself after a few seconds; `flash` replaces any current one. */
export function useFlashNote(): [string | null, (text: string) => void] {
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const flash = useCallback((text: string) => {
    window.clearTimeout(timer.current);
    setNote(text);
    timer.current = window.setTimeout(() => setNote(null), NOTE_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return [note, flash];
}

export const addedNote = (n: number): string => `Added ${n} to playlist`;
