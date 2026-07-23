# LSO Orchestra Management System — Mobile Authentication Security Build

This GitHub-ready package contains the latest member-information update plus a fail-closed mobile authentication gate.

## Security behavior

The management application is hidden, inert, and inaccessible until Supabase validates an approved account and loads its authorized shared data. Failed login, logout, session expiry, initialization errors, and stale mobile scripts return the page to the Login-only state.

## Deployment

Upload every file inside this folder to the GitHub Pages publishing root. `index.html` must remain at that root. Do not rename files.

No Supabase SQL update is required for this website-only security fix.
