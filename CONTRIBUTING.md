# Contributing

Thanks for helping improve Cosmic Echo. For substantial changes, open an issue
or discussion first so the proposed behavior can be agreed on before
implementation.

## Development setup

Use Node.js 20.9 or later:

```bash
npm ci
npm run dev
```

Before opening a pull request, run:

```bash
npm run lint
npm run typecheck
npm run build
```

Pull requests should describe the user-facing change, note any known
limitations, and include screenshots for visible UI changes. Do not commit
credentials, `.env` files, generated build output, or downloaded FITS cutouts.
Keep attribution for NASA/IPAC IRSA data and third-party tools up to date.
