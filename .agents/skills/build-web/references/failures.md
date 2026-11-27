# Web failure signatures and next inspections

Use this reference during diagnosis and review. A signature narrows the next evidence to inspect; it does not authorize a broad rewrite.

## Contents

- Classification and render failures
- SSR, hydration, and navigation failures
- State, forms, and data failures
- Component and accessibility failures
- Motion and resource failures
- Security and connected-system failures
- Content, asset, and deployment failures
- Diagnostic procedure
- Sources and freshness

## Classification and render failures

| Signature | Likely cause | Next inspection | Do not do |
|---|---|---|---|
| Interactive-looking file exists but is never imported | Abandoned experiment | Route/component import graph | Declare it the current architecture |
| Entire Astro site switched to server output for one dynamic route | Route scope not classified | Per-route `prerender`, adapter need | Assume server mode adds capability |
| Static docs require runtime server | Build-time factories overlooked | Static paths and generated JSON | Add SSR without request-time need |
| Repository called extension but has no manifest/contexts | Name trusted over source | Manifest, background, content scripts | Invent extension APIs |
| Static content absent until JavaScript | Unnecessary client-only rendering | Raw server HTML and island directive | Hide with loading spinner |
| Server island never resolves | Adapter/runtime or deferred route failure | Adapter output, network request, fallback | Replace page with full client app |
| Personal content appears in shared cache | Cache key/policy omits identity | Route classification and headers | Patch client display only |

## SSR, hydration, and navigation failures

| Signature | Likely cause | Next inspection | Do not do |
|---|---|---|---|
| Hydration mismatch | Server/client first render differs | HTML, time/random/media/storage/ids | Suppress warning globally |
| Theme or motion flashes | Browser preference read before/after inconsistent snapshot | Inline/server theme contract and mount reconciliation | Make whole page client-only |
| `client:only` build error | Renderer cannot be inferred or integration absent | Explicit hint and installed integration | Guess `react` from `.tsx` |
| Browser API fails during build | Module/render-time DOM access | Import graph and mount gate | Wrap random lines in `try/catch` |
| Duplicate click after navigation | Repeated `astro:page-load` listeners | Delegation, AbortController, cleanup | Add a boolean on each element |
| Back button loses filters | State kept only in component | URL schema and navigation updates | Add a second global store |
| Route announcement is wrong | Missing/duplicate title or heading | Document metadata and client router | Add noisy custom live regions |
| Persisted island shows stale user | Lifetime/props persisted across auth change | `transition:persist`, prop policy, session key | Force full reload everywhere |

## State, forms, and data failures

| Signature | Likely cause | Next inspection | Do not do |
|---|---|---|---|
| Loader and component fetch twice | Different query keys/options | Canonical query-options factory | Disable refetch blindly |
| Filter changes but page remains out of range | Dependent pagination not reset | URL patch policy | Clamp only in render |
| Copied URL cannot reproduce view | Shareable state kept locally | URL ownership table | Serialize dialog/hover state too |
| Old async validation overwrites new value | Missing cancellation/sequence guard | Validation request identity | Increase debounce only |
| Double submit creates duplicates | UI guard without server idempotency | Pending state, idempotency/unique policy | Trust disabled button |
| Optimistic row never reconciles | Mutation invalidation/rollback incomplete | Query identity and authoritative response | Keep optimistic state forever |
| Selected rows change after sort | Array index used as identity | Domain row ids | Freeze sorting |
| “Select all” affects wrong scope | Selection policy undefined | Loaded/current-query/all-matching contract | Infer from checkbox state |
| Virtual list focus disappears | Focused row unmounted | Roving/focus/overscan/fallback policy | Inflate overscan indefinitely |
| Loading, empty, and error look identical | State model collapsed | Query/status branching | Add one generic skeleton |

## Component and accessibility failures

| Signature | Likely cause | Next inspection | Do not do |
|---|---|---|---|
| Generated component unstyled | CSS/token/registry dependency missing | `components.json`, layers, generated classes | Rewrite component from scratch first |
| Dialog opens but focus escapes | Primitive/wrapper/portal mismatch | Modal focus scope and container | Add `tabindex` to every element |
| Menu works by mouse only | Incomplete keyboard state machine | Primitive source and APG behavior | Add only Enter handler |
| Button submits parent form unexpectedly | Missing `type="button"` | Rendered HTML/form nesting | Prevent all form submit events |
| Icon-only actions announced identically | Accessible names omit target | Button labels per item | Put state in icon filename |
| Hidden control still receives focus | Visual/a11y state diverges | `hidden`, `inert`, `aria-hidden`, tab order | Use `aria-hidden` on focusable nodes |
| Error visible but not announced | Missing association/focus/live policy | `aria-describedby`, summary, status | Make every message assertive |
| Table read as layout | Missing semantic table/header relations | Rendered roles/caption/headers | Add ARIA grid without keyboard model |
| Component behavior changes after registry update | Generated source/primitive drift | Diff and behavior suite | Trust version number alone |

