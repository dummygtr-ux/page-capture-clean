# CI / release workflows (staged)

GitHub rejects commits that touch `.github/workflows/` unless the pushing token has
the `workflow` scope. These two files are the real workflows, parked here so the
repository could be published first.

To activate them:

```bash
gh auth refresh -s workflow          # adds the scope to your gh token
mkdir -p .github/workflows
git mv ci/github-workflows/*.yml .github/workflows/
git commit -m "Enable CI and release workflows"
git push
```

- `ci.yml` — runs the 86 fixture checks, builds both targets, loads the built
  extension in Chromium, renders the popup, uploads the zips as artifacts.
- `release.yml` — on a `v*` tag: re-runs the tests, builds, tests the artifact it is
  about to ship, then attaches `page-capture-chrome.zip`, `page-capture-firefox.zip`
  and `INSTALL.txt` to the release.

Until then, releases are created by hand:

```bash
npm run build
cp dist/chrome.zip page-capture-chrome.zip
cp dist/firefox.zip page-capture-firefox.zip
gh release create v1.0.0 page-capture-chrome.zip page-capture-firefox.zip dist/chrome/INSTALL.txt --generate-notes
```
