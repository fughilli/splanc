# Build the Splanc Bridge Flasher on Windows (.exe installer, NSIS).
#   $env:FLASHER_VERSION = "1.2.3"; powershell -ExecutionPolicy Bypass -File pi\bridge\flasher\packaging\build_app.ps1
# Steps: unit tests -> freeze the sidecar (PyInstaller) -> electron-builder.
# Signing: set CSC_LINK (base64 .pfx) + CSC_KEY_PASSWORD to Authenticode-sign;
# unsigned otherwise (SmartScreen: "More info" > "Run anyway"; docs/pi-bridge.md).
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$flasher = (Resolve-Path "$here\..").Path
$ver = if ($env:FLASHER_VERSION) { $env:FLASHER_VERSION } else { "0.0.0-dev" }

Write-Host "==> version $ver"
"{`"version`": `"$ver`"}" | Out-File -Encoding ascii "$flasher\version.json"

Write-Host "==> python deps + unit tests"
python -m pip install --disable-pip-version-check -q -r "$here\requirements.txt"
if ($LASTEXITCODE -ne 0) { throw "pip install failed" }
Push-Location $flasher
python -m pytest -q -p no:cacheprovider tests
if ($LASTEXITCODE -ne 0) { throw "unit tests failed" }
Pop-Location

Write-Host "==> freeze the sidecar"
python -m PyInstaller --noconfirm --distpath "$flasher\dist" --workpath "$flasher\.pyibuild" "$here\sidecar.spec"
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }
python "$here\smoke_sidecar.py" "$flasher\dist\splanc-flasher-sidecar\splanc-flasher-sidecar.exe"
if ($LASTEXITCODE -ne 0) { throw "the frozen sidecar smoke test failed" }

Write-Host "==> electron-builder"
Push-Location "$flasher\electron"
npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
npm version $ver --no-git-tag-version --allow-same-version | Out-Null
# CI passes the signing variables even when the secrets don't exist; an EMPTY
# CSC_LINK makes electron-builder try to read the project dir as a certificate.
foreach ($v in "CSC_LINK", "CSC_KEY_PASSWORD") {
  if (-not [Environment]::GetEnvironmentVariable($v)) { Remove-Item "Env:$v" -ErrorAction SilentlyContinue }
}
if (-not $env:CSC_LINK) {
  Write-Host "    no signing certificate: unsigned build"
  $env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
}
npx --no-install electron-builder --publish never --win
if ($LASTEXITCODE -ne 0) { throw "electron-builder failed" }
Pop-Location

Write-Host "==> artifacts"
Get-ChildItem "$flasher\electron\dist" -Filter *.exe | Select-Object Name, Length
