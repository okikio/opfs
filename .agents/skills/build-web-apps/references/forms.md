# Forms, validation, and mutation state machines

Use this reference for native, Astro, React, Solid, TanStack Form, auth, file, payment, settings, and multi-step forms. A form library can own field ergonomics; the server owns trust, authorization, and committed domain state.

## Contents

- Evidence and ownership inventory
- Form state machine
- Native form foundation
- Validation timing and schemas
- TanStack Form pattern in a hybrid application
- Async validation and races
- Submission, idempotency, and optimistic state
- Authentication and sensitive forms
- Multi-step, file, and long-lived forms
- Failure signatures
- Verification
- Sources and freshness

## Evidence and ownership inventory

Inspect:

- form element/action/method/enctype and progressive-enhancement target;
- renderer and hydration directive;
- field/form library plus exact version;
- default values and source;
- client and server schemas, transforms, cross-field rules;
- mutation endpoint/service and authorization;
- pending, retry, duplicate, idempotency, and navigation behavior;
- error mapping, focus, live announcements, and PII logging;
- auth/payment/provider redirects and callback allowlist;
- file size/type/storage pipeline;
- tests for invalid, slow, duplicate, offline, server-rejected, and expired-session cases.

Write an ownership table:

| Concern | Owner |
|---|---|
| Draft characters/touched/dirty | Field/form state |
| Shareable step/filter | Validated URL if intentionally navigable |
| Client feedback | Native constraints plus client schema |
| Trust and domain invariants | Server schema/service |
| Session and tenant authority | Server request authority |
| Pending request | Mutation/form controller |
| Committed record | Server/database/provider |
| Remote cache | Query cache and invalidation policy |
| Public error | Endpoint contract |
| Diagnostic cause | Redacted server logging |

Do not copy every keystroke into a query cache or global store. Do not use the URL for passwords, tokens, private drafts, or transient validation.

## Form state machine

Model the phases explicitly:

```text
pristine
  -> editing
  -> locally invalid / locally valid
  -> submitting(request id)
  -> server validation rejected
  -> authorization/conflict rejected
  -> committed(authoritative response)
  -> retryable transport failure
  -> cancelled/navigated
```

Track draft, validation, pending request, and authoritative result separately. A server validation error applies to the values submitted, not necessarily the user's newer draft. Attach request identity or submitted snapshot before displaying an async result.

Define whether a new submission:

- is ignored while one is pending;
- cancels/supersedes the prior request;
- queues behind it;
- creates a new idempotent attempt;
- conflicts and asks the user to reconcile.

## Native form foundation

Start with native semantics:

```html
<form method="post" action="/account/profile">
  <div>
    <label for="display-name">Display name</label>
    <p id="display-name-hint">Shown to members of your organization.</p>
    <input
      id="display-name"
      name="displayName"
      autocomplete="name"
      aria-describedby="display-name-hint display-name-error"
      required
      maxlength="80"
    >
    <p id="display-name-error"></p>
  </div>
  <button type="submit">Save profile</button>
</form>
```

Use:

- explicit label association;
- correct input type, `autocomplete`, `inputmode`, `enterkeyhint`, min/max/length/pattern where semantics match;
- `<fieldset><legend>` for grouped choices;
- persistent instructions separate from labels/placeholders;
- native submit by Enter;
- buttons with explicit type;
- `FormData` names that match server schema;
- server fallback when progressive enhancement is claimed.

Client validation improves UX but is not a security trust transition. Native constraints and client schemas may be bypassed.

Do not validate aggressively on each keystroke. Clear stale errors during input; validate once the user leaves a field or submits according to product policy. Do not disable an initially invalid submit button so thoroughly that users cannot trigger discoverable validation.

## Validation timing and schemas

Separate:

- parse: string/`FormData` to typed candidate;
- field constraints: email/length/range;
- cross-field constraints: confirmation/date ordering;
- async facts: username availability/coupon/provider;
- domain invariants: authorization, balance, uniqueness, state transition.

