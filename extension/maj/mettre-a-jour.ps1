# Atelier MEG - mise a jour automatique de l'extension (coquille) depuis GitHub Pages.
# Lance par la tache planifiee "Atelier MEG - mise a jour" (voir activer-maj-auto.cmd),
# ou a la main (clic droit > Executer avec PowerShell).
# Si la version publiee est plus recente que celle du dossier, le zip publie est extrait
# par-dessus le dossier de l'extension. Chrome recharge ensuite l'extension tout seul.
# Publication supprimee ou injoignable : rien n'est modifie.

$ErrorActionPreference = 'Stop'
$Url    = 'https://chassard67.github.io/atelier-meg/atelier-meg-extension.zip'
$ExtDir = Split-Path -Parent $PSScriptRoot
$Log    = Join-Path $PSScriptRoot 'maj.log'

function Write-Log($msg) {
  $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $msg
  try {
    $old = @()
    if (Test-Path $Log) { $old = Get-Content $Log -Tail 199 }
    Set-Content -Path $Log -Value ($old + $line) -Encoding UTF8
  } catch {}
}

function Get-Ver($manifestPath) {
  return [version]((Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json).version)
}

$tmp = Join-Path $env:TEMP ('atelier-meg-maj-' + [guid]::NewGuid().ToString('N'))
try {
  if (-not (Test-Path (Join-Path $ExtDir 'manifest.json'))) { throw "manifest.json introuvable dans $ExtDir" }
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $zip = Join-Path $tmp 'ext.zip'
  Invoke-WebRequest -Uri ($Url + '?t=' + [DateTime]::UtcNow.Ticks) -OutFile $zip -UseBasicParsing -TimeoutSec 60
  $unz = Join-Path $tmp 'ext'
  Expand-Archive -Path $zip -DestinationPath $unz -Force
  $new = Get-Ver (Join-Path $unz 'manifest.json')
  $cur = Get-Ver (Join-Path $ExtDir 'manifest.json')
  if ($new -gt $cur) {
    # manifest.json en DERNIER : Chrome ne recharge l'extension qu'une fois tous les autres fichiers en place.
    $mf = Join-Path $unz 'manifest.json'
    Move-Item $mf (Join-Path $tmp 'manifest.json')
    & robocopy.exe $unz $ExtDir /E /R:2 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy a echoue (code $LASTEXITCODE)" }
    Copy-Item (Join-Path $tmp 'manifest.json') (Join-Path $ExtDir 'manifest.json') -Force
    Write-Log "Mise a jour $cur -> $new installee dans $ExtDir"
  } else {
    Write-Log "A jour ($cur)"
  }
} catch {
  Write-Log ('Echec : ' + $_.Exception.Message)
} finally {
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}
