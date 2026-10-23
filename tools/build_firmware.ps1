param (
    [string]$Fqbn = 'esp8266:esp8266:nodemcuv2',
    [string]$Output = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $root 'tools\.tools'
$cli = Join-Path $tools 'arduino-cli.exe'
if (-not (Test-Path $cli)) {
    throw "arduino-cli 未安装，请先运行 tools/install_toolchain.ps1"
}

$env:ARDUINO_DIRECTORIES_DATA = Join-Path $tools 'arduino-data'
$env:ARDUINO_DIRECTORIES_USER = Join-Path $tools 'arduino-user'
$env:ARDUINO_DIRECTORIES_DOWNLOADS = Join-Path $tools 'arduino-downloads'
$env:ARDUINO_LIBRARY_ENABLE_UNSAFE_INSTALL = 'true'

$build = Join-Path $tools ('build-' + ($Fqbn -replace '[:/]', '-'))
New-Item -ItemType Directory -Force -Path $build | Out-Null

& $cli compile --fqbn $Fqbn --output-dir $build --warnings all (Join-Path $root 'firmware\wol8266')
if ($LASTEXITCODE -ne 0) { throw "compile failed" }

$bin = Get-ChildItem -Path $build -Filter 'wol8266.ino.bin' -File -ErrorAction Stop | Select-Object -First 1
$destDir = Join-Path $root 'firmware\bin'
New-Item -ItemType Directory -Force -Path $destDir | Out-Null
$dest = if ($Output) { $Output } else { Join-Path $destDir 'wol8266-nodemcuv2-4m.bin' }
Copy-Item -Force $bin.FullName $dest
$size = (Get-Item $dest).Length
Write-Host ("built {0} ({1:N0} bytes)" -f $dest, $size)
