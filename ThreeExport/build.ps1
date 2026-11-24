# Builds the three.js viewer template and the exporter DLLs, then copies the DLLs to
# the pyRevit button (PBTools.tab\WIP.panel\Export3DHTML.pushbutton\bin\<framework>).
#
#   .\build.ps1          build and copy
#   .\build.ps1 -Test    also run the C# tests, the glTF checks and the viewer tests
#
# Needs Node.js and the .NET SDK (8 or newer). The DLLs are not locked by Revit
# (the button loads them from bytes), so this can run while Revit is open.
param([switch]$Test)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$button = Join-Path $root '..\PBTools.tab\WIP.panel\Export3DHTML.pushbutton\bin'

function Invoke-Step([string]$what, [scriptblock]$cmd) {
    Write-Host "== $what" -ForegroundColor Cyan
    # npm and dotnet write notices to stderr; judge them by their exit code only
    $ErrorActionPreference = 'Continue'
    & $cmd
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($code -ne 0) { throw "$what failed (exit code $code)" }
}

Push-Location (Join-Path $root 'viewer')
try {
    if (-not (Test-Path 'node_modules')) { Invoke-Step 'npm ci' { npm ci --no-audit --no-fund } }
    Invoke-Step 'viewer template' { node build.mjs }
} finally { Pop-Location }

$project = Join-Path $root 'src\RevitThreeExport\RevitThreeExport.csproj'
Invoke-Step 'exporter DLLs' { dotnet build $project -c Release -nologo -v minimal }

foreach ($tfm in 'net48', 'net8.0-windows') {
    $from = Join-Path $root "src\RevitThreeExport\bin\Release\$tfm\RevitThreeExport.dll"
    $to = Join-Path $button $tfm
    New-Item -ItemType Directory -Force $to | Out-Null
    Copy-Item $from $to -Force
    Write-Host ("   {0,-15} {1:N0} KB" -f $tfm, ((Get-Item $from).Length / 1KB))
}

if ($Test) {
    Invoke-Step 'C# tests' { dotnet test (Join-Path $root 'tests\RevitThreeExport.Tests') -nologo -v minimal }
    Push-Location (Join-Path $root 'viewer')
    try { Invoke-Step 'glTF and viewer tests' { npm test } } finally { Pop-Location }
}
Write-Host 'Done.' -ForegroundColor Green
