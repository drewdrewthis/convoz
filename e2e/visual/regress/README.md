# App regression frames

References for `e2e/tests/app-regress.spec.ts` (`specs/features/app-regress.feature`): the app against its own reviewed frames.
Per project (`chromium` = 1280x720 desktop, `mobile` = 390x844 phone) and per screen and scheme:

- `<screen>-<scheme>.png`: the pixels (at most 200 may differ).
- `<screen>-<scheme>.boxes.json`: the box `[x, y, w, h]` of every element the list `BOXED` in `e2e/lib/regress.ts` matches (within 0.5 px).

## Rewrite the references (a person, on purpose)

Only when a screen is meant to look different, and only after looking at the new frames:

```sh
cd e2e && REGRESS_WRITE=1 pnpm exec playwright test tests/app-regress.spec.ts --project=chromium --project=mobile --workers=2
git diff --stat visual/regress   # review every changed frame
```

On a box that must not run Playwright, let CI write them: put the label `regress-write` on the PR (or start the `regress-write`
workflow by hand). It runs the command above on a runner and uploads the frames as the artifact `regress-frames`. Download it, copy it
over `e2e/visual/regress`, review every changed frame, and commit. A frame no scenario shoots any more is left as it was: delete it in the PR.

Without `REGRESS_WRITE=1` the spec never writes here, and a missing file fails the scenario.
