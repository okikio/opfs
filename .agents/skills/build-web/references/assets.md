# Renderer-owned icons and fonts

These are anonymized illustrative examples adapted from historical project
reviews. Local paths, identifiers, and commands describe example ownership;
they do not establish maintained APIs or executed evidence for this project.
Trace the active consumer, verify public package sources for the installed
version, and run the relevant checks before adoption.


## Contents

- Ownership rules
- Icon contract
- Font contract
- Component-library integration
- Verification
- Sources and freshness

## Ownership rules

Choose the asset integration where the renderer owns the output:

| Rendering context | Icon owner | Font owner |
|---|---|---|
| Astro static component | Astro Icon or local SVG/Astro component | Astro Fonts API/local provider |
| Solid island/application | Unplugin Icons with Solid compiler | app-root Fontsource import or inherited site font CSS |
| React island/application | Unplugin Icons with compatible JSX/React compiler | app-root Fontsource/framework font owner |
| framework-neutral package | icon component contract or raw reviewed SVG data | no global font import; expose tokens/document requirements |

One visual system may use the same Fluent collection across Astro and Solid while using different renderers. Do not make a framework island responsible for an otherwise static icon. Do not import fonts inside reusable leaf components.

When `build-sites` is active, load its `icons.md` and `fonts.md` for the complete Astro-specific configuration, provider, preload, fallback, accessibility, and verification rules.

## Icon contract

Record:

- collection and style family (for example Fluent Regular);
- server/client renderer and compiler;
- literal import or reviewed registry;
- dimensions and viewBox;
- current-color fill/stroke policy;
- decorative versus informative semantics;
- local SVG provenance, sanitization, and license;
- allowed names for dynamic selection;
- bundle inclusion mechanism.

An icon-only button gets its accessible name from the button. Decorative SVGs remain hidden. An informative SVG needs a verified title/description relationship. Do not infer accessibility from a `title` prop.

## Font contract

Record:

- family role and CSS token;
- provider/source, version, license, and privacy policy;
- exact weights/styles/subsets/variable axes;
- self-hosted asset/caching owner;
- fallback sequence and metric adjustment;
- `font-display` and preload policy;
- first-paint routes using each face;
- language/glyph coverage;
- layout-shift and visual-regression evidence.

Avoid duplicate owners such as an Astro provider plus a Fontsource CSS import for the same family. Preload only exact first-paint faces. A configured variable weight range must match the file's axes.

## Component-library integration

Open-code component registries such as shadcn/Zaidan can carry icons and font classes from a different renderer or design system. After generation:

1. replace renderer-incompatible icon imports;
2. preserve accessible names and focus behavior;
3. map size/color classes to local tokens;
4. remove package-wide font assumptions;
5. verify SSR and hydration;
6. keep generator provenance so future updates can be reconciled.

Do not mix Lucide, Fluent, local filled icons, and text glyphs within one surface accidentally. A deliberate exception should document why the primary collection lacks the needed shape.

## Verification

```bash
rg -n 'astro-icon|unplugin-icons|~icons/|lucide|fontProviders|@fontsource|@font-face' \
  src astro.config.* vite.config.* package.json
```

Run the production server/client build, inspect built HTML/CSS, trace network font requests, measure critical asset sizes, test no-JS/static output, and exercise screen-reader names, keyboard focus, high contrast, reduced data, slow font loading, and mobile layout.

## Sources and freshness

- Primary: [Astro Icon](https://www.astroicon.dev/), [Unplugin Icons](https://github.com/unplugin/unplugin-icons), [Astro Fonts](https://docs.astro.build/en/guides/fonts/), and [Fontsource](https://fontsource.org/docs/). Unplugin Icons was rechecked 2026-08-19 for on-demand imports, Vite/Rollup/Webpack/Nuxt/Rspack adapters, React/Solid compilers, SSR/SSG, custom collections, auto import, and TypeScript support.
- Historical source scope: application, documentation, and marketing-site reviews from 2026-07-17, adapted into anonymized asset-ownership examples.

Renderer compilers, Astro APIs, and generated virtual modules are version-sensitive. This reference defines ownership; exact imports must be verified against the target framework and lockfile.
