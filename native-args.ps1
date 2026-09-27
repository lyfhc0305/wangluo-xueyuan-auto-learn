# Windows 原生命令参数转义。Start-Process 会把 ArgumentList 数组拼成字符串,
# 必须按 Windows argv 规则保留空格、双引号和双引号前的反斜杠。
function ConvertTo-NativeArgument([AllowEmptyString()][string]$Value) {
  $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}
