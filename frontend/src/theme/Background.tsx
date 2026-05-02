import { useEffect, useRef } from "react";
import * as THREE from "three";

import { useTheme } from "./ThemeContext";
import { startCustomEffect, type CustomEffectHandle } from "./customEffects";
import type { CustomEffectId, ThemeMode, VantaEffectId } from "./types";

import styles from "./Background.module.css";

// Vanta effect modules (lazy-imported on demand to avoid loading all of
// three.js up-front for users who pick a custom effect or "none").
type VantaFactory = (opts: Record<string, unknown>) => { destroy: () => void };

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

function vantaOptions(id: VantaEffectId, mode: ThemeMode) {
  const dark = mode === "dark";
  const bg = dark ? 0x0a0a0b : 0xf5f5f9;
  const accent = dark ? 0x7c5cff : 0x5a3fff;
  const common = {
    THREE,
    mouseControls: true,
    touchControls: true,
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
        points: 12.0,
        maxDistance: 22.0,
        spacing: 17.0,
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

export default function Background() {
  const { mode, background } = useTheme();
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Vanta needs a plain element to mount on; we give it the host div.
  // Custom effects draw to the canvas directly.
  useEffect(() => {
    if (background === "none") return;

    let disposed = false;
    let vantaInstance: { destroy: () => void } | null = null;
    let customHandle: CustomEffectHandle | null = null;

    const isVanta = ["net", "waves", "cells", "dots", "rings"].includes(background);

    if (isVanta && hostRef.current) {
      VANTA_LOADERS[background as VantaEffectId]().then((factory) => {
        if (disposed || !hostRef.current) return;
        vantaInstance = factory({
          el: hostRef.current,
          ...vantaOptions(background as VantaEffectId, mode),
        });
      });
    } else if (canvasRef.current) {
      customHandle = startCustomEffect(
        background as CustomEffectId,
        canvasRef.current,
        mode,
      );
    }

    return () => {
      disposed = true;
      vantaInstance?.destroy();
      customHandle?.destroy();
      // Vanta leaves its <canvas> behind on .destroy() in some versions —
      // strip any extra children so the next effect mounts cleanly.
      if (hostRef.current) {
        hostRef.current
          .querySelectorAll("canvas.vanta-canvas")
          .forEach((n) => n.remove());
      }
    };
  }, [background, mode]);

  if (background === "none") return null;

  const isVanta = ["net", "waves", "cells", "dots", "rings"].includes(background);

  return (
    <div ref={hostRef} className={styles.host} aria-hidden="true">
      {!isVanta && <canvas ref={canvasRef} className={styles.canvas} />}
    </div>
  );
}
