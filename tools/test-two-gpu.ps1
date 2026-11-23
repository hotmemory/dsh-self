# 测两张卡是不是各干各的。
# 用法：powershell -ExecutionPolicy Bypass -File test-two-gpu.ps1
#
# 做四件事：
#   1. 报两张卡的现状
#   2. 让 AMD（11436）跑一句话，看 V100 有没有动
#   3. 让 mem suggest 打一次标签（默认走 AMD），再看一次
#   4. 结论：AMD 在干活 / 没在干活

$ErrorActionPreference = 'Continue'
$exe = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
$mem = 'C:\Users\meigu\dsh-self\mem\mem.mjs'
$node = 'D:\DeepSeek\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path $node)) { $node = 'node' }

function V100 {
  $v = & 'C:\Windows\System32\nvidia-smi.exe' --query-gpu=memory.used --format=csv,noheader 2>$null
  if (-not $v) { return -1 }
  return [int](($v -replace '[^0-9]', ''))
}

function AmdMb {
  $c = Get-Counter '\GPU Adapter Memory(*)\Dedicated Usage' -ErrorAction SilentlyContinue
  if (-not $c) { return -1 }
  # AMD 的 LUID 各机不同，取"不是 V100 那个"的最大值：这里用两片里较大的那片当参考不稳定，
  # 所以改成：报所有片，调用方自己比。
  return ($c.CounterSamples | ForEach-Object { [math]::Round($_.CookedValue / 1MB) }) -join '/'
}

function Show($label) {
  "  {0,-16} V100={1,5} MiB   GPU片={2}" -f $label, (V100), (AmdMb)
}

"=== 1. 现在的样子 ==="
Show '起始'

"=== 2. 看两个实例开没开 ==="
foreach ($port in 11434, 11436) {
  try {
    $r = Invoke-WebRequest "http://127.0.0.1:$port/api/tags" -TimeoutSec 5 -UseBasicParsing
    "  $port : 在（HTTP $($r.StatusCode)）"
  } catch {
    "  $port : 不在"
  }
}

"=== 3. 让 AMD 跑一句 ==="
$v0 = V100
try {
  $body = @{ model = 'qwen2.5:3b'; prompt = '只回两个字：在的'; stream = $false } | ConvertTo-Json -Compress
  $r = Invoke-RestMethod 'http://127.0.0.1:11436/api/generate' -Method POST `
    -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 300
  "  回答：$($r.response.Trim())"
} catch {
  "  11436 调用失败：$($_.Exception.Message)"
}
Start-Sleep -Seconds 2
Show 'AMD 跑完后'
$v1 = V100
if ($v1 -eq $v0) { "  → V100 没动（好：模型没落在它身上）" } else { "  → V100 涨了 $($v1 - $v0) MiB（模型可能落在 V100 上了）" }

"=== 4. 让 mem suggest 打一次标签（默认走 AMD）==="
$v2 = V100
& $node $mem suggest m-20261123-01 2>&1 | Select-Object -First 2 | ForEach-Object { "  $_" }
Start-Sleep -Seconds 2
$v3 = V100
if ($v3 -eq $v2) { "  → V100 没动" } else { "  → V100 涨了 $($v3 - $v2) MiB" }

"=== 5. 怎么读这个结果 ==="
@'
  · 11436 在、AMD 跑完 V100 没动  → 分工成立
  · 只有一片 GPU 的数字在涨      → 说明只有一张卡在干活，另一张闲着
  · 11436 不在                  → 先跑 tools\start-ollama-amd.ps1
  · 出现「AMD 实例连不上，退回主实例」→ AMD 实例没开，活退给了 V100
'@ -split "`n" | ForEach-Object { "  $_" }
