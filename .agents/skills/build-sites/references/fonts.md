# Astro Fonts API and Fontsource

These are anonymized illustrative examples adapted from historical project
reviews. Local paths, identifiers, and commands describe example ownership;
they do not establish maintained APIs or executed evidence for this project.
Trace the active consumer, verify public package sources for the installed
version, and run the relevant checks before adoption.


## Contents

- Ownership decision
- Astro Fonts API
- Fontsource packages
- Local and variable fonts
- Privacy and external providers
- Fallback metrics and layout shift
- Preload and delivery policy
- Typography contract
- Failure signatures
- Verification
- Sources and freshness

## Ownership decision

Do not combine every font mechanism in one project without an owner.

| Need | Strong default | Why |
|---|---|---|
| Astro 6 site wants unified provider/local configuration and optimized fallbacks | Astro Fonts API | Central typed config, cached/self-hosted provider assets, `Font` component and selective preload |
| Vite/Solid app outside Astro | `@fontsource/*` or `@fontsource-variable/*` | Package-owned CSS/font files work at the app entry/layout |
| Existing app already imports Fontsource | Keep Fontsource unless migration has measured value | Avoid duplicate font faces and asset downloads |
| Licensed/private font file | Astro local provider or project-owned `@font-face` | Source and licensing remain explicit |
| Very custom `@font-face` descriptors/subsetting pipeline | project-owned CSS/build pipeline | Higher control than unified provider abstraction |

Astro's `fontProviders.fontsource()` uses Fontsource as a provider through Astro's font pipeline. It is different from importing `@fontsource-variable/inter` CSS in an application. Choose one owner for each family.

## Astro Fonts API

The uploaded Astro configurations use the Astro 6 `fonts` array with Google and local providers:

```ts
import { defineConfig, fontProviders } from "astro/config";

export default defineConfig({
  fonts: [
    {
      provider: fontProviders.google(),
      name: "Inter",
      cssVariable: "--font-inter",
      weights: [400, 500, 600, 700],
      styles: ["normal"],
      subsets: ["latin"],
      fallbacks: ["Arial", "sans-serif"],
    },
    {
      provider: fontProviders.local(),
      name: "American Kestrel",
      cssVariable: "--font-american-kestrel",
      fallbacks: ["sans-serif"],
      options: {
        variants: [
          {
            src: ["./src/assets/fonts/american-kestrel/americankestral.woff2"],
            weight: 400,
            style: "normal",
          },
        ],
      },
    },
  ],
});
```

Include the configured family in the document head:

```astro
---
import { Font } from "astro:assets";
---

<head>
  <Font cssVariable="--font-inter" preload={[{ weight: 400, style: "normal", subset: "latin" }]} />
</head>
```

Configuring a family does not prove every page emits its `@font-face` and preload assets. Inspect the active root layout and built HTML.

Astro's default `weights` is intentionally narrow (commonly 400). Declare only weights/styles actually used. A CSS class with `font-weight: 700` does not cause the correct file to exist automatically.

Astro can use providers such as Google, Fontsource, or local depending on the installed version. Provider names, options, and availability are versioned: inspect `astro/config` types rather than copying a newer config into an older Astro release.

## Fontsource packages

For a Vite/Solid app:

```ts
// One variable file for the supported weight range.
import "@fontsource-variable/inter";
```

For static fonts, import only required weights/styles:

```ts
import "@fontsource/inter/400.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
```

Then own the CSS token:

```css
:root {
  --font-sans: "Inter Variable", Inter, Arial, sans-serif;
}

body {
  font-family: var(--font-sans);
}
```

The uploaded TanStack Solid frontend uses `@fontsource-variable/inter` 5.2.8. That establishes a package choice, not that the import is wired: locate the actual CSS/entry import and built font requests.

Fontsource variable packages expose axis-specific CSS files. Import one appropriate axis bundle; importing multiple axis bundles can duplicate the weight axis and downloads. Verify the font's actual axes before writing `font-variation-settings`.

## Local and variable fonts

Prefer WOFF2 for web delivery. Keep original licensed sources outside the public bundle when terms require it. Record:

- family and PostScript names;
- weight range and style;
- axes and valid ranges;
- Unicode subsets;
- license and attribution;
- source/version/checksum;
- subsetting command and reproducibility;
- fallback family and metric tuning.

Astro local variable font:

```ts
{
  provider: fontProviders.local(),
  name: "Inter",
  cssVariable: "--font-inter",
  options: {
    variants: [
      {
        src: ["./src/assets/fonts/InterVariable.woff2"],
        weight: "100 900",
        style: "normal",
      },
    ],
  },
}
```

Do not declare a broad range the file does not contain. Do not serve TTF by default when a WOFF2 build is available. For an existing `.ttf` local source, check conversion support, licensing, and visual regression before selecting another format.

## Privacy and external providers

Astro's font provider pipeline can download and cache provider fonts so the deployed site serves them, avoiding a direct visitor request to the third party. Verify the built output and provider behavior at the installed Astro version.

