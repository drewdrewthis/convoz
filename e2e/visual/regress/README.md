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

Without `REGRESS_WRITE=1` the spec never writes here, and a missing file fails the scenario.
