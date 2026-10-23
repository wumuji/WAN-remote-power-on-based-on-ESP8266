$ErrorActionPreference = 'Stop'

$root  = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $root 'tools\.tools'
New-Item -ItemType Directory -Force -Path $tools | Out-Null
$log = Join-Path $tools 'install.log'
function Log($msg) {
    $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Write-Host $line
    Add-Content -Path $log -Value $line
}
function Run($exe, [string[]]$arguments) {
    Log ("RUN {0} {1}" -f $exe, ($arguments -join ' '))
    & $exe @arguments
    if ($LASTEXITCODE -ne 0) { throw ("command failed ({0}): {1} {2}" -f $LASTEXITCODE, $exe, ($arguments -join ' ')) }
}

$cli = Join-Path $tools 'arduino-cli.exe'
if (-not (Test-Path $cli)) {
    Log 'downloading arduino-cli'
    $zip = Join-Path $tools 'arduino-cli.zip'
    Run 'curl.exe' @('-L', '--fail', '--retry', '3', '--max-time', '300', '-o', $zip,
        'https://downloads.arduino.cc/arduino-cli/arduino-cli_latest_Windows_64bit.zip')
    Expand-Archive -Force -Path $zip -DestinationPath $tools
}
Run $cli @('version')

$data  = Join-Path $tools 'arduino-data'
$user  = Join-Path $tools 'arduino-user'
$dl    = Join-Path $tools 'arduino-downloads'
New-Item -ItemType Directory -Force -Path $data, $user, $dl | Out-Null
$env:ARDUINO_DIRECTORIES_DATA      = $data
$env:ARDUINO_DIRECTORIES_USER      = $user
$env:ARDUINO_DIRECTORIES_DOWNLOADS = $dl

$indexUrl = 'https://arduino.esp8266.com/stable/package_esp8266com_index.json'
Run $cli @('core', 'update-index', '--additional-urls', $indexUrl)
Run $cli @('core', 'install', 'esp8266:esp8266@3.1.2', '--additional-urls', $indexUrl)
Run $cli @('lib', 'install', 'PubSubClient@2.8.0')
Run $cli @('lib', 'install', 'ArduinoJson@7.2.1')
Run $cli @('core', 'list')
Run $cli @('lib', 'list')
Log 'TOOLCHAIN READY'
