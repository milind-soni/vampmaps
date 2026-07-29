# ShadeMax interface system

## Product hierarchy

The persistent route screen answers only:

1. Which route is active?
2. How long does it take?
3. How much direct sun is modeled?

Time and light-preference controls live in the expanded sheet. Methodology,
sources, uncertainty, and safety language live behind the info button. This
keeps the map primary and follows Apple’s guidance to limit onscreen controls
and avoid continually obscuring a map.

## Semantic color roles

| Role | Light | Dark | Usage |
| --- | --- | --- | --- |
| Brand/action | `#62305E` | `#D7AAD3` | Buttons, selection, focus, endpoints |
| Shade data | `#0E746A` | `#58C2AE` | Shaded route segments and legend only |
| Sun data | `#B45F1D` | `#F0AE5D` | Sun-exposed route segments and warnings only |
| Canvas | `#F7F5F2` | `#141214` | App background |
| Surface | `#FFFEFC` | `#1C191C` | Sheet and cards |
| Primary text | `#241F23` | `#F5F0F4` | Content |

Route color is never the only encoding: high-exposure segments use a short dash
pattern, the fastest route uses a long dash pattern, and every route has an
appearance-aware casing.

## Layout and accessibility

- The map stays interactive; route entry has searchable From/To fields plus an
  explicit Choose on Map mode.
- Route details use a nonmodal bottom sheet with both drag gestures and an
  explicit chevron toggle; swiping is never required.
- Area fetches show a compact determinate bar with percentage and transferred
  bytes. Catalog checks, requests, and local verification use an indeterminate
  loader because those stages do not expose an honest numeric total.
- The light control has five discrete stops from Most sun through Balanced to
  Most shade. Only its endpoints and current value are labeled, keeping the
  choice legible without turning the sheet into a row of competing buttons.
- Preference routing is bounded to at most 50% or 1.2 km beyond the fastest
  path, whichever is smaller, so an extreme setting cannot create an absurd
  walking detour.
- Standard controls have at least a 44 pt interaction region.
- Light and Dark appearances use semantic colors.
- Reduce Transparency falls back from Liquid Glass to an opaque bordered
  surface; Reduce Motion disables animated route camera changes and sheet
  snapping.
- At large Dynamic Type sizes, route rows become two-line cards, preferences
  become vertical, the time header stacks, and the sheet uses a taller detent.
- Decorative symbols are hidden from VoiceOver; route choices expose radio
  state and complete spoken metrics.

## Mascot system

The same original vampire character appears in three project assets:

- `mascot-vamp-walk.png`: route page, holding a route map.
- `mascot-vamp-world.png`: download page and city picker, holding the coverage globe.
- `mascot-vamp-accuracy.png`: estimate page and methodology sheet, inspecting the model.

Onboarding is a three-step horizontal story with tappable progress segments and
Back/Next controls, so no vertical swipe is required. Its active pose enters
with a short spring, then floats by 6 pt with a subtle 2° tilt. The loop and
page transition are disabled when Reduce Motion is enabled. The same poses stay
static elsewhere so the mascot adds personality without increasing interaction
noise. All three images are decorative and hidden from VoiceOver.

## Primary references

- [Designing for iOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-ios)
- [Maps](https://developer.apple.com/design/human-interface-guidelines/maps)
- [Materials and Liquid Glass](https://developer.apple.com/design/human-interface-guidelines/materials)
- [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)
- [Onboarding](https://developer.apple.com/design/human-interface-guidelines/onboarding)
- [Icons](https://developer.apple.com/design/human-interface-guidelines/icons)
- [Sliders](https://developer.apple.com/design/human-interface-guidelines/sliders)