## Motion and resource failures

| Signature | Likely cause | Next inspection | Do not do |
|---|---|---|---|
| Removed item never disappears | Exit completion path missing | Presence registry and zero-animation case | Add arbitrary timeout |
| Exit never appears | Owner disposed before retention | Parent control-flow owner | Start animation in cleanup |
| Duplicate item after reentry | Same-key policy undefined | Retained record identity | Generate random keys |
| Motion prop type exists but no response | Type surface exceeds runtime | Event binding/renderer tests | Document capability as complete |
| Animation jumps on hover release | Lane priority/resume wrong | Current value/velocity and resolver | Reset to initial value |
| Layout motion reads on server | Measurement not mount-gated | FLIP phase ownership | Use optional chaining as proof |
| Work continues offscreen | Initial hydration visibility mistaken for suspension | Page/intersection visibility | Change only `client:visible` margin |
| CPU/memory grows per route | Missing disposal | Frames, listeners, observers, roots, WebGL | Rely on garbage collection |
| WebGL failure leaves blank hero | Static fallback removed/covered | Image stacking and error state | Make WebGL critical content |
| Reduced motion still parallax-scrolls | Policy changes duration only | Behavior-level preference branch | Set duration to 1ms |

## Security and connected-system failures

| Signature | Likely cause | Next inspection | Do not do |
|---|---|---|---|
| Auth works but cross-org data leaks | Authentication mistaken for authorization | Server scope in repository query | Hide other-org controls |
| Credentialed CORS fails | Origin/cookie/trusted-origin mismatch | Preflight and Set-Cookie in browser | Use wildcard origin |
| OAuth loops or discovery URL wrong | Base URL/path/issuer mismatch | Handler mount and metadata | Patch callback URL only |
| Secrets appear in bundle | Server module reachable from client | Import graph and serialized props | Rename environment variable |
| Webhook accepts spoofed events | Signature/raw-body/replay missing | Provider verification sequence | Rely on obscure URL |
| Webhook retries duplicate side effects | Event id/idempotency missing | Persistence and retry contract | Always return 200 before work |
| Logs contain API key or payload PII | Raw-object logging at the handoff | Structured redaction policy | Remove all diagnostics |
| CSP breaks valid UI | Policy not derived from resources/nonces | Violation reports and asset origins | Disable CSP globally |
| Rich content executes script | Raw HTML not sanitized/mapped | Content rendering stage | Escape only one field |
| Mutating GET route | Method semantics collapsed | Endpoint exports and caller | Add CSRF token to GET |
| Personalized page served stale | Public/shared caching on auth route | Middleware classification | Bust cache with random URL |

## Content, asset, and deployment failures

| Signature | Likely cause | Next inspection | Do not do |
|---|---|---|---|
| Draft appears publicly | Status filtering absent/inconsistent | CMS adapter/query and preview mode | Filter only in page component |
| Taxonomy route empty without error | Wrong taxonomy name/id field | Provider schema and adapter | Rename routes by guess |
| N+1 content requests | Relationships mapped per entry | Batch API/cache strategy | Cache forever without invalidation |
| Missing image crashes build | Schema assumes relation/media always exists | Mapper defaults and content policy | Insert fake image path |
| Canonical/social image uses wrong origin | Relative/absolute URL contract mixed | Site config and URL construction | String concatenate origins |
| Feed and page disagree | Separate content selection/mapping | Shared published view model | Patch feed-only exclusions |
| Icon build/type failure | Wrong compiler or virtual module | Astro versus island renderer config | Switch every icon package |
| Font waterfall/layout shift | Too many preloads/missing metrics | Network waterfall and fallback | Preload every family |
| Adapter works locally but deployment fails | Runtime binding/API mismatch | Target adapter build and startup | Claim preview equivalence |
| Static route unexpectedly hits database | Import side effect or dynamic source | Build trace and content ownership | Add broad network permission |

## Diagnostic procedure

1. Reproduce the smallest real failing path.
2. Record route, output mode, renderer, state owners, auth scope, and connected systems.
3. Inspect the active import/runtime graph; ignore unreachable examples.
4. Capture raw server response, browser console/network, accessibility tree, and resource counts as relevant.
5. Identify the first handoff where actual behavior diverges from the documented contract.
6. Fix that owner without adding a second owner.
7. Add a regression oracle at the lowest layer that reproduces the failure and one higher integration layer when the handoff crosses systems.
8. Re-run adjacent negative/failure cases.

## Sources and freshness

- Anonymized failure patterns adapted from site, application, runtime CMS, experimental motion, and Solid Primitives reviews dated 2026-07-17. These scenarios do not establish defects in a current maintained project.
- Current framework-specific error messages can change. Match behavior and ownership before relying on a literal message.
