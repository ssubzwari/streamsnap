/**
 * Theme system types.
 *
 * Backgrounds are split between Vanta.js (WebGL/three.js) effects and
 * custom canvas/CSS effects implemented in `./customEffects`.
 */

export type ThemeMode = "dark" | "light";

export type VantaEffectId =
  | "net"
  | "waves"
  | "cells"
  | "dots"
  | "rings";

export type CustomEffectId =
  | "aurora"
  | "starfield"
  | "grid-pulse"
  | "bubbles"
  | "matrix"
  | "plasma"
  | "mesh-gradient"
  | "constellation"
  | "neon-lines"
  | "snow";

export type BackgroundId = "none" | VantaEffectId | CustomEffectId;

export interface BackgroundOption {
  id: BackgroundId;
  label: string;
  group: "Off" | "Vanta" | "Custom";
}

export const BACKGROUND_OPTIONS: BackgroundOption[] = [
  { id: "none", label: "None", group: "Off" },

  // Vanta effects (WebGL)
  { id: "net", label: "Net", group: "Vanta" },
  { id: "waves", label: "Waves", group: "Vanta" },
  { id: "cells", label: "Cells", group: "Vanta" },
  { id: "dots", label: "Dots", group: "Vanta" },
  { id: "rings", label: "Rings", group: "Vanta" },

  // Custom effects (canvas / CSS)
  { id: "aurora", label: "Aurora", group: "Custom" },
  { id: "starfield", label: "Starfield", group: "Custom" },
  { id: "grid-pulse", label: "Grid Pulse", group: "Custom" },
  { id: "bubbles", label: "Bubbles", group: "Custom" },
  { id: "matrix", label: "Matrix Rain", group: "Custom" },
  { id: "plasma", label: "Plasma", group: "Custom" },
  { id: "mesh-gradient", label: "Mesh Gradient", group: "Custom" },
  { id: "constellation", label: "Constellation", group: "Custom" },
  { id: "neon-lines", label: "Neon Lines", group: "Custom" },
  { id: "snow", label: "Snow", group: "Custom" },
];

export interface ThemeState {
  mode: ThemeMode;
  background: BackgroundId;
}

export const DEFAULT_THEME: ThemeState = {
  mode: "dark",
  background: "net",
};
