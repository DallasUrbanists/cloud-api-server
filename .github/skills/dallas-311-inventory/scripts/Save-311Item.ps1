param(
    [Parameter(Mandatory = $true)][string]$Slug,
    [Parameter(Mandatory = $true)][string]$SourcePath
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../../..')).Path
$dataDirectory = (Resolve-Path (Join-Path $repoRoot 'data/311')).Path
if ($Slug -notmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$') {
    throw 'Slug must contain only lowercase letters, digits, and hyphens.'
}

$destination = Join-Path $dataDirectory ($Slug + '.json')
if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) {
    throw "Expected an existing seeded item: $destination"
}
$source = (Resolve-Path -LiteralPath $SourcePath).Path
$prior = Get-Content -Raw -LiteralPath $destination | ConvertFrom-Json
$incomingText = Get-Content -Raw -LiteralPath $source
if ([string]::IsNullOrWhiteSpace($incomingText) -or $incomingText.Trim() -eq 'null') {
    throw 'Refusing an empty or null JSON item.'
}
$incoming = $incomingText | ConvertFrom-Json
if ($null -eq $incoming -or $incoming -is [array]) {
    throw 'Expected one JSON object.'
}
if ($incoming.title -cne $prior.title) {
    throw 'Item title differs from the existing seeded file.'
}
if ($incoming.detailsForm.status -notin @('conditional_paths_explored', 'instructions_only', 'partial')) {
    throw 'Details status is not a recognized capture result.'
}
if ($incoming.detailsForm.observedQuestions -isnot [array]) {
    throw 'detailsForm.observedQuestions must be a JSON array, not an object wrapper.'
}
if ($incoming.detailsForm.status -eq 'conditional_paths_explored' -and
    ($incoming.requestThisService -ne $true -or $incoming.detailsForm.observedQuestions.Count -eq 0)) {
    throw 'Completed online forms need a request button and observed questions.'
}
if ($incoming.detailsForm.status -eq 'instructions_only' -and
    ($incoming.requestThisService -ne $false -or [string]::IsNullOrWhiteSpace($incoming.instructions))) {
    throw 'Instruction-only items need observed instructions and no request button.'
}

$normalized = $incoming | ConvertTo-Json -Depth 100
if ($normalized.Trim() -eq 'null') { throw 'Refusing null serialization.' }
$temporary = $destination + '.tmp'
try {
    [System.IO.File]::WriteAllText($temporary, $normalized, (New-Object System.Text.UTF8Encoding($false)))
    $null = Get-Content -Raw -LiteralPath $temporary | ConvertFrom-Json
    [System.IO.File]::Replace($temporary, $destination, $destination + '.bak')
    Write-Output $destination
}
finally {
    if (Test-Path -LiteralPath $temporary) {
        Remove-Item -LiteralPath $temporary -Force
    }
}
