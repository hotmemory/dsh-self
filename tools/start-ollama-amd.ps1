# 用 AMD 那张卡另开一个 ollama 实例（端口 11436）。
# 主实例 11434 继续走 V100/CUDA，两张卡各干各的，不抢显存。
#
# 三个环境变量缺一不可（2026-11-24 实测）：
#   CUDA_VISIBLE_DEVICES=-1   把 NVIDIA 藏起来，否则 ollama 永远优先选 CUDA
#   OLLAMA_VULKAN=1           打开 Vulkan 后端
#   GGML_VK_VISIBLE_DEVICES=0 钉在 AMD 那张（0 是 Vulkan 的枚举顺序）
#
# 用法：powershell -ExecutionPolicy Bypass -File start-ollama-amd.ps1

$env:OLLAMA_HOST = '127.0.0.1:11436'
$env:CUDA_VISIBLE_DEVICES = '-1'
$env:OLLAMA_VULKAN = '1'
$env:GGML_VK_VISIBLE_DEVICES = '0'
$env:OLLAMA_CONTEXT_LENGTH = '4096'
$env:OLLAMA_KEEP_ALIVE = '5m'

$exe = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
if (-not (Test-Path $exe)) { Write-Error "找不到 ollama.exe：$exe"; exit 1 }

Start-Process -FilePath $exe -ArgumentList 'serve' -WindowStyle Hidden
Start-Sleep -Seconds 6
try {
  $r = Invoke-WebRequest 'http://127.0.0.1:11436/api/tags' -TimeoutSec 10 -UseBasicParsing
  Write-Output "AMD/Vulkan 实例已在 11436 启动（HTTP $($r.StatusCode)）"
} catch {
  Write-Output "启动后连不上 11436，检查 ollama 是否在跑、驱动是否支持 Vulkan"
}
