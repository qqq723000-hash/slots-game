import type { SymbolId } from "../app/state/types";

export const LOGICAL_WIDTH = 1280;
export const LOGICAL_HEIGHT = 720;

export const COLORS = {
  ink: 0x0b0a09,
  panel: 0x1d1a16,
  cyan: 0xff9b36,
  violet: 0xa73624,
  lime: 0xd8c58f,
  amber: 0xffbd55,
  rose: 0xff5a2f,
  white: 0xf3e8d0,
} as const;

export interface SymbolPalette {
  primary: number;
  secondary: number;
  glow: number;
}

export const SYMBOL_PALETTES: Record<SymbolId, SymbolPalette> = {
  ORBIT: { primary: 0xe8d19c, secondary: 0x7a6542, glow: 0xffa33c },
  PRISM: { primary: 0xd6c08f, secondary: 0x66573c, glow: 0xf09a38 },
  PULSE: { primary: 0xc8b888, secondary: 0x62583e, glow: 0xe58a31 },
  NOVA: { primary: 0xb9ad89, secondary: 0x565347, glow: 0xd9762c },
  CIRCUIT: { primary: 0xd8c599, secondary: 0x657078, glow: 0xff9c37 },
  TANK: { primary: 0x87927d, secondary: 0x373f34, glow: 0xe06b2b },
  WILD: { primary: 0xffecd0, secondary: 0xc64524, glow: 0xff7a2d },
  VAULT: { primary: 0xd6c28e, secondary: 0x6d735f, glow: 0xffae42 },
  SURGE: { primary: 0xffd089, secondary: 0xb52f1f, glow: 0xff5727 },
};
