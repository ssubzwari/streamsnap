import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Per-browser UI preferences — which optional gadgets are shown and the order
 * of the dashboard's rearrangeable sections. Persisted to localStorage; never
 * sent to the server (single-user app, purely cosmetic).
 */

export type SectionId = "advanced" | "downloading" | "completed" | "subscriptions";

export const DEFAULT_SECTION_ORDER: SectionId[] = [
  "advanced",
  "downloading",
  "completed",
  "subscriptions",
];

interface UiPrefs {
  /** Show the collapsible download-activity / throughput meter. */
  statsMeter: boolean;
  /** Top-to-bottom order of the four rearrangeable dashboard sections. */
  sectionOrder: SectionId[];
}

const DEFAULTS: UiPrefs = {
  statsMeter: true,
  sectionOrder: DEFAULT_SECTION_ORDER,
};

const STORAGE_KEY = "streamsnap.ui.v1";

interface UiPrefsValue extends UiPrefs {
  setStatsMeter: (on: boolean) => void;
  moveSection: (id: SectionId, dir: -1 | 1) => void;
  resetSectionOrder: () => void;
}

const Ctx = createContext<UiPrefsValue | null>(null);

/** Keep only known ids, de-duplicated, and append any that are missing so a
 *  future new section still appears even with a stale stored order. */
function sanitizeOrder(raw: unknown): SectionId[] {
  const seen = new Set<SectionId>();
  const out: SectionId[] = [];
  if (Array.isArray(raw)) {
    for (const v of raw) {
      if (DEFAULT_SECTION_ORDER.includes(v as SectionId) && !seen.has(v as SectionId)) {
        seen.add(v as SectionId);
        out.push(v as SectionId);
      }
    }
  }
  for (const id of DEFAULT_SECTION_ORDER) if (!seen.has(id)) out.push(id);
  return out;
}

function read(): UiPrefs {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw) as Partial<UiPrefs>;
    return {
      statsMeter: typeof p.statsMeter === "boolean" ? p.statsMeter : DEFAULTS.statsMeter,
      sectionOrder: sanitizeOrder(p.sectionOrder),
    };
  } catch {
    return DEFAULTS;
  }
}

export function UiPrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<UiPrefs>(() => read());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      /* quota / private mode — silent */
    }
  }, [prefs]);

  const setStatsMeter = useCallback(
    (statsMeter: boolean) => setPrefs((p) => ({ ...p, statsMeter })),
    [],
  );

  const resetSectionOrder = useCallback(
    () => setPrefs((p) => ({ ...p, sectionOrder: [...DEFAULT_SECTION_ORDER] })),
    [],
  );

  const moveSection = useCallback((id: SectionId, dir: -1 | 1) => {
    setPrefs((p) => {
      const order = [...p.sectionOrder];
      const i = order.indexOf(id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= order.length) return p;
      [order[i], order[j]] = [order[j], order[i]];
      return { ...p, sectionOrder: order };
    });
  }, []);

  const value = useMemo<UiPrefsValue>(
    () => ({ ...prefs, setStatsMeter, moveSection, resetSectionOrder }),
    [prefs, setStatsMeter, moveSection, resetSectionOrder],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUiPrefs(): UiPrefsValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useUiPrefs must be used within <UiPrefsProvider>");
  return v;
}
