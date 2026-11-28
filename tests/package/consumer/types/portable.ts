/** Compile-only installed root contracts; never execute these expressions. */
export {};

// @ts-expect-error Portable root declarations must not load the native Deno namespace.
void Deno;