Direct remote `<link>` tags can disclose visitor IP/user-agent/referrer and introduce an external availability dependency. If remote delivery is required, document consent/legal basis, CSP, outage fallback, caching, integrity constraints where applicable, and regional behavior.

Fontsource package imports and local providers are self-hosted by the application build. Pin versions/checksums for reproducibility.

## Fallback metrics and layout shift

Font loading can change line breaks, element height, button width, and hero balance. Choose fallbacks by metrics, not generic family alone.

Control:

- `font-display` policy;
- fallback family order;
- size adjustment;
- ascent/descent/line-gap overrides where the owner supports them;
- fixed/robust line heights;
- container layouts tolerant of text reflow;
- language-specific glyph coverage.

Astro optimized fallbacks are enabled by default in Astro 6 and can generate metric-adjusted fallbacks. If disabling `optimizedFallbacks`, own equivalent metrics deliberately.

Test the fallback and final font separately. CLS can remain low while the design visibly jumps inside a fixed-height component; use screenshots/video as well as numeric metrics.

## Preload and delivery policy

Preload only the first-paint font files actually used above the fold. Each preload competes with CSS, JavaScript, images, and navigation requests.

Astro:

```astro
<Font
  cssVariable="--font-inter"
  preload={[
    { subset: "latin", style: "normal", weight: 400 },
    { subset: "latin", style: "normal", weight: 600 },
  ]}
/>
```

Fontsource/Vite manual preload uses the built asset URL:

```ts
import inter400 from "@fontsource/inter/files/inter-latin-400-normal.woff2?url";
```

```tsx
<link rel="preload" as="font" type="font/woff2" href={inter400} crossOrigin="anonymous" />
```

Do not preload all families, weights, italics, and subsets. Verify that a preload URL exactly matches a later font request; otherwise it is wasted.

Define caching for hashed immutable assets. Avoid CDN `latest`; pin an exact package or URL version.

## Typography contract

Inventory actual use before editing configuration:

```bash
rg -n 'font-(sans|serif|mono|\[)|font-family|font-weight|--font-' src
rg -n 'fontProviders|fonts:|@fontsource|astro:assets' astro.config.* src package.json
```

Map tokens to roles:

| Token | Role | Needed faces |
|---|---|---|
| `--font-sans` | UI/body | regular, medium, semibold, bold if used |
| `--font-display` | headings/hero | actual used range; often no italic |
| `--font-mono` | code/data | regular plus bold only if code uses it |
| brand/decorative | bounded logo/hero accent | one face, fallback, reduced criticality |

Avoid loading a large family solely for one word if a vector/asset or existing face meets the design and licensing constraints. Do not synthesize bold/italic unknowingly; disable synthesis where fidelity matters after verifying browser support and real files.

## Failure signatures

| Signature | Likely cause | Required inspection |
|---|---|---|
| 400 only despite bold CSS | weights omitted from config/imports | built CSS and font network requests |
| two downloads for same face | Astro provider plus Fontsource import | source imports and generated `@font-face` |
| font flashes every navigation | CSS/head lifecycle or cache mismatch | Astro navigation and response cache headers |
| local font builds in dev only | bad source path/case or adapter asset handling | production build output |
| preload warning “not used” | preload does not match selected face/subset/CORS | built URL and computed font |
| hero shifts after font load | fallback metrics/line height mismatch | throttled recording and CLS entries |
| some language renders tofu | missing subset/glyphs | content corpus and font cmap/subsets |
| variable weights look identical | wrong package/CSS axis bundle or invalid range | built `@font-face` and computed styles |
| privacy expectation violated | direct provider request remains | browser network and CSP report |

## Verification

1. Run Astro check and production build.
2. Inspect generated HTML/CSS for one owner per family and correct faces.
3. Use a cold browser profile and record font requests, initiators, transfer sizes, cache headers, and third-party origins.
4. Throttle network/CPU and verify fallback, swap, layout, and no-JS rendering.
5. Test representative routes, languages, weights, italics, code blocks, forms, and dialogs.
6. Measure CLS/LCP and visually compare desktop/mobile breakpoints.
7. Confirm preloads are consumed and remove unused ones.
8. Build offline when self-hosted reproducibility is a requirement.
9. Verify licenses and asset source records.

## Sources and freshness

- Primary: [Astro Fonts guide](https://docs.astro.build/en/guides/fonts/) and [Fontsource documentation](https://fontsource.org/docs/), verified 2026-07-17.
- Historical source scope: Astro, font-provider, and CSS usage reviews from 2026-07-17, adapted here into anonymized configuration examples.

Astro Fonts is a stable top-level configuration surface in current Astro and was added in Astro 6. Older Astro 5 material used an experimental flag and is not a current configuration example. Provider metadata still changes independently, so recheck the installed Astro and Fontsource versions, font licenses, generated CSS, and network behavior.
