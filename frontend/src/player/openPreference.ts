import { useCallback, useEffect, useState } from "react";

export type OpenIn = "player" | "tab";

const KEY = "streamsnap.openIn.v1";
const EVENT = "streamsnap:openin";

export function getOpenIn(): OpenIn {
  try {
    return localStorage.getItem(KEY) === "tab" ? "tab" : "player";
  } catch {
    return "player";
  }
}

export function setOpenIn(v: OpenIn): void {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    // Storage unavailable: the event below still updates this session.
  }
  window.dispatchEvent(new Event(EVENT));
}

/** Current preference, kept in sync across components. */
export function useOpenIn(): [OpenIn, (v: OpenIn) => void] {
  const [value, setValue] = useState<OpenIn>(getOpenIn);
  useEffect(() => {
    const sync = () => setValue(getOpenIn());
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, []);
  const set = useCallback((v: OpenIn) => setOpenIn(v), []);
  return [value, set];
}