| Event | Recommended default | Reason |
|---|---|---|
| input/change | Clear stale field error; cheap validation only if helpful | Avoid premature noise |
| blur | Validate touched field | User indicated completion |
| submit | Validate entire form and focus summary/first invalid field | Final client gate |
| server | Reparse and enforce every trusted invariant | Client is untrusted |

Keep the schema in a browser-safe shared module only if it imports no secret/server resource. “Shared TypeScript” does not guarantee client safety. Server and client can use related schemas with deliberate transforms:

```ts
const clientProfile = z.object({
  displayName: z.string().trim().min(1).max(80),
});

const serverProfile = clientProfile.extend({
  // Derived from session, never accepted from the browser.
  actor: authorizedActorSchema,
});
```

Do not add `organizationId` to a public form schema if the server can derive the active organization.

## TanStack Form pattern in a hybrid application

One reviewed application uses `@tanstack/react-form` 1.33 with Zod via form-level `onBlur` and `onSubmit` validators. Better Auth remains the request owner.

```tsx
const signInSchema = z.object({
  email: z.email({ error: "Enter a valid email address." }).trim(),
  password: z.string().min(1, { error: "Enter your password." }),
});

const form = useForm({
  defaultValues: { email: "", password: "" },
  validators: { onBlur: signInSchema, onSubmit: signInSchema },
  onSubmit: async ({ value }) => {
    const result = await signIn.email({ ...value, callbackURL: "/" });
    if (result.error) setFormError(toPublicMessage(result.error));
  },
});
```

Fields preserve native labels/autocomplete and show errors after touch:

```tsx
<form.Field name="email">
  {(field) => {
    const invalid = field.state.meta.isTouched && !field.state.meta.isValid;
    return (
      <Field data-invalid={invalid}>
        <FieldLabel htmlFor={field.name}>Email</FieldLabel>
        <Input
          id={field.name}
          name={field.name}
          type="email"
          autoComplete="email"
          value={field.state.value}
          onBlur={field.handleBlur}
          onChange={(event) => field.handleChange(event.target.value)}
          aria-invalid={invalid}
          required
        />
        {invalid && <FieldError errors={field.state.meta.errors} />}
      </Field>
    );
  }}
</form.Field>
```

This is observed version-specific source, not a guarantee for a later TanStack Form API. Verify installed docs/types. Improve it by ensuring form-level errors are announced/focused appropriately and provider error messages are mapped to stable safe copy rather than blindly shown.

Alternative auth actions use separate pending method state so social/passkey interactions cannot overlap email submit. Browser passkey capability checks improve UX; the server still verifies credentials and policy.

## Async validation and races

Debounce is not cancellation. Use a sequence or `AbortController`:

```ts
let validationSequence = 0;
let validationController: AbortController | undefined;

async function validateHandle(handle: string) {
  const sequence = ++validationSequence;
  validationController?.abort();
  validationController = new AbortController();

  const result = await checkHandle(handle, validationController.signal);
  if (sequence !== validationSequence) return;
  applyValidationResult(handle, result);
}
```

Define aborted request behavior and ignore results that do not match the current field value. Avoid async validation for facts that can be checked only atomically at commit time; uniqueness checks can improve feedback but the final write must handle a race/conflict.

For dependent fields, clear or revalidate only the errors affected by the dependency. Do not run whole-form remote validation on every keystroke.

## Submission, idempotency, and optimistic state

Once valid submission begins:

- prevent duplicate client actions while preserving progress/status;
- snapshot submitted values;
- attach idempotency key when retried side effects require it;
- keep navigation/close policy explicit;
- handle 401/403/409/422/429/5xx distinctly;
- map field errors by stable field paths;
- focus error summary or first invalid field;
- reconcile authoritative response and invalidate exact query keys.

