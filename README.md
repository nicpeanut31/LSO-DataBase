# LSO Orchestra Management System — GitHub-ready build

This is the compact deployment package for the Lasallian Symphony Orchestra system.
It contains the current website runtime, current PWA files, required visual assets,
and the latest Supabase setup/update references.

## Deployment

Upload the files inside this folder to the GitHub Pages publishing root. `index.html`
must remain at that root. Do not rename any file.

## Database files

- `supabase-setup.sql`: complete setup for a new Supabase project.
- `LSO_ACCOUNT_ROLES_MEMBERSHIP_GENERAL_SECRETARY_INSTALL.sql`: existing-project
  update for the Membership and General Secretary roles.

Do not run SQL files again when the corresponding update already completed successfully.
