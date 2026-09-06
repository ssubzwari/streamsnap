import { useEffect, useRef } from "react";

import { useTheme } from "./ThemeContext";
import {
  setEffectsPaused,
  startCustomEffect,
  type CustomEffectHandle,
} from "./customEffects";
import type { CustomEffectId, ThemeMode, VantaEffectId } from "./types";

import styles from "./Background.module.css";

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// three.js (~150kB gzip) and the Vanta effect modules are loaded on demand —
// only when a WebGL background is actually selected. Users on "None" or a
// lightweight canvas effect never pay for them.
type VantaFactory = (opts: Record<string, unknown>) => { destroy: () => void };

const loadThree = () => import("three").then((m) => (m as { default?: unknown }).default ?? m);

const VANTA_LOADERS: Record<VantaEffectId, () => Promise<VantaFactory>> = {
  // @ts-expect-error vanta has no types
  net: () => import("vanta/dist/vanta.net.min").then((m) => m.default),
  // @ts-expect-error vanta has no types
  waves: () => import("vanta/dist/vanta.waves.min").then((m) => m.default),
  // @ts-expect-error vanta has no types
  cells: () => import("vanta/dist/vanta.cells.min").then((m) => m.default),
  // @ts-expect-error vanta has no types
  dots: () => import("vanta/dist/vanta.dots.min").then((m) => m.default),
  // @ts-expect-error vanta has no types
  rings: () => import("vanta/dist/vanta.rings.min").then((m) => m.default),
};

function vantaOptions(id: VantaEffectId, mode: ThemeMode, THREE: unknown) {
  const dark = mode === "dark";
  const bg = dark ? 0x0a0a0b : 0xf5f5f9;
  const accent = dark ? 0x7c5cff : 0x5a3fff;
  const common = {
    THREE,
    // Pointer tracking forces Vanta to recompute geometry on every mouse
    // move — a real source of interaction jank for a background. Ambient
    // motion alone looks fine.
    mouseControls: false,
    touchControls: false,
    gyroControls: false,
    minHeight: 200.0,
    minWidth: 200.0,
    scale: 1.0,
    scaleMobile: 1.0,
  };
  switch (id) {
    case "net":
      return {
        ...common,
        color: accent,
        backgroundColor: bg,
        points: 9.0,
        maxDistance: 20.0,
        spacing: 18.0,
        showDots: true,
      };
    case "waves":
      return {
        ...common,
        color: dark ? 0x1a2a4a : 0x9bb5ff,
        shininess: 50,
        waveHeight: 14,
        waveSpeed: 0.7,
        zoom: 0.85,
      };
    case "cells":
      return {
        ...common,
        color1: dark ? 0x1a153c : 0xc4cdff,
        color2: accent,
        size: 1.5,
        speed: 1.2,
      };
    case "dots":
      return {
        ...common,
        color: accent,
        color2: dark ? 0xa78bfa : 0x7c5cff,
        backgroundColor: bg,
        size: 3.5,
        spacing: 30,
      };
    case "rings":
      return {
        ...common,
        color: accent,
        backgroundColor: bg,
      };
  }
}

const VANTA_IDS = ["net", "waves", "cells", "dots", "rings"];

interface BackgroundProps {
  /** True while the app is obscured (e.g. the Settings modal is open). */
  paused?: boolean;
}

export default function Background({ paused = false }: BackgroundProps) {
  const { mode, background } = useTheme();
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const isVanta = VANTA_IDS.includes(background);
  const reduced = prefersReducedMotion();

  // Pause / resume the shared canvas-effect driver while the app is obscured.
  useEffect(() => {
    setEffectsPaused(paused);
    return () => setEffectsPaused(false);
  }, [paused]);

  // ── Canvas ("custom") effects ──────────────────────────────────────────
  // The driver handles visibility + pause, so this only needs to react to
  // the chosen effect and theme.
  useEffect(() => {
    if (background === "none" || isVanta || !canvasRef.current) return;
    const handle: CustomEffectHandle = startCustomEffect(
      background as CustomEffectId,
      canvasRef.current,
      mode,
    );
    return () => handle.destroy();
  }, [background, mode, isVanta]);

  // ── Vanta (WebGL / three.js) effects ───────────────────────────────────
  // three.js has no cheap pause, so we simply don't mount an instance we
  // can't see (obscured) or shouldn't run (reduced motion).
  useEffect(() => {
    if (background === "none" || !isVanta) return;
    if (paused || reduced) return;

    let disposed = false;
    let vantaInstance: { destroy: () => void } | null = null;

    Promise.all([
      loadThree(),
      VANTA_LOADERS[background as VantaEffectId](),
    ]).then(([THREE, factory]) => {
      if (disposed || !hostRef.current) return;
      vantaInstance = factory({
        el: hostRef.current,
        ...vantaOptions(background as VantaEffectId, mode, THREE),
      });
    });

    return () => {
      disposed = true;
      vantaInstance?.destroy();
      // Vanta leaves its <canvas> behind on .destroy() in some versions —
      // strip any extra children so the next effect mounts cleanly.
      hostRef.current
        ?.querySelectorAll("canvas.vanta-canvas")
        .forEach((n) => n.remove());
    };
  }, [background, mode, isVanta, paused, reduced]);

  if (background === "none") return null;

  return (
    <div ref={hostRef} className={styles.host} aria-hidden="true">
      {!isVanta && <canvas ref={canvasRef} className={styles.canvas} />}
    </div>
  );
}
