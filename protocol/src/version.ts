/**
 * Protocol version. Every message on the wire carries this number.
 *
 * Bump PROTOCOL_VERSION when the wire format changes in a way old code can't read.
 * Raise MIN_SUPPORTED_VERSION when we stop accepting an old format.
 * The receiver rejects anything outside [MIN_SUPPORTED_VERSION, PROTOCOL_VERSION]
 * cleanly instead of guessing (plan.md §17).
 */
export const PROTOCOL_VERSION = 1;
export const MIN_SUPPORTED_VERSION = 1;

export function isCompatible(version: number): boolean {
  return (
    Number.isInteger(version) &&
    version >= MIN_SUPPORTED_VERSION &&
    version <= PROTOCOL_VERSION
  );
}
