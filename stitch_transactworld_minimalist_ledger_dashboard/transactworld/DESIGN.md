---
name: TransactWorld
colors:
  surface: '#faf8ff'
  surface-dim: '#d9d9e5'
  surface-bright: '#faf8ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f3f2fe'
  surface-container: '#ededf9'
  surface-container-high: '#e8e7f3'
  surface-container-highest: '#e2e1ed'
  on-surface: '#1a1b23'
  on-surface-variant: '#434655'
  inverse-surface: '#2e3039'
  inverse-on-surface: '#f0f0fb'
  outline: '#747686'
  outline-variant: '#c4c5d7'
  surface-tint: '#2151da'
  primary: '#0037b0'
  on-primary: '#ffffff'
  primary-container: '#1d4ed8'
  on-primary-container: '#cad3ff'
  inverse-primary: '#b7c4ff'
  secondary: '#555f6d'
  on-secondary: '#ffffff'
  secondary-container: '#d6e0f1'
  on-secondary-container: '#596372'
  tertiary: '#7f2500'
  on-tertiary: '#ffffff'
  tertiary-container: '#a73400'
  on-tertiary-container: '#ffc9b7'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#dce1ff'
  primary-fixed-dim: '#b7c4ff'
  on-primary-fixed: '#001551'
  on-primary-fixed-variant: '#0039b5'
  secondary-fixed: '#d9e3f4'
  secondary-fixed-dim: '#bdc7d8'
  on-secondary-fixed: '#121c28'
  on-secondary-fixed-variant: '#3e4755'
  tertiary-fixed: '#ffdbcf'
  tertiary-fixed-dim: '#ffb59c'
  on-tertiary-fixed: '#390c00'
  on-tertiary-fixed-variant: '#832700'
  background: '#faf8ff'
  on-background: '#1a1b23'
  surface-variant: '#e2e1ed'
typography:
  headline-lg:
    fontFamily: Inter
    fontSize: 30px
    fontWeight: '600'
    lineHeight: 38px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.02em
  headline-sm:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '600'
    lineHeight: 28px
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  label-md:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '500'
    lineHeight: 18px
    letterSpacing: 0.01em
  label-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
  number-lg:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  number-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '500'
    lineHeight: 20px
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  base: 4px
  container-padding: 24px
  gutter: 16px
  stack-sm: 8px
  stack-md: 16px
  stack-lg: 32px
---

## Brand & Style
The design system is rooted in **Modern Minimalism**, prioritizing data density, clarity, and utilitarian elegance. It is designed for high-stakes merchant operations where financial accuracy is paramount. The aesthetic avoids all decorative non-essentials, focusing instead on structural hierarchy and "Linear-style" restraint. 

The UI should evoke a sense of absolute reliability and calm. It utilizes a vast amount of whitespace to reduce cognitive load during complex financial reconciliation. There are no gradients, shadows are nearly imperceptible, and the interface relies on a strict grid and monochromatic foundation punctuated only by functional status colors.

## Colors
The palette is intentionally restrained to ensure that financial data remains the focal point. The background uses a cool-toned slate white (`#f8fafc`) to provide a soft contrast against pure white (`#ffffff`) surfaces.

The status colors are saturated and clear, providing immediate semantic meaning to transaction states without overwhelming the page. For secondary text and inactive states, a neutral gray scale is used to maintain a clear hierarchy of information importance.

## Typography
This design system uses **Inter** for all typographic needs. To ensure financial data is legible and comparable at a glance, all monetary figures and dates must use `tabular-nums` (monospaced) font-feature settings. 

Large headlines use a tighter letter-spacing for a modern, executive feel. Small labels (`label-sm`) are often presented in uppercase with slight tracking to distinguish them from body copy. Line heights are generous to ensure readability in data-heavy settlement reports.

## Layout & Spacing
The layout follows a **Fixed-Fluid Hybrid** model. Dashboards utilize a max-width container of 1440px on desktop, while internal table views may stretch to fill the screen to accommodate numerous columns. 

A strict 4px baseline grid governs all spacing. Vertical stacks use 16px (`stack-md`) for related elements and 32px (`stack-lg`) to separate distinct sections. On mobile, horizontal margins shrink from 24px to 16px, and multi-column grids collapse into a single-column stack.

## Elevation & Depth
Depth is achieved through **Tonal Layering** and subtle borders rather than dramatic shadows. 
- **Level 0 (Background):** `#f8fafc` — The canvas.
- **Level 1 (Cards/Surfaces):** `#ffffff` with a `1px` solid border (`#e5e7eb`).
- **Overlays (Modals/Popovers):** `#ffffff` with a very soft, diffused shadow (`0px 4px 20px rgba(0, 0, 0, 0.05)`).

Interactive elements like buttons do not use shadows, maintaining a flat, high-performance look. Active states for inputs are indicated by a 1px colored border stroke rather than a glow.

## Shapes
The shape language is varied to create functional distinction:
- **Cards & Major Containers:** 16px radius. These larger shapes ground the layout and feel approachable.
- **Buttons & Inputs:** 10px radius. This "soft-square" look provides a professional, tool-like appearance.
- **Chips & Tags:** Fully pill-shaped (9999px) to clearly differentiate status indicators from actionable buttons.

## Components

### Buttons & Inputs
Buttons feature a solid `#1d4ed8` background for primary actions and a white background with a `#e5e7eb` border for secondary actions. Text is centered and bolded. Inputs use the same 10px radius and 1px border; on focus, the border transitions to the primary blue.

### Status Chips
Chips are pill-shaped with a light background tint derived from the status color (e.g., 10% opacity). They must include a small (6px) solid colored dot to the left of the label to ensure accessibility and immediate visual recognition.

### Tables
Tables are the core of this design system.
- **Header:** Uppercase `label-sm`, `#9ca3af`, 12px padding.
- **Rows:** Minimum height of 52px. Hover state uses a subtle `#f8fafc` background change.
- **Alignment:** Amounts and currency tags are always right-aligned. Currency tags (USD, EUR) should be `label-sm` and placed to the right of the amount.
- **Dividers:** Only horizontal 1px lines (`#e5e7eb`). No vertical lines.

### Cards
Cards are white with a 16px radius and 1px border. For summary dashboards, cards may include a "trend" indicator (small green/red text) in the top right corner using `number-md`.