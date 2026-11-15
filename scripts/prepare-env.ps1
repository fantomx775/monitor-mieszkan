param(
  [switch]$Quiet
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
  $previousErrorAction = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $statusLines = & pnpm exec supabase status --output env 2>$null
  $statusExitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorAction
  if ($statusExitCode -ne 0) {
    throw "Supabase CLI did not return local environment values. Start the local stack first."
  }

  $values = @{}
  foreach ($line in $statusLines) {
    if ($line -match '^([A-Z0-9_]+)=(.*)$') {
      $value = $Matches[2].Trim()
      if ($value.StartsWith('"') -and $value.EndsWith('"')) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      $values[$Matches[1]] = $value
    }
  }

  if (-not $values.API_URL -or -not $values.ANON_KEY -or -not $values.SERVICE_ROLE_KEY) {
    throw "Supabase CLI output is missing required local values. No values were displayed."
  }

  $envPath = Join-Path $repoRoot ".env.local"
  $existing = @{}
  if (Test-Path -LiteralPath $envPath) {
    foreach ($line in Get-Content -LiteralPath $envPath) {
      if ($line -match '^([A-Z0-9_]+)=(.*)$') { $existing[$Matches[1]] = $Matches[2] }
    }
  }

  $existing["NEXT_PUBLIC_SUPABASE_URL"] = "http://127.0.0.1:54321"
  $existing["NEXT_PUBLIC_SUPABASE_ANON_KEY"] = $values.ANON_KEY
  $existing["SUPABASE_URL"] = "http://127.0.0.1:54321"
  $existing["SUPABASE_SERVICE_ROLE_KEY"] = $values.SERVICE_ROLE_KEY
  $existing["WEB_PORT"] = if ($existing.WEB_PORT) { $existing.WEB_PORT } else { "3000" }
  $existing["SUPABASE_INTERNAL_URL"] = "http://host.docker.internal:54321"

  $lines = foreach ($key in ($existing.Keys | Sort-Object)) { "$key=$($existing[$key])" }
  [System.IO.File]::WriteAllLines($envPath, $lines, [System.Text.UTF8Encoding]::new($false))
  if (-not $Quiet) { Write-Host "Local environment prepared in ignored .env.local (credential values hidden)." }
}
finally {
  Pop-Location
}
