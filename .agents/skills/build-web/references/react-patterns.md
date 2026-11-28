# React decisions in the installed renderer

Read this reference for component APIs or a demonstrated rendering/bundle problem.
Inspect the installed React version, renderer and public package exports first.
React islands in Astro do not imply Next.js, RSC, SWR, or shared server caches.

## Composition

Prefer explicit variants and children when independent boolean modes make invalid
combinations easy. Compound components can share a provider-owned state/actions
interface; lift state only as far as the actual consumers require. Render props
remain useful when the caller needs data, and ordinary boolean state is valid.
Read the specific [composition rules](vercel-composition-patterns/rules/architecture-compound-components.md)
for compound components; related rule files are indexed by decision in resources.md.
React 19 supports useContext. A ref or use() migration requires version and caller
compatibility evidence, not a blanket rewrite of working APIs.

## Performance

Measure the user-visible cost first. Remove independent-request waterfalls,
minimize client serialization and heavy optional bundles, and keep request data
out of module-level mutable state. Public exports and actual bundler output govern
import decisions. Memoization needs stable dependencies and a measured cost;
compute derived state during rendering unless synchronization is actually needed.
Use [async parallelism](vercel-react-best-practices/rules/async-parallel.md) when
operations are independent; inspect the specific rule only for the affected cost.
Server cache, authentication and after-response APIs require the installed host's
contract. Never copy a Next-only example into Astro without that ownership.

The rule directories retain useful technical examples from Vercel's MIT-licensed
[agent skills](https://github.com/vercel-labs/agent-skills). Their filenames are
lookup keys, not mandatory read order or unconditional optimization requirements.
Consult [React](https://react.dev/reference/react) for version-sensitive behavior.
