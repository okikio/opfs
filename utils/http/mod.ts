/**
 * Framework-neutral HTTP protocol utilities.
 *
 * This package owns wire parsing, cookie contracts, successful response
 * representations, and RFC 9457 problem representations. It does not own
 * endpoint routing, middleware execution, service composition, or a server
 * framework. Those concerns belong to `@utils/server`.
 */
export * as cookie from './cookie/mod.ts';
export * as problem from './problem/mod.ts';
export * as request from './request/mod.ts';
export * as response from './response/mod.ts';
