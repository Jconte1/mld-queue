param(
    [string]$Registry = "mldnotificationsacrprod",
    [string]$Tag = ("customer-state-" + (Get-Date -Format yyyyMMddHHmmss)),
    [switch]$PrepareOnly
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$buildRoot = Join-Path $env:LOCALAPPDATA "mld-queue-worker-builds"
$context = Join-Path $buildRoot ([Guid]::NewGuid().ToString("N"))
if ($Registry -notmatch '^[a-zA-Z0-9]+$' -or $Tag -notmatch '^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$') {
    throw "Invalid registry name or image tag"
}
$image = "${Registry}.azurecr.io/mld-delivery-queue-worker:${Tag}"
$sources = @(
    "worker/Dockerfile",
    "worker/package.json",
    "worker/package-lock.json",
    "worker/tsconfig.json",
    "worker/src",
    "prisma/schema.prisma"
)

# Explicit allowlist prevents secrets, node_modules junctions, and Git history
# from reaching the ACR uploader, regardless of its ignore-file behavior.
foreach ($relative in $sources) {
    $source = Get-Item -LiteralPath (Join-Path $repo $relative)
    $entries = @($source)
    if ($source.PSIsContainer) { $entries += @(Get-ChildItem -LiteralPath $source.FullName -Recurse -Force) }
    foreach ($entry in $entries) {
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Build source contains a junction/symlink: $($entry.FullName)"
        }
    }
}

foreach ($relative in $sources) {
    $destination = Join-Path $context $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $repo $relative) -Destination $destination -Recurse
}

$files = @(Get-ChildItem -LiteralPath $context -File -Recurse -Force)
Write-Host "Build context: $context"
Write-Host "Files: $($files.Count); bytes: $(($files | Measure-Object -Property Length -Sum).Sum)"
Write-Host "Image: $image"
if ($PrepareOnly) { return }

az acr build --registry $Registry --image "mld-delivery-queue-worker:${Tag}" --file worker/Dockerfile $context
if ($LASTEXITCODE -ne 0) { throw "ACR build failed. No deployment was attempted. Context retained: $context" }
Write-Host "Build/push succeeded. No Container App was updated or started."

$resolvedContext = (Resolve-Path -LiteralPath $context).Path
$resolvedRoot = (Resolve-Path -LiteralPath $buildRoot).Path
if ((Split-Path -Parent $resolvedContext) -ne $resolvedRoot -or
    (Split-Path -Leaf $resolvedContext) -notmatch '^[0-9a-f]{32}$') {
    throw "Refusing build-context cleanup outside the dedicated build directory"
}
Remove-Item -LiteralPath $resolvedContext -Recurse -Force
