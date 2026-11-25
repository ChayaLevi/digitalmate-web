/**
 * Canonical JSON and the state hash used by the family board fixtures.
 *
 * Every client (TS here, Kotlin in HOPA's core/family, Python in HOPA's checker) must hash a state the
 * same way, so the rule is small and written down: object keys sorted by UTF-16 code units, no
 * whitespace, strings escaped as JSON.stringify does (`\"`, `\\`, `\b \f \n \r \t`, other control
 * characters as lowercase `\u00xx`, everything else as raw UTF-8), integers in plain decimal, absent
 * fields left out. Board states hold only strings, integers, booleans, null, arrays and objects. This is
 * RFC 8785 (JCS) restricted to those types. The hash is lowercase hex SHA-256 of the UTF-8 bytes.
 */
import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`only safe integers are allowed in a board state, got ${value}`);
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new Error(`cannot hash a ${typeof value}`);
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export const hashOf = (value: unknown): string => sha256Hex(canonicalJson(value));
