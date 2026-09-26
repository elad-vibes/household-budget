# Design pass – "הכסף של הבית" (make it warm, visual and fun – without hurting clarity or speed)

Audience: Israeli families on iPhone (home-screen PWA). Hebrew RTL. Must stay fast, accessible (keep Lighthouse a11y 100), and work at 375–390px.
Keep the existing theme presets (bank/card colors) – every new element takes its colors from the theme tokens.

## 1. Home-screen presence
- Proper app icon (SVG master → PNG 180/192/512, maskable) and iOS splash screens in the theme color. Icon: a simple original mark (house + coin/wallet), no brand logos.
- Personal greeting at the top: "בוקר טוב / צהריים טובים / ערב טוב, <שם>" with a small time-of-day illustration.

## 2. Illustrations (original, bundled – no external image hosts, CSP stays strict)
- One consistent flat illustration style, drawn as inline SVG components that recolor with the theme (accent / soft / deep tokens).
- Where: onboarding screens (3), empty states (no transactions yet, receipt queue empty, shopping list empty, no goals yet), success moments (month saved, goal reached, all receipts approved), error/offline state.
- Allowed sources: your own SVG, or open-license sets whose license allows bundling without attribution in-app (e.g. unDraw – verify license at build time; record every asset + license in `ASSETS.md`). No stock photos of real people, no copyrighted characters.

## 3. Category identity
- Every category gets an icon (Lucide/Tabler, MIT) inside a soft colored circle, used everywhere a category appears (lists, review table, charts legend).
- Merchant rows: first-letter avatar in the category color.

## 4. Overview screen – more visual
- Hero card with a subtle gradient from the theme accent, the monthly total with a quick count-up animation, and a small sparkline of the last 6 months.
- Donut chart for categories (tap a slice → filtered transactions), keeping the existing bar list below it.
- Budget progress as rings or bars that turn amber at 80% and red at 100%.
- Savings goals as a "jar" that fills up; confetti (lightweight, respects prefers-reduced-motion) when a goal is reached.
- AI analysis tips as cards with an icon per tip type (electricity, insurance, subscriptions, groceries…) and the savings amount as a pill.

## 5. Micro-interactions
- Skeleton loaders instead of spinners; smooth tab transitions; pressed states on buttons; swipe-left to delete a transaction with undo toast; pull-to-refresh on overview.
- All motion off under prefers-reduced-motion.

## 6. Receipt capture – make it feel like an app
- Big floating camera button (bottom), a capture sheet with a framing guide, instant sharpness badge (✓ חד / ✗ מטושטש – צלם שוב), and a queue counter badge with "יישלח ביום ראשון".

## 7. Optional dark mode
- System / light / dark toggle in the Home tab; all theme presets get a dark variant.

## Rules
- No new heavy dependencies (keep bundle small; charts: hand-rolled SVG or a tiny lib < 15KB gz).
- Apart from payment-methods.md (done first), don't change business logic, data, RLS or Edge Functions in this pass.
- Before/after screenshots at 390px for every main screen in `docs/design-pass/`, Playwright tests still green, Lighthouse PWA/a11y re-checked, then deploy.
