import type { EnvironmentIssue } from './types.ts';

/**
 * Error raised when environment composition or validation fails.
 *
 * The message includes one line per issue for logs and startup diagnostics.
 * `issues` retains the same failures as structured data so callers do not need
 * to parse that message when presenting or classifying configuration errors.
 */
export class EnvironmentError extends Error {
	override readonly name = 'EnvironmentError';
	/** Normalized field and composition failures associated with this error. */
	readonly issues: readonly EnvironmentIssue[];

	constructor(message: string, issues: readonly EnvironmentIssue[]) {
		const details = issues.map((issue) => `${issue.key}: ${issue.message}`);
		super(details.length > 0 ? `${message}\n${details.join('\n')}` : message);
		this.issues = [...issues];
	}
}
