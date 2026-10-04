import { inputError } from "./errors.js";

/**
 * Stream's MongoDB-style query filters, evaluated against a flat document.
 *
 * Equality is type-sensitive, as in Stream: a custom field stored as the string "42"
 * does not match the number 42. A document field that holds an array (channel
 * `members`, user `teams`) matches a scalar when it contains it.
 */
export type FilterDocument = Record<string, unknown>;

const LOGICAL = new Set(["$and", "$or", "$nor"]);

export function matchesFilter(doc: FilterDocument, filter: unknown): boolean {
  if (filter === undefined || filter === null) return true;
  if (typeof filter !== "object" || Array.isArray(filter)) throw inputError("filter_conditions must be an object");

  for (const [key, condition] of Object.entries(filter as Record<string, unknown>)) {
    if (LOGICAL.has(key)) {
      if (!Array.isArray(condition)) throw inputError(`${key} expects an array of filters`);
      const results = condition.map((sub) => matchesFilter(doc, sub));
      if (key === "$and" && !results.every(Boolean)) return false;
      if (key === "$or" && !results.some(Boolean)) return false;
      if (key === "$nor" && results.some(Boolean)) return false;
      continue;
    }
    if (key.startsWith("$")) throw inputError(`unsupported filter operator ${key}`);
    if (!matchesField(doc[key], condition)) return false;
  }
  return true;
}

function isOperatorObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key.startsWith("$"));
}

function matchesField(actual: unknown, condition: unknown): boolean {
  if (!isOperatorObject(condition)) return equals(actual, condition);
  for (const [op, expected] of Object.entries(condition)) {
    if (!applyOperator(op, actual, expected)) return false;
  }
  return true;
}

function applyOperator(op: string, actual: unknown, expected: unknown): boolean {
  switch (op) {
    case "$eq":
      return equals(actual, expected);
    case "$ne":
      return !equals(actual, expected);
    case "$in":
      return asArray(op, expected).some((value) => equals(actual, value));
    case "$nin":
      return !asArray(op, expected).some((value) => equals(actual, value));
    case "$exists":
      return (actual !== undefined && actual !== null) === Boolean(expected);
    case "$gt":
      return compare(actual, expected, (n) => n > 0);
    case "$gte":
      return compare(actual, expected, (n) => n >= 0);
    case "$lt":
      return compare(actual, expected, (n) => n < 0);
    case "$lte":
      return compare(actual, expected, (n) => n <= 0);
    case "$contains":
      return Array.isArray(actual) && actual.some((value) => equals(value, expected));
    case "$autocomplete": {
      if (typeof actual !== "string" || typeof expected !== "string") return false;
      const needle = expected.trim().toLowerCase();
      if (!needle) return true;
      return actual
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .some((word) => word.startsWith(needle));
    }
    case "$q":
      return (
        typeof actual === "string" &&
        typeof expected === "string" &&
        actual.toLowerCase().includes(expected.toLowerCase())
      );
    default:
      throw inputError(`unsupported filter operator ${op}`);
  }
}

function asArray(op: string, value: unknown): unknown[] {
  if (!Array.isArray(value)) throw inputError(`${op} expects an array`);
  return value;
}

function equals(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual)) {
    if (Array.isArray(expected)) {
      return actual.length === expected.length && expected.every((value) => actual.some((item) => equals(item, value)));
    }
    return actual.some((item) => equals(item, expected));
  }
  if (actual === expected) return true;
  if (actual && expected && typeof actual === "object" && typeof expected === "object") {
    return JSON.stringify(actual) === JSON.stringify(expected);
  }
  return false;
}

function compare(actual: unknown, expected: unknown, test: (difference: number) => boolean): boolean {
  if (typeof actual === "number" && typeof expected === "number") return test(actual - expected);
  if (typeof actual === "string" && typeof expected === "string") {
    const left = Date.parse(actual);
    const right = Date.parse(expected);
    if (!Number.isNaN(left) && !Number.isNaN(right)) return test(left - right);
    return test(actual < expected ? -1 : actual > expected ? 1 : 0);
  }
  return false;
}

export interface SortField {
  field: string;
  direction: number;
}

/** Stream sends sort as `[{ field, direction }]`; older clients send `{ field: direction }`. */
export function normalizeSort(sort: unknown): SortField[] {
  if (!sort) return [];
  if (Array.isArray(sort)) {
    return sort.flatMap((entry) => {
      if (entry && typeof entry === "object" && "field" in entry) {
        const { field, direction } = entry as { field: unknown; direction?: unknown };
        if (typeof field === "string") return [{ field, direction: Number(direction ?? 1) < 0 ? -1 : 1 }];
      }
      if (entry && typeof entry === "object") return normalizeSort(entry);
      return [];
    });
  }
  if (typeof sort === "object") {
    return Object.entries(sort as Record<string, unknown>).map(([field, direction]) => ({
      field,
      direction: Number(direction) < 0 ? -1 : 1,
    }));
  }
  return [];
}

export function compareBySort(a: FilterDocument, b: FilterDocument, sort: SortField[]): number {
  for (const { field, direction } of sort) {
    const left = sortValue(a[field]);
    const right = sortValue(b[field]);
    if (left === right) continue;
    // Stream places documents missing the sort field last, whatever the direction.
    if (left === null) return 1;
    if (right === null) return -1;
    return (left < right ? -1 : 1) * direction;
  }
  return 0;
}

function sortValue(value: unknown): number | string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(parsed) ? parsed : value;
  }
  return JSON.stringify(value);
}
