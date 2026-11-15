// Round avatar with the first letter (or a person icon for numbers), coloured by a stable hash.

import { Icon } from "./Icons";

const COLOURS = ["#6a7175", "#2f7d6d", "#4d6d9a", "#8a5a9e", "#a1623a", "#3a8a9e", "#9a4d62", "#6d8a3a"];

export function Avatar({ name, seed, size = 49 }: { name: string; seed?: string; size?: number }) {
  const letter = name.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 1).toUpperCase();
  const key = seed ?? name;
  let hash = 0;
  for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const startsWithDigit = /^[\d+]/.test(name.trim());
  return (
    <span className="avatar" style={{ width: size, height: size, background: COLOURS[hash % COLOURS.length] }} aria-hidden="true">
      {letter && !startsWithDigit ? letter : <Icon name="contact" size={Math.round(size * 0.6)} />}
    </span>
  );
}
