/** Flags are copied from the flag-icons package into public/flags at build time. */
export function flagUrl(a2: string): string {
  return `${import.meta.env.BASE_URL}flags/${a2}.svg`;
}
