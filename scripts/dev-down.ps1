$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
  if (Test-Path -LiteralPath (Join-Path $repoRoot ".env.local")) {
    & docker compose --env-file .env.local down --remove-orphans
  }
  if ($LASTEXITCODE -ne 0) { throw "Docker Compose could not stop the app containers." }

  & pnpm exec supabase stop *> $null
  if ($LASTEXITCODE -ne 0) {
    throw "Supabase CLI reported a stop error. The local database volume was not removed."
  }
  Write-Host "Local containers stopped. Persistent Supabase volumes were retained."
}
finally {
  Pop-Location
}
