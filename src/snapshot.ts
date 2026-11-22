// A deep copy with JSON semantics, so it holds what a saved trace or recording will hold.
export const snapshot = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
