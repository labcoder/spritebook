# P0-T4: full UniRig pipeline on one mesh with stage timing + VRAM sampling.
# Calls raw python stages (repo .sh files are thin wrappers; `bash` from
# PowerShell resolves to WSL bash - avoid). bpy-in-process stages (extract,
# merge) can crash 0xC0000005 at interpreter teardown AFTER completing their
# work on Windows - for those stages we validate the expected artifact instead
# of trusting the exit code. That behavior is itself spike evidence for the
# sidecar adapter design. ASCII-only file: PS 5.1 reads BOM-less files as ANSI.
#   .\tools\rig-one.ps1 -Name humanoid -InputGlb assets\humanoid-static.glb -Seed 42
param(
  [Parameter(Mandatory)][string]$Name,
  [Parameter(Mandatory)][string]$InputGlb,
  [int]$Seed = 42
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$unirig = Join-Path $root 'UniRig'
$py = Join-Path $root '.venv\Scripts\python.exe'
$outDir = Join-Path $root 'out'
$workDir = Join-Path $root 'work'
New-Item -ItemType Directory -Force $outDir, $workDir | Out-Null

# stage all inputs under a RELATIVE path inside UniRig so extract's npz mirror
# location (tmp\<relative input sans ext>\raw_data.npz) stays predictable
$jobRel = "jobs/$Name"
$jobDir = Join-Path $unirig $jobRel
New-Item -ItemType Directory -Force $jobDir | Out-Null
Copy-Item (Resolve-Path $InputGlb).Path (Join-Path $jobDir 'in.glb') -Force

$riggedGlb = Join-Path $outDir "$Name-rigged.glb"
$vramCsv = Join-Path $workDir "vram-$Name.csv"
$suffixes = 'obj,fbx,FBX,dae,glb,gltf,vrm'
$stamp = Get-Date -Format 'yyyy_MM_dd_HH_mm_ss'
$AV = -1073741819  # 0xC0000005: bpy teardown crash

$sampler = Start-Process powershell -ArgumentList '-NoProfile', '-File', (Join-Path $PSScriptRoot 'vram-sampler.ps1'), '-Out', $vramCsv -PassThru -WindowStyle Hidden

Push-Location $unirig
$t = [ordered]@{}
try {
  function Invoke-Stage([string]$label, [string[]]$argv, [string]$expectOutput = '') {
    $t0 = Get-Date
    # stdout -> host (keeps it out of the return value); stderr flows natively —
    # do NOT 2>&1 here: under ErrorActionPreference=Stop, redirected native
    # stderr (tqdm!) becomes a terminating NativeCommandError in PS 5.1
    & $py @argv | Out-Host
    $code = $LASTEXITCODE
    if ($code -ne 0) {
      if ($code -eq $AV -and $expectOutput -and (Test-Path $expectOutput)) {
        Write-Host "WARN ${label}: bpy teardown AV (0xC0000005) after successful output - continuing"
      } else {
        throw "$label failed with exit $code"
      }
    }
    $sec = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
    Write-Host "STAGE ${label}: ${sec}s"
    return $sec
  }

  $npz1 = "tmp/$jobRel/in/raw_data.npz"
  $t.extract1 = Invoke-Stage 'extract-1' @('-m', 'src.data.extract',
    '--config=configs/data/quick_inference.yaml', "--require_suffix=$suffixes",
    '--force_override=true', '--num_runs=1', '--id=0', "--time=$stamp",
    '--faces_target_count=50000', "--input=$jobRel/in.glb", '--output_dir=tmp') $npz1
  if (-not (Test-Path $npz1)) { throw "extract-1 produced no npz at $npz1" }

  $t.skeleton = Invoke-Stage 'skeleton' @('run.py',
    '--task=configs/task/quick_inference_skeleton_articulationxl_ar_256.yaml',
    "--seed=$Seed", "--input=$jobRel/in.glb", "--output=$jobRel/skeleton.fbx", '--npz_dir=tmp')
  if (-not (Test-Path "$jobRel/skeleton.fbx")) { throw 'skeleton stage produced no fbx' }

  $npz2 = "tmp/$jobRel/skeleton/raw_data.npz"
  $t.extract2 = Invoke-Stage 'extract-2' @('-m', 'src.data.extract',
    '--config=configs/data/quick_inference.yaml', "--require_suffix=$suffixes",
    '--force_override=true', '--num_runs=1', '--id=0', "--time=$stamp",
    '--faces_target_count=50000', "--input=$jobRel/skeleton.fbx", '--output_dir=tmp') $npz2
  if (-not (Test-Path $npz2)) { throw "extract-2 produced no npz at $npz2" }

  $t.skin = Invoke-Stage 'skin' @('run.py',
    '--task=configs/task/quick_inference_unirig_skin.yaml',
    "--seed=$Seed", "--input=$jobRel/skeleton.fbx", "--output=$jobRel/skin.fbx",
    '--npz_dir=tmp', '--data_name=raw_data.npz')
  if (-not (Test-Path "$jobRel/skin.fbx")) { throw 'skin stage produced no fbx' }

  $t.merge = Invoke-Stage 'merge' @('-m', 'src.inference.merge',
    "--require_suffix=$suffixes", '--num_runs=1', '--id=0',
    "--source=$jobRel/skin.fbx", "--target=$jobRel/in.glb", "--output=$riggedGlb") $riggedGlb
  if (-not (Test-Path $riggedGlb)) { throw 'merge produced no rigged glb' }
} finally {
  Pop-Location
  Remove-Item "$vramCsv.sampling" -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800
}

$peak = (Import-Csv $vramCsv | Measure-Object -Property used_mib -Maximum).Maximum
$t.peakVramMiB = [int]$peak
$t.seed = $Seed
$t.input = $InputGlb
$t | ConvertTo-Json | Out-File -Encoding utf8 (Join-Path $workDir "$Name-timings.json")
Write-Output ("DONE {0}: peak VRAM {1} MiB -> {2}" -f $Name, $peak, $riggedGlb)
