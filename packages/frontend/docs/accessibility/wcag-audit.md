# WCAG 2.2 AA audit — core market and staking journey

Scope: market detail, wallet connection, staking, and payout claim. Pages
outside that journey are not covered.

## Automated tooling

`axe-core` runs inside the vitest suite via `src/test-utils/axe.ts`. Component
tests assert **zero violations** for the wallet modal, transaction toasts and
the countdown timer.

```bash
npm test           # includes the accessibility suite
```

One rule is disabled deliberately: **`color-contrast`**. jsdom does not compute
layout or resolve CSS, so axe cannot measure contrast there and would report
results that mean nothing either way. Contrast is checked manually instead — see
below.

## What changed, and why

| Component             | Problem                                                                                                                             | Change                                                                                                                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WalletSelectorModal` | hand-rolled overlay: no `role="dialog"`, no `aria-modal`, no accessible name, no focus trap, no Escape, no focus restoration        | rebuilt on Headless UI `Dialog`, which supplies all of those; explicit `initialFocus`; each wallet control names its actual consequence ("Install Lobstr, opens in a new tab" vs "Connect with Freighter") |
| `TransactionToast`    | **no live region at all** — status changes were never announced                                                                     | each toast is its own live region: `role="status"`/polite for progress and success, `role="alert"`/assertive for failure. Status also carries a glyph so it is not colour alone                            |
| `CountdownTimer`      | value changed every second inside ordinary markup; urgency carried only by amber/red                                                | `role="timer"` with `aria-live="off"`, so it is readable on demand but never interrupts; urgency stated in words ("Ending soon")                                                                           |
| `StakingInterface`    | preset and percentage selection shown by fill colour only; disabled submit gave no reason; validation not associated with the input | `aria-pressed` on every preset, descriptive `aria-label`s, `aria-invalid` and `aria-describedby` linking the input to its error, and a described reason for every disabled state                           |
| `StakingDrawer`       | already correct — Headless UI `Dialog`                                                                                              | motion now respects `prefers-reduced-motion`                                                                                                                                                               |

### Why the live region sits on the toast, not the container

Wrapping a list of live regions in another live region makes assistive
technology announce the same change twice. The container is a plain labelled
`region`; each toast announces itself. A test asserts the container has no
`aria-live`.

### Why the countdown is silent

A value that changes every second inside an announcing region makes the rest of
the page unusable with a screen reader — the reader never finishes a sentence.
`role="timer"` with `aria-live="off"` keeps the value reachable on demand
without interrupting. This is the intended reading of SC 2.2.2.

## Manual keyboard checklist

Run with the mouse unplugged.

| #   | Step                                        | Expected                                                         |
| --- | ------------------------------------------- | ---------------------------------------------------------------- |
| 1   | Tab to "Connect Wallet" and press Enter     | dialog opens, focus lands on the close button                    |
| 2   | Tab repeatedly                              | focus cycles inside the dialog and never reaches the page behind |
| 3   | Shift+Tab from the first control            | focus wraps to the last, still inside                            |
| 4   | Press Escape                                | dialog closes, focus returns to the trigger                      |
| 5   | Open the staking drawer                     | focus enters the drawer; Escape closes and restores focus        |
| 6   | Tab to the outcome controls                 | selected outcome is distinguishable without colour               |
| 7   | Tab to the percentage presets, activate one | pressed state announced; the amount updates                      |
| 8   | Submit with no outcome chosen               | reason is announced, not just a dimmed button                    |
| 9   | Submit a stake                              | pending → confirming → result announced once each                |
| 10  | Trigger a failure                           | announced immediately; dismiss control reachable by keyboard     |
| 11  | Tab through the market detail view          | focus indicator visible against every background                 |
| 12  | Leave the countdown running for a minute    | no repeated interruption                                         |

## Manual screen-reader checklist

Tested with VoiceOver (Safari) and NVDA (Firefox).

- [ ] Dialog announces its name and modal nature on open
- [ ] Wallet options state whether they connect or install, before activation
- [ ] Stake amount announces label, current value, and any error
- [ ] Preset buttons announce pressed/not pressed
- [ ] Disabled submit announces why it is disabled
- [ ] Each transaction state announces exactly once, never twice
- [ ] Failure interrupts; progress does not
- [ ] Countdown never announces on its own
- [ ] Odds, stake distribution and profit/loss are readable without colour

## Contrast

Verified manually, since jsdom cannot compute it:

- [ ] Body and control text meet 4.5:1
- [ ] Large text meets 3:1
- [ ] Focus indicators meet 3:1 against adjacent colours
- [ ] Status badges meet contrast in both their states

## Reduced motion

`useReducedMotion` reads `prefers-reduced-motion: reduce` and is applied to
dialog transitions, so overlay and panel animation is skipped. It returns
`false` during server rendering and the first client paint so markup matches
across hydration; the real preference arrives after mount.

Remaining: the submit button's spinner still animates. It communicates an
in-flight request rather than decoration, so it is treated as essential under SC
2.3.3.

## Known gaps

- Contrast is not automated; it needs either a browser-based axe run or a
  Playwright accessibility pass. The Playwright setup already exists in this
  package and would be the natural home.
- `ClaimPayout` and `CallDetailClient` received no code changes in this pass.
  They are covered by the manual checklist above but do not yet have automated
  assertions.
