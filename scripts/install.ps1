# Page Capture - fetch a release and unpack it into a stable folder (Windows).
#
#   iwr https://raw.githubusercontent.com/dummygtr-ux/page-capture-clean/main/scripts/install.ps1 -useb | iex
#   .\install.ps1 -From .\Downloads\page-capture-chrome.zip
param(
  [string]$From = "",
  [string]$To = "$env:LOCALAPPDATA\PageCapture",
  [string]$Repo = $env:PAGECAPTURE_REPO
)
$ErrorActionPreference = "Stop"
if (-not $Repo) { $Repo = "dummygtr-ux/page-capture-clean" }

$tmp = Join-Path $env:TEMP ("page-capture-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$zip = Join-Path $tmp "page-capture.zip"

try {
  if ($From) {
    if ($From -match '^https?://') {
      Write-Host "downloading $From"
      Invoke-WebRequest -Uri $From -OutFile $zip -UseBasicParsing
    } else {
      if (-not (Test-Path $From)) { throw "no such file: $From" }
      Copy-Item $From $zip
    }
  } else {
    $url = "https://github.com/$Repo/releases/latest/download/page-capture-chrome.zip"
    Write-Host "downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  }

  if (Test-Path $To) { Remove-Item $To -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $To | Out-Null
  Expand-Archive -Path $zip -DestinationPath $To -Force

  if (-not (Test-Path (Join-Path $To "manifest.json"))) {
    throw "manifest.json is not at the top of $To - point the browser at the folder that contains it"
  }

  Write-Host ""
  Write-Host "Installed to: $To" -ForegroundColor Green
  Write-Host ""
  Write-Host "Now, once:"
  Write-Host "  1. open  edge://extensions   (or chrome://extensions)"
  Write-Host "  2. turn on 'Developer mode'"
  Write-Host "  3. 'Load unpacked' -> select  $To"
  Write-Host "  4. set the shortcut at  edge://extensions/shortcuts  (avoid Alt+Shift: it switches keyboard layouts)"
  Write-Host ""
  Write-Host "Keep that folder where it is; moving it breaks the extension."
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
