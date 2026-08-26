# Official PAYTABLE / Game Rules parity specification

## Evidence boundary

- Visual and interaction authority is the live en_GB original at source revision `1.2.1-primalrampage.471`, captured at PC 1440x900 and the original mobile channel on 2026-08-26.
- Author geometry and atlas frames come from `web/public/assets/primal-runtime/mobile/config/config_mobile.json`; local screenshots are retained only under `.artifacts/paytable-parity/` and are not release inputs.
- Player copy is the live original en_GB text. Hidden reel strips, weights, RTP and probabilities are not present in the captured client and are not inferred from its presentation.

## Shared shell and interaction

- The overlay background is near-black. PC and original mobile-landscape use the fixed left rail in this order: `SETTINGS`, `PAYTABLE`, `GAME RULES`; the selected tab is white with black text. The close control is circular and fixed at the top right.
- PAYTABLE is a single vertical authored surface. Opening it or switching into it starts at scroll position 0. Each tab owns its scroll position; a deep PAYTABLE position must never leak into GAME RULES.
- The content surface is 750 logical pixels wide and receives one isotropic outer scale. No internal card reflow, font rescaling, horizontal scrolling or separate X/Y stretch is allowed.

## PAYTABLE author timeline

The surface uses the captured author anchors below. A tolerance of 1 logical pixel is allowed for fractional browser layout.

| Block | Author Y |
|---|---:|
| top maximum-win statement | 51.5 |
| separator | 159 |
| WILD | 176 |
| separator | 858.05 |
| VAULT BONUS | 868 |
| RAGE SYMBOL | 1718.25 |
| PRIMAL WHEEL | 2384.10 |
| KONG QUEST page 1 / page 2 | 3178.15 / 3902.20 |
| KING SPIN page 1 / page 2 | 4735.90 / 5563.85 |
| PAYING SYMBOLS | 6153.65 |
| WAY WINS | 6848.90 |
| bottom maximum-win statement | 7445 |

- Nine section boundaries use the captured `T0AB` 750x10 orange glow separator from the PAYTABLE atlas. Blank margins are not an acceptable substitute.
- Top and bottom text is exactly `Win up to 2500x your bet!`. This claim is visible only when the bound server definition enforces the matching 2500x game-round win cap; a mismatched or unbound definition fails closed rather than publishing the claim.

## Typography

- Normal section title: the final runtime `KANIT_BOLD` header route, 45px/60px, centered. `WAY WINS` uses 42px. The maximum-win statement uses 45px. The raw timeline fallback names Roboto Condensed, but the live client applies the `GameFont` style route before paint.
- Title fill is the final visible orange/red treatment from the original, not the raw fallback colour and not a dark-red silhouette. Implement a separate stroke underlay if browser gradient clipping and `-webkit-text-stroke` cannot preserve the fill.
- Title fill/stroke reference: top `#ff250a`, bottom `#ff710a`, dark-red outline `#5c0001` with the captured Canvas `lineWidth=10` author stroke. Its CSS projection is 5px because browser text-stroke expands by the declared width on both sides of the glyph edge.
- Body: `ROBOTO_CONDENSED_REGULAR`, 30px/40px, white, centered. WAY WINS body is 740px wide. Although the raw timeline records `lsp=3`, the live original renders the English sentence as two lines without that spacing; the browser projection therefore uses 0px.

## Exact PAYTABLE content

Order and names are fixed:

1. `WILD`: X100, X50, X25, X10, X5, X3, X2 and plain WILD, followed by PT1-PT4.
2. `VAULT BONUS`: Vault symbol, PT5-PT6, the two Ape/Vault images, PT7.
3. `RAGE SYMBOL`: Rage image, PT8-PT10.
4. `PRIMAL WHEEL`: wheel image, PT11-PT13.
5. `KONG QUEST`: wheel slice, PT14-PT17, expanded reels, PT18-PT19, +1-spin vault.
6. `KING SPIN`: wheel slice, PT20-PT22, open Vault, PT23-PT24, then the smoke/reward composition including the `T0EB` effect.
7. `PAYING SYMBOLS`.
8. `WAY WINS`.

PT1-PT24 and WAY WINS copy remain byte-for-byte equal to the captured en_GB bundle. No internal engine symbol names may appear in player-visible text or accessibility labels.

### PAYING SYMBOLS

- Two columns, three rows, top-to-bottom: Jet/Tank, Radio/Helmet, K/Q.
- Every card shows the symbol art, yellow `x3`, and a white amount derived from the current total bet through integer minor-unit arithmetic.
- At total bet 1.00 the amounts are Jet `2.00`, Tank `1.50`, Radio `1.00`, Helmet `0.80`, K `0.30`, Q `0.10`.
- Do not render the symbol name, `total bet`, floating-point output, or the old internal identifiers `PRISM`, `ORBIT`, `PULSE`, `NOVA`, `CIRCUIT`.
- Preserve the captured per-symbol scales: Jet/Tank 0.58, Radio 0.62, Helmet 0.75, K 0.78, Q 0.71.

### WAY WINS

- Render both captured 280x270 atlas frames (`T0QB` and `T0RB`) side by side before the description; they depict the accepted and rejected adjacency examples.
- The exact copy is: `Way Wins are awarded for 3 adjacent symbol combinations from left to right except Vault Bonus and Rage Symbols.`

## GAME RULES

- GAME RULES uses the original white card, black text and centered black headings, not the PAYTABLE dark-card styling.
- Packaged gameplay sections reproduce the captured `Game Rules` material: base 3-reel/ways statement, WILD, VAULT BONUS, RAGE SYMBOL, PRIMAL WHEEL, KONG QUEST FREE SPINS, KING SPIN FREE SPINS and player actions.
- The captured generic `Information` section and public gameplay rules are packaged in their original order. Operator-specific `Unfinished Games`, retention, malfunction and jurisdiction copy stays on the validated operator bundle boundary and may be prepended only when supplied and approved; the packaged gameplay guide must not be hidden merely because those supplemental terms are absent.
- KONG QUEST explicitly states the 27/64/125/216/343/512 ways and the 30-spin cap. KING SPIN states the X1000/X500/X250/X150/X75/X60/X30/X20/X10/X9..X1 values and its 8-spin cap. PRIMAL WHEEL states that its presentation does not reflect real probabilities.

## Responsive and accessibility

- PC 1280x720 and 1440x900 preserve the side rail and the author geometry. Portrait phone/tablet may move navigation to the compact top rail, while landscape returns to the captured left rail; content geometry never changes.
- All artwork has player-domain alt text. Decorative separators and effects are hidden from accessibility. PAYING SYMBOLS exposes symbol name, `x3`, and current amount without exposing engine IDs.
- Close and tab controls remain keyboard reachable. Tab selection updates `aria-selected`; hidden panels are inert.

## Required verification

- Exact title/order/copy tests, 750px author geometry, nine separators, both WAY WINS frames, KING effect, and dynamic PAYING SYMBOLS values.
- Scroll reset/isolation tests for open, close and tab changes.
- Browser side-by-side captures at PC 1440x900 and local phone 390x844/tablet 633x844, including top, PAYING SYMBOLS, WAY WINS, bottom edge and GAME RULES.
- Server tests prove the 2500x cap before the two maximum-win statements may render. Hidden commercial probability and RTP parity remain an external math-package and certification gate.
