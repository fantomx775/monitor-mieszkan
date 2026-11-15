<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Realty Watch project rules

- This is an independent local project. Never modify the PanelJazdy repository.
- Use local Docker/Supabase only unless the user gives separate deployment authorization. Do not add cloud credentials or activate cloud jobs.
- Keep source adapters isolated. Stop on CAPTCHA, access denial, and rate limits. Never bypass controls or fetch arbitrary URLs.
- Store only fields needed for the private property-purchase shortlist. Do not persist full listing descriptions or copy portal photos without clear permission.
- Keep `.env.local`, test credentials, local database dumps, traces, and private session data out of Git and chat. Never print credential values.
- Do not call a source `LIVE_PASS` until real records are saved to local DB and confirmed in the authenticated UI. Report exact evidence and scope.
