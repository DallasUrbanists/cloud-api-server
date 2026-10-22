$ErrorActionPreference = 'Stop'

if (-not $env:FIRESTORE_EMULATOR_HOST) {
  throw 'FIRESTORE_EMULATOR_HOST must point to a running loopback Firestore emulator (for example 127.0.0.1:8085).'
}

$emulatorUrl = if ($env:FIRESTORE_EMULATOR_HOST -match '^https?://') { [Uri]$env:FIRESTORE_EMULATOR_HOST } else { [Uri]"http://$($env:FIRESTORE_EMULATOR_HOST)" }
$hostName = $emulatorUrl.Host.Trim('[', ']')
if ($hostName -notin @('localhost', '127.0.0.1', '::1')) {
  throw 'The presentation smoke harness refuses a non-loopback Firestore endpoint.'
}

$client = [System.Net.Sockets.TcpClient]::new()
try {
  $client.Connect($hostName, $emulatorUrl.Port)
} catch {
  throw "The Firestore emulator at $($emulatorUrl.Host):$($emulatorUrl.Port) is not reachable. No server was started."
} finally {
  $client.Dispose()
}

$suffix = [Guid]::NewGuid().ToString('N').Substring(0, 12)
$env:GOOGLE_CLOUD_PROJECT = "demo-presentation-ws-$($suffix.Substring(0, 8))"
$env:PUBLIC_IMPROVEMENTS_DB = '(default)'
$env:PRESENTATION_HARNESS_NAMESPACE = "presentation-ws-smoke-$suffix"
$env:GOOGLE_APPLICATION_CREDENTIALS = $null
$env:PRESENTATION_ENABLED = 'true'
$env:PRESENTATION_WEBSOCKET_ENABLED = 'true'
$env:PRESENTATION_HARNESS_HOST = '127.0.0.1'
$env:PRESENTATION_HARNESS_PORT = '8187'

node node_modules/tsx/dist/cli.mjs src/scripts/presentationWebSocketHarness.ts
exit $LASTEXITCODE
