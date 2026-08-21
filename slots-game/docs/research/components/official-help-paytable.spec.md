# Official Help / Paytable Specification

## Evidence boundary

- Authoritative geometry and typography come from the captured `config_mobile.json` paytable authoring data.
- Player-facing strings come from captured locale resources keyed by `IDS_PR_PT1` through `IDS_PR_PT24`, `IDS_PR_WW_LR` and their official section-title keys.
- Raw captures and browser archives remain local evidence and are never release inputs.

## Authored surface

- Each official content page uses a 750 logical-pixel text width and keeps its authored image/text ordering.
- Section titles use `ROBOTO_CONDENSED_BOLD`, 45 logical px, centered, with the captured `paytableHeaderStyle` red/orange vertical gradient and dark-red outline. The raw text-field fallback color `#FFFF99` is not the final composed appearance.
- Body copy uses `ROBOTO_CONDENSED_REGULAR`, 30 logical px, `#FFFFFF`, centered, with the official text box heights and line wrapping.
- The Wild page lists X100, X50, X25, X10, X5, X3, X2 and plain WILD. It must not invent an X1 player-facing tile.
- Section order is Wild, Vault, Rage, Primal Wheel, Kong Quest, King Spin, Paying Symbols and Way Wins.
- Do not claim an RTP, probability or maximum-win value unless the signed presentation binding supplies a certified value. The disproven static 2500x claim remains forbidden.

## Responsive and letterbox behavior

- Help is rendered inside the same canonical game surface as the main game and receives the same single isotropic outer scale.
- PC uses its authored side navigation; phone and tablet use the authored compact navigation without changing page typography or independently stretching the content.
- Inner scrolling is allowed only along the authored vertical axis. Horizontal squeeze, card-grid reflow and viewport-unit font scaling are forbidden.

## Locale contract

- Locale selection is explicit, immutable for a connected session and keyed by normalized locale identifiers.
- A locale may be advertised only when all required official keys and its configured font family are present and pass release validation.
- Unsupported or incomplete locales fail closed to the approved `en_GB` presentation bundle; never mix strings from one locale with another locale's font/layout rules.
- `vi_VN` and `th_TH` require the official `PNG_VNTH` font route before they may be enabled. Other official locale groups follow the captured font routing table.

## Tests

- Verify the exact section/key order, official title/body typography and 750-pixel authoring width.
- Verify PC 1280x720, phone 390x844 and tablet 633x844 plus both orientation round trips.
- Verify locale completeness, immutable session locale, fallback behavior and font readiness failure closing.
- Browser screenshots must compare content bounds and line breaks; raw reference images stay ignored outside Git.
