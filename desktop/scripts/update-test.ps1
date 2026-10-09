# Auto-update test on a real Windows machine (the release workflow runs it):
# an older copy (0.0.1) is installed, started, finds the new version on a local web server,
# downloads it, backs up its database, installs the new version silently and starts it.
# Run from desktop/ after `npm run dist:win` (release/Warehouse-IMS-Setup.exe + latest.yml).
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$version = node -p "require('./app/package.json').version"

Write-Host "== Build an older copy (0.0.1) from the same files"
node -e "const f='app/package.json';const p=require('./'+f);p.version='0.0.1';require('fs').writeFileSync(f,JSON.stringify(p,null,2))"
$env:IMS_BUILD_OUTPUT = 'release-old'
node scripts/build-win.cjs
if ($LASTEXITCODE -ne 0) { throw 'old build failed' }
Remove-Item Env:IMS_BUILD_OUTPUT
node -e "const f='app/package.json';const p=require('./'+f);p.version='$version';require('fs').writeFileSync(f,JSON.stringify(p,null,2))"

function Get-Installed {
  Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like 'Warehouse IMS*' } | Select-Object -First 1
}

Write-Host "== Install 0.0.1 silently"
Start-Process -FilePath 'release-old/Warehouse-IMS-Setup.exe' -ArgumentList '/S' -Wait
$installed = Get-Installed
if (-not $installed -or $installed.DisplayVersion -ne '0.0.1') { throw "0.0.1 is not installed: $($installed | Out-String)" }
$exe = Join-Path $installed.InstallLocation 'Warehouse IMS.exe'
Write-Host "Installed 0.0.1 at $exe"

Write-Host "== Serve $version on http://127.0.0.1:8765/"
New-Item -ItemType Directory -Force feed | Out-Null
Copy-Item release/Warehouse-IMS-Setup.exe, release/latest.yml feed/
Get-Content feed/latest.yml
$web = Start-Process -FilePath python -ArgumentList '-m', 'http.server', '8765', '--bind', '127.0.0.1', '--directory', 'feed' -PassThru -WindowStyle Hidden

Write-Host "== Start 0.0.1 (this-PC-only mode) and wait for it to update itself"
$profileDir = Join-Path $env:APPDATA 'Warehouse IMS'
New-Item -ItemType Directory -Force $profileDir | Out-Null
[IO.File]::WriteAllText((Join-Path $profileDir 'config.json'), '{"mode":"local"}')
$env:IMS_UPDATE_URL = 'http://127.0.0.1:8765/'
$env:IMS_UPDATE_AUTO_INSTALL = '1'
Start-Process -FilePath $exe
$deadline = (Get-Date).AddMinutes(8)
do {
  Start-Sleep -Seconds 5
  $now = (Get-Installed).DisplayVersion
  Write-Host "installed version: $now"
} until ($now -eq $version -or (Get-Date) -gt $deadline)
Start-Sleep -Seconds 10

Write-Host "== App log"
$log = Join-Path $profileDir 'logs/main.log'
if (Test-Path $log) { Get-Content $log | Select-Object -Last 60 }
Get-Process | Where-Object { $_.ProcessName -like 'Warehouse IMS*' } | Stop-Process -Force -ErrorAction SilentlyContinue
Stop-Process -Id $web.Id -Force -ErrorAction SilentlyContinue

if ($now -ne $version) { throw "The installed copy did not update itself to $version (installed: $now)" }
$backups = Get-ChildItem (Join-Path $profileDir 'data/backups') -Filter '*_before-update.db' -ErrorAction SilentlyContinue
if (-not $backups) { throw 'No database backup was taken before the update' }
Write-Host "OK: 0.0.1 updated itself to $version; backup before the update: $($backups[0].Name)"
