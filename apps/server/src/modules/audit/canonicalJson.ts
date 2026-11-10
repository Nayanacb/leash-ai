/**
 * Deterministic JSON serialization: object keys sorted recursively, no
 * whitespace. Postgres `jsonb` does not preserve key order, so hashes must be
 * computed over a canonical form to be reproducible after a round trip.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}
