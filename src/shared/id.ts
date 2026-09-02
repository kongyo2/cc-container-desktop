/**
 * Identifier for a config row the user just created. Rows only ever have to be
 * distinct within one config file, so the clock plus a little randomness is
 * enough, and the prefix keeps the ids readable when the file is opened by hand.
 */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}
