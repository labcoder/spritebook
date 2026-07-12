# P0-T4: sample GPU memory + utilization to CSV while a rig job runs.
#   .\tools\vram-sampler.ps1 -Out work\vram-humanoid.csv
# Stop with Ctrl+C or by deleting the .sampling sentinel next to the CSV.
param([string]$Out = "work\vram.csv", [int]$IntervalMs = 500)
$sentinel = "$Out.sampling"
New-Item -ItemType File -Force $sentinel | Out-Null
"ts,used_mib,total_mib,util_pct" | Out-File -Encoding utf8 $Out
while (Test-Path $sentinel) {
  $q = nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits
  $parts = $q -split ',\s*'
  "$([DateTime]::UtcNow.ToString('o')),$($parts[0]),$($parts[1]),$($parts[2])" | Out-File -Encoding utf8 -Append $Out
  Start-Sleep -Milliseconds $IntervalMs
}
