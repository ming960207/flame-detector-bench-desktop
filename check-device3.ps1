# 临时脚本：检查设备3的日志
# 运行方式：在 server 目录下执行 npm run dev | node ..\check-device3.ps1

while ($input -ne $null) {
  $line = $input | Out-String
  if ($line -match "设备 3|index.*3|FlameService") {
    Write-Host $line -ForegroundColor Yellow
  }
  Write-Host $line -NoNewline
}
