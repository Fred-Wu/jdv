export function assert(
  value: unknown,
  message = "Assertion failed.",
): asserts value {
  if (!value) throw new Error(message);
}

export function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`,
    );
  }
}

export function assertStringIncludes(actual: string, expected: string): void {
  if (!actual.includes(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(actual)} to include ${
        JSON.stringify(expected)
      }.`,
    );
  }
}
