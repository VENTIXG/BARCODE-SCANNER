# Auto-update test on a real Windows machine (the release workflow runs it), in this-PC-only mode:
#  1. the published 1.2.0 (SQLite) is installed and started; it finds the new version on a local
#     web server, backs up its database, installs the new version silently, and the new version
#     copies the data into its built-in PostgreSQL;
#  2. an older copy (0.0.1) built from these files (PostgreSQL) does the same: the way every
#     later update goes.
# Run from desktop/ after `npm run dist:win` (release/Warehouse-IMS-Setup.exe + latest.yml).
# IMS_TEST_OLD: the published version for step 1 (default 1.2.0; empty: skip step 1).
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$version = node -p "require('./app/package.json').version"
$published = if ($null -ne $env:IMS_TEST_OLD) { $env:IMS_TEST_OLD } else { '1.2.0' }
$profileDir = Join-Path $env:APPDATA 'Warehouse IMS'
$dataDir = Join-Path $profileDir 'data'
$log = Join-Path $profileDir 'logs/main.log'

function Get-Installed {
  Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like 'Warehouse IMS*' } | Select-Object -First 1
}

# The program: from InstallLocation, else from the icon path, else search the per-user programs folder.
function Get-Exe($installed) {
  $exe = $null
  if ($installed.InstallLocation) { $exe = Join-Path $installed.InstallLocation 'Warehouse IMS.exe' }
  if (-not $exe -or -not (Test-Path $exe)) {
    $icon = ("$($installed.DisplayIcon)" -replace ',\d+$', '') -replace '"', ''
    if ($icon -and (Test-Path $icon)) { $exe = $icon }
  }
  if (-not $exe -or -not (Test-Path $exe)) {
    $exe = (Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs') -Recurse -Filter 'Warehouse IMS.exe' -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
  }
  if (-not $exe -or -not (Test-Path $exe)) { throw 'The installed program was not found' }
  return $exe
}

function Install-Silently($setup, $expected) {
  Write-Host "== Install $expected silently"
  Start-Process -FilePath $setup -ArgumentList '/S' -Wait
  $installed = Get-Installed
  if (-not $installed -or $installed.DisplayVersion -ne $expected) { throw "$expected is not installed: $($installed | Out-String)" }
  $installed | Format-List DisplayName, DisplayVersion, InstallLocation | Out-String | Write-Host
  return Get-Exe $installed
}

function Stop-App {
  Get-Process | Where-Object { $_.ProcessName -like 'Warehouse IMS*' } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
}

# Start the installed copy and wait until it has updated itself and the new version runs.
function Wait-SelfUpdate($exe, $from) {
  Write-Host "== Start $from and wait for it to update itself to $version"
  if (Test-Path $log) { Remove-Item $log }
  Start-Process -FilePath $exe
  $deadline = (Get-Date).AddMinutes(8)
  do {
    Start-Sleep -Seconds 5
    $now = (Get-Installed).DisplayVersion
    Write-Host "installed version: $now"
  } until ($now -eq $version -or (Get-Date) -gt $deadline)
  # The new version starts by itself after the installation (the second "Server running" in the log).
  $deadline = (Get-Date).AddMinutes(2)
  do { Start-Sleep -Seconds 3 } until (((Test-Path $log) -and @(Select-String -Path $log -Pattern 'Server running on').Count -ge 2) -or (Get-Date) -gt $deadline)
  Start-Sleep -Seconds 5
  Write-Host "== App log"
  if (Test-Path $log) { Get-Content $log | Select-Object -Last 60 }
  Stop-App
  if ($now -ne $version) { throw "$from did not update itself to $version (installed: $now)" }
}

Write-Host "== Serve $version on http://127.0.0.1:8765/"
New-Item -ItemType Directory -Force feed | Out-Null
Copy-Item release/Warehouse-IMS-Setup.exe, release/latest.yml feed/
Get-Content feed/latest.yml
$web = Start-Process -FilePath python -ArgumentList '-m', 'http.server', '8765', '--bind', '127.0.0.1', '--directory', 'feed' -PassThru -WindowStyle Hidden
New-Item -ItemType Directory -Force $profileDir | Out-Null
[IO.File]::WriteAllText((Join-Path $profileDir 'config.json'), '{"mode":"local"}')
$env:IMS_UPDATE_URL = 'http://127.0.0.1:8765/'
$env:IMS_UPDATE_AUTO_INSTALL = '1'

try {
  if ($published) {
    Write-Host "== 1. The published $published (SQLite) updates itself to $version (PostgreSQL)"
    Invoke-WebRequest "https://github.com/ventixg/barcode-scanner/releases/download/v$published/Warehouse-IMS-Setup.exe" -OutFile 'published-setup.exe'
    $exe = Install-Silently 'published-setup.exe' $published
    Wait-SelfUpdate $exe $published
    if (-not (Test-Path (Join-Path $dataDir 'inventory.db'))) { throw "$published did not create its database (inventory.db)" }
    if (-not (Get-ChildItem (Join-Path $dataDir 'backups') -Filter '*_before-update.db' -ErrorAction SilentlyContinue)) { throw "$published took no backup before the update" }
    if (-not (Test-Path (Join-Path $dataDir 'pgdata/PG_VERSION'))) { throw "$version did not create its database (pgdata)" }
    if (-not (Select-String -Path $log -Pattern '\[import\] Copied the data of the previous version' -Quiet)) { throw "$version did not copy the data of $published" }
    Write-Host "OK: $published updated itself to $version and its data was copied into PostgreSQL"
  }

  Write-Host "== 2. An older copy (0.0.1) built from the same files updates itself"
  node -e "const f='app/package.json';const p=require('./'+f);p.version='0.0.1';require('fs').writeFileSync(f,JSON.stringify(p,null,2))"
  $env:IMS_BUILD_OUTPUT = 'release-old'
  node scripts/build-win.cjs
  if ($LASTEXITCODE -ne 0) { throw 'old build failed' }
  Remove-Item Env:IMS_BUILD_OUTPUT
  node -e "const f='app/package.json';const p=require('./'+f);p.version='$version';require('fs').writeFileSync(f,JSON.stringify(p,null,2))"
  $exe = Install-Silently 'release-old/Warehouse-IMS-Setup.exe' '0.0.1'
  Wait-SelfUpdate $exe '0.0.1'
  $backups = Get-ChildItem (Join-Path $dataDir 'backups') -Filter '*_before-update.json.gz' -ErrorAction SilentlyContinue
  if (-not $backups) { throw 'No database backup was taken before the update' }
  Write-Host "OK: 0.0.1 updated itself to $version; backup before the update: $($backups[0].Name)"
} finally {
  Stop-App
  Stop-Process -Id $web.Id -Force -ErrorAction SilentlyContinue
}
