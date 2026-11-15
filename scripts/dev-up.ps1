$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
  $dockerInfo = & docker info --format '{{.ServerVersion}}' 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $dockerInfo) {
    throw "Docker Desktop is not available. Start Docker Desktop and run pnpm dev:up again."
  }

  $previousErrorAction = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & pnpm exec supabase start *> $null
  $startExitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorAction
  if ($startExitCode -ne 0) {
    throw "Local Supabase failed to start. Diagnostic output was suppressed to avoid displaying generated credentials. Run 'pnpm exec supabase status' after reviewing your local Docker state."
  }

  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "prepare-env.ps1") -Quiet
  if ($LASTEXITCODE -ne 0) { throw "Could not prepare the local environment file." }

  & docker compose --env-file .env.local up -d --build web
  if ($LASTEXITCODE -ne 0) { throw "The web container failed to start." }

  & pnpm demo:seed
  if ($LASTEXITCODE -ne 0) { throw "The local demo account could not be prepared." }

  $webPort = "3000"
  foreach ($line in Get-Content -LiteralPath (Join-Path $repoRoot ".env.local")) {
    if ($line -match '^WEB_PORT=(\d+)$') { $webPort = $Matches[1] }
  }
  Write-Host "Local app: http://localhost:$webPort"
  Write-Host "Supabase Studio: http://127.0.0.1:54323"
  Write-Host "Use the local demo credentials stored in ignored .env.local."
}
finally {
  Pop-Location
}
