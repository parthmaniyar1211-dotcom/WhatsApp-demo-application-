// Brand identity. Everything here is a PROVISIONAL default and configurable at build time
// (VITE_BRAND_* in web/.env or the build environment), so the name, package id and colours can change
// without touching any component. The Android package id is read by the Capacitor setup in a later phase;
// it lives here so there is a single place to change it.
//
// Original branding only: no WhatsApp name, logo or colours are used to claim an official app.

const env = import.meta.env;

export interface Brand {
  /** Product name shown on the login screen, the browser tab and the app. */
  name: string;
  /** Company that owns the platform. */
  company: string;
  /** Android application id (used from the Android phase). */
  packageId: string;
  tagline: string;
  /** Optional accent colour override (any CSS colour). Empty keeps the theme's green. */
  accent: string;
  /** Optional dark surface override for the charcoal background. Empty keeps the theme default. */
  charcoal: string;
}

export const brand: Brand = {
  name: clean(env.VITE_BRAND_NAME, "CosmiConnect"),
  company: clean(env.VITE_BRAND_COMPANY, "CosmiChameleon"),
  packageId: clean(env.VITE_BRAND_PACKAGE_ID, "io.cosmichameleon.cosmiconnect"),
  tagline: clean(env.VITE_BRAND_TAGLINE, "Business messaging for your team"),
  accent: clean(env.VITE_BRAND_ACCENT, ""),
  charcoal: clean(env.VITE_BRAND_CHARCOAL, ""),
};

function clean(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/** Applies the brand to the page (title and optional colour overrides). Called once at start-up. */
export function applyBrand(): void {
  document.title = brand.name;
  const root = document.documentElement.style;
  if (brand.accent) {
    root.setProperty("--green", brand.accent);
    root.setProperty("--green-dark", brand.accent);
  }
  if (brand.charcoal) root.setProperty("--brand-charcoal", brand.charcoal);
}