Optimistic updates are appropriate only if rollback and concurrency are clear:

```text
onMutate
  -> cancel relevant query
  -> snapshot prior cache
  -> apply optimistic value

onError
  -> restore snapshot
  -> show safe actionable error

onSuccess/onSettled
  -> replace/invalidate with authoritative server state
```

Do not optimistically claim payment, permission, identity, or irreversible workflow completion.

Client disabled state is not idempotency. The server/database/provider needs a duplicate contract.

## Authentication and sensitive forms

Use appropriate autocomplete:

- sign in email/username: `username` or email according to account model;
- sign in password: `current-password`;
- registration/reset password: `new-password`;
- one-time code: `one-time-code` where supported;
- name/address/payment fields: standard tokens.

Allow password-manager paste. Provide show/hide behavior with clear accessible state and privacy warning when appropriate. Do not log passwords, codes, tokens, recovery keys, complete auth errors, or raw form payloads.

Callback/redirect URLs require allowlisting. Social/passkey/provider availability should be derived by the server and passed as client-safe capability identifiers. An imported client auth module must not require server environment values.

Sensitive settings need re-authentication/fresh-session policy, CSRF/origin defense, server authorization, session invalidation, and audit.

## Multi-step, file, and long-lived forms

For multi-step forms define:

- canonical full schema versus per-step schema;
- URL step only if safe/shareable;
- back/forward and saved-draft policy;
- server draft identity and ownership;
- partial validation versus final commit;
- resume expiration/version migration;
- final review and irreversible action.

For files define size/count/type/content validation, progress/cancel, retry/resume, temporary object cleanup, storage authorization, virus/content processing where required, and accessible status.

For long-lived drafts handle server version conflicts. Do not overwrite a changed record silently; use version/etag/revision and an explicit merge/reload decision.

## Failure signatures

| Signature | Likely cause | Next inspection |
|---|---|---|
| Error appears for old field value | Async result not sequenced | Request/value identity |
| Enter does not submit | Non-native wrapper/key handler | Form/button semantics |
| Double click creates records | No server idempotency | Mutation/service/database |
| Server field errors disappear immediately | Draft and submitted snapshot collapsed | Error ownership |
| Error visible but screen reader silent | Missing association/focus/status | Field error ids/summary |
| Social and email submit overlap | Separate pending paths not coordinated | Form/method state machine |
| Client bundle requests server secrets | Shared schema/auth imports server module | Import graph |
| Optimistic success stays after rejection | Rollback/invalidation missing | Mutation callbacks/query key |
| Back loses multi-step progress | Ownership not durable/shareable | URL/server draft policy |
| File upload succeeds but private file is public | Storage authorization mismatch | Upload/serve authorization path |

## Verification

1. Submit with keyboard, pointer, touch, and Enter.
2. Test native constraints, touched/blur validation, submit validation, and corrected fields.
3. Bypass client validation and test server parsing/authorization.
4. Test slow/reordered/aborted async validation.
5. Double click/submit, retry after timeout, and idempotency.
6. Navigate/close during pending request and return with back/forward.
7. Test 401, 403, 409, validation, rate limit, network loss, and 500.
8. Verify error association, focus, live announcement, autocomplete, and password manager behavior.
9. Verify exact query invalidation/rollback and authoritative response.
10. Search logs/HTML/bundles/URLs for sensitive values.

## Sources and freshness

- Uploaded a product application archive and an earlier archive of that application auth forms, Astro shells, TanStack Form 1.33 usage, and auth capability interface, reviewed 2026-07-17.
- TanStack Form validation docs: https://tanstack.com/form/latest/docs/framework/react/guides/validation (reviewed 2026-07-17).
- Modern Web Guidance forms/accessibility/security guides retrieved 2026-07-17.
- TanStack Form, Astro navigation, Better Auth, and passkey APIs are version-sensitive. Verify installed package APIs and provider policy.
