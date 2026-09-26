# Bugs reported by Elad

## Fixed 2026-09-27 (regression tests: `tests/e2e/nav-bugs.spec.ts`, fail on the old code, pass on the fix)
- **Invite page, "למסך הכניסה" did nothing** (Chrome desktop, after "הקישור כבר שימש להצטרפות…").
  Cause: the link only changed the hash; `S.joinToken` / the invite error / `hb2-join` stayed, so the invite screen kept
  rendering (and re-routed after reload). Fix: new `leaveJoin()` in `src/ui/auth.ts` clears the token, error and
  `hb2-join`; the link is now a button (`join-cancel`) that goes to sign-in (or reloads into the app when signed in).
  A failed `accept_invite` also drops the pending token.
- **Admin screen, "חזרה לאפליקציה" did nothing** (URL became `#/home`, admin stayed).
  Cause: `go` for a tab only set `S.tab`, but `S.view` was still "admin" (same for "install"/"nohousehold").
  Fix: in `src/main.ts`, leaving admin / install / nohousehold for a tab calls `start()` so the view returns to the app
  (a user without a household lands on the "no household" screen).
