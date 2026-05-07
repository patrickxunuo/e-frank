# e-frank logo concepts

Three directions to compare. All three use the app's existing accent (`#4d7cff`) so they drop into the dark theme without a token change.

## Concept 1 — Stacked Transformation

`concept1-stacked-arrow.svg` · `concept1-stacked-arrow-horizontal.svg`

Two rounded squares: the back one is dashed (the **ticket**, still pending), the front one is filled with a forward arrow (the **PR**, shipped). Tells the ticket-to-PR story in one glance and is a direct evolution of the existing `IconLogo` mark in `src/renderer/components/icons.tsx`.

- **Pros:** narrative match to the product; least visual disruption.
- **Cons:** the dashed outline gets noisy below ~24px; story is less obvious in monochrome.

## Concept 2 — Aperture / Focus

`concept2-aperture.svg`

Six chevron blades arranged around a center, evoking a camera iris or the agent's narrowing focus on a single task. Strong silhouette.

- **Pros:** distinctive shape; works as monochrome stamp.
- **Cons:** semantically further from "ticket → PR"; reads as "tech / focus" generically.

## Concept 3 — Forward Chevron Block

`concept3-chevron-block.svg` · `concept3-chevron-block-horizontal.svg`

A rounded square with a clean double-chevron forward arrow. The strongest favicon — recognizable at 16×16.

- **Pros:** simplest, most legible at small sizes; easiest to monochrome.
- **Cons:** generic — there are a lot of ">>" logos out there.

## Wiring it up

Once you pick one, swap the body of `IconLogo` in `src/renderer/components/icons.tsx`:

```tsx
export function IconLogo({ size = 22, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(size)} {...rest} viewBox="0 0 100 100" fill="none">
      {/* paste the chosen concept's body here */}
    </svg>
  );
}
```

If you also want a favicon (the Electron app icon), I'd suggest exporting the icon-only SVG to PNG at 256×256 / 512×512 — `inkscape concept-N.svg --export-png=icon.png --export-width=512` or use any web converter.
