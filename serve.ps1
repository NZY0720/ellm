param(
  [int]$Port = 5173,
  [string]$Root = "",
  [switch]$NoAgent
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Log {
  param(
    [string]$LogPath,
    [string]$Message
  )
  $ts = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss.fff")
  Add-Content -LiteralPath $LogPath -Value ("[$ts] " + $Message)
}

function Write-ServePort {
  param(
    [string]$RootDir,
    [int]$Port
  )
  $p = Join-Path -Path $RootDir -ChildPath "serve.port"
  try {
    Set-Content -LiteralPath $p -Value ([string]$Port) -Encoding ASCII
  } catch { }
}

function Get-RootDir {
  param([string]$RootArg)
  if (![string]::IsNullOrWhiteSpace($RootArg)) {
    return (Resolve-Path -LiteralPath $RootArg).Path
  }
  # Prefer stable built-in variables. `$MyInvocation.MyCommand.Path` is not always available.
  $scriptPath = $null
  try { $scriptPath = $PSCommandPath } catch { }
  if ([string]::IsNullOrWhiteSpace($scriptPath)) {
    try { $scriptPath = $MyInvocation.PSCommandPath } catch { }
  }
  if ([string]::IsNullOrWhiteSpace($scriptPath)) {
    # Fallbacks for unusual hosts
    try { $scriptPath = $MyInvocation.MyCommand.Source } catch { }
  }
  if ([string]::IsNullOrWhiteSpace($scriptPath)) {
    throw "Cannot determine script path. Please pass -Root explicitly."
  }
  $scriptDir = Split-Path -Parent $scriptPath
  return (Resolve-Path -LiteralPath $scriptDir).Path
}

function Get-ContentType {
  param([string]$Path)
  $ext = [IO.Path]::GetExtension($Path).ToLowerInvariant()
  switch ($ext) {
    ".html" { "text/html; charset=utf-8" }
    ".htm"  { "text/html; charset=utf-8" }
    ".css"  { "text/css; charset=utf-8" }
    ".js"   { "application/javascript; charset=utf-8" }
    ".csv"  { "text/csv; charset=utf-8" }
    ".json" { "application/json; charset=utf-8" }
    ".png"  { "image/png" }
    ".jpg"  { "image/jpeg" }
    ".jpeg" { "image/jpeg" }
    ".gif"  { "image/gif" }
    ".svg"  { "image/svg+xml" }
    ".ico"  { "image/x-icon" }
    ".txt"  { "text/plain; charset=utf-8" }
    default { "application/octet-stream" }
  }
}

function Write-TextResponse {
  param(
    [System.Net.HttpListenerResponse]$Response,
    [int]$StatusCode,
    [string]$Text,
    [string]$ContentType = "text/plain; charset=utf-8"
  )
  $Response.StatusCode = $StatusCode
  $Response.ContentType = $ContentType
  $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
  $Response.ContentLength64 = $bytes.Length
  $Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $Response.OutputStream.Close()
}

function Safe-CombinePath {
  param(
    [string]$RootDir,
    [string]$UrlPath
  )
  # UrlPath 形如 "/assets/a.js"；需要 URL 解码并防止路径穿越
  $decoded = [System.Uri]::UnescapeDataString($UrlPath)
  if ([string]::IsNullOrWhiteSpace($decoded) -or $decoded -eq "/") {
    $decoded = "/index.html"
  }
  if ($decoded.StartsWith("/")) {
    $decoded = $decoded.Substring(1)
  }

  # 统一分隔符
  $decoded = $decoded -replace "/", "\"

  # 去掉潜在的驱动器前缀
  $decoded = $decoded -replace "^[A-Za-z]:", ""

  $full = [IO.Path]::GetFullPath((Join-Path -Path $RootDir -ChildPath $decoded))
  $rootFull = [IO.Path]::GetFullPath($RootDir)
  if (!$full.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $null
  }
  return $full
}

$rootDir = Get-RootDir -RootArg $Root
$logPath = Join-Path -Path $rootDir -ChildPath "serve.log"
try { Remove-Item -LiteralPath $logPath -ErrorAction SilentlyContinue } catch { }
Write-Log -LogPath $logPath -Message ("Root=" + $rootDir + " Port=" + $Port)

Write-Host "Starting static server..."
Write-Host ("Root: " + $rootDir)
Write-Host ("Port: " + $Port)
Write-Host ("Log : " + $logPath)

$agentProcess = $null
if (-not $NoAgent) {
  try {
    Write-Host ""
    Write-Host "Starting DeepSeek agent..."
    $agentLog = Join-Path -Path $rootDir -ChildPath "llm\agent.log"
    $agentArgs = ".\llm\main.py --server --host 127.0.0.1 --port 8000"
    $venvPy = Join-Path -Path $rootDir -ChildPath ".venv\Scripts\python.exe"
    if (Test-Path -LiteralPath $venvPy -PathType Leaf) {
      # Prefer local venv if present
      $agentProcess = Start-Process -FilePath $venvPy -ArgumentList $agentArgs -WorkingDirectory $rootDir -PassThru -RedirectStandardOutput $agentLog -RedirectStandardError $agentLog
    } else {
      $pyCmd = Get-Command "py" -ErrorAction SilentlyContinue
      if ($null -eq $pyCmd) {
        throw "Python not found. Install Python (recommended) or create .venv in the project root."
      }
      $agentProcess = Start-Process -FilePath "py" -ArgumentList $agentArgs -WorkingDirectory $rootDir -PassThru -RedirectStandardOutput $agentLog -RedirectStandardError $agentLog
    }
    Write-Host ("Agent PID: " + $agentProcess.Id)
    Write-Host ("Agent Log: " + $agentLog)
  } catch {
    Write-Host "Failed to start agent. You can start it manually with:"
    Write-Host "  py .\llm\main.py --server --host 127.0.0.1 --port 8000"
    Write-Host ("Reason: " + $_.Exception.Message)
  }
}

Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action {
  if ($script:agentProcess -and !$script:agentProcess.HasExited) {
    try { $script:agentProcess.Kill() } catch { }
  }
} | Out-Null

function Run-HttpListenerServer {
  param(
    [int]$Port,
    [string]$RootDir,
    [string]$LogPath
  )

  $listener = New-Object System.Net.HttpListener
  $prefix1 = "http://localhost:$Port/"
  $prefix2 = "http://127.0.0.1:$Port/"
  $listener.Prefixes.Add($prefix1)
  $listener.Prefixes.Add($prefix2)

  try {
    $listener.Start()
  } catch {
    Write-Log -LogPath $LogPath -Message ("HttpListener start failed: " + $_.Exception.ToString())
    throw
  }

  Write-Host ""
  Write-Host ("Listening on: " + $prefix1)
  Write-Host "Press Ctrl+C to stop."
  Write-Host ""

  Write-Log -LogPath $LogPath -Message ("Listening(HttpListener)=" + $prefix1)
  Write-ServePort -RootDir $RootDir -Port $Port

  try {
    while ($listener.IsListening) {
      $ctx = $listener.GetContext()
      $req = $ctx.Request
      $res = $ctx.Response

      try {
        $path = Safe-CombinePath -RootDir $RootDir -UrlPath $req.Url.AbsolutePath
        if ($null -eq $path) {
          Write-TextResponse -Response $res -StatusCode 403 -Text "403 Forbidden"
          continue
        }

        if (!(Test-Path -LiteralPath $path -PathType Leaf)) {
          Write-TextResponse -Response $res -StatusCode 404 -Text ("404 Not Found: " + $req.Url.AbsolutePath)
          continue
        }

        $bytes = [IO.File]::ReadAllBytes($path)
        $res.StatusCode = 200
        $res.ContentType = Get-ContentType -Path $path
        $res.AddHeader("Cache-Control", "no-store")
        $res.ContentLength64 = $bytes.Length
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
        $res.OutputStream.Close()
      } catch {
        Write-Log -LogPath $LogPath -Message ("Request error(HttpListener): " + $_.Exception.ToString())
        try {
          Write-TextResponse -Response $res -StatusCode 500 -Text ("500 Internal Server Error`n" + $_.Exception.Message)
        } catch { }
      }
    }
  } finally {
    $listener.Stop()
    $listener.Close()
  }
}

function Write-HttpBytes {
  param(
    [System.IO.Stream]$Stream,
    [int]$StatusCode,
    [string]$StatusText,
    [byte[]]$BodyBytes,
    [string]$ContentType
  )
  $headers = @(
    "HTTP/1.1 $StatusCode $StatusText",
    "Content-Type: $ContentType",
    ("Content-Length: " + $BodyBytes.Length),
    "Cache-Control: no-store",
    "Connection: close",
    "",
    ""
  ) -join "`r`n"
  $headBytes = [Text.Encoding]::ASCII.GetBytes($headers)
  $Stream.Write($headBytes, 0, $headBytes.Length)
  if ($BodyBytes.Length -gt 0) {
    $Stream.Write($BodyBytes, 0, $BodyBytes.Length)
  }
}

function Run-TcpServer {
  param(
    [int[]]$Ports,
    [string]$RootDir,
    [string]$LogPath
  )

  $listener = $null
  $portUsed = $null
  foreach ($p in $Ports) {
    try {
      $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, [int]$p)
      $listener.Start()
      $portUsed = [int]$p
      break
    } catch {
      Write-Log -LogPath $LogPath -Message ("TcpListener start failed on port " + $p + ": " + $_.Exception.Message)
      try { $listener.Stop() } catch { }
      $listener = $null
    }
  }
  if ($null -eq $listener -or $null -eq $portUsed) {
    throw "TcpListener failed on all candidate ports."
  }

  $url = "http://127.0.0.1:$portUsed/"
  Write-Host ""
  Write-Host ("Listening on: " + $url + " (TcpListener fallback)")
  Write-Host "Press Ctrl+C to stop."
  Write-Host ""

  Write-Log -LogPath $LogPath -Message ("Listening(TcpListener)=" + $url)
  Write-ServePort -RootDir $RootDir -Port $portUsed

  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $stream = $client.GetStream()
      $reader = New-Object System.IO.StreamReader($stream, [Text.Encoding]::ASCII, $false, 8192, $true)

      $requestLine = $reader.ReadLine()
      if ([string]::IsNullOrWhiteSpace($requestLine)) {
        $client.Close()
        continue
      }

      # 读完 headers
      while ($true) {
        $line = $reader.ReadLine()
        if ($null -eq $line -or $line -eq "") { break }
      }

      $parts = $requestLine.Split(" ")
      $method = $parts[0]
      $urlPath = if ($parts.Length -ge 2) { $parts[1] } else { "/" }
      if ($urlPath.Contains("?")) { $urlPath = $urlPath.Split("?")[0] }

      if ($method -ne "GET" -and $method -ne "HEAD") {
        $body = [Text.Encoding]::UTF8.GetBytes("405 Method Not Allowed")
        Write-HttpBytes -Stream $stream -StatusCode 405 -StatusText "Method Not Allowed" -BodyBytes $body -ContentType "text/plain; charset=utf-8"
        continue
      }

      $path = Safe-CombinePath -RootDir $RootDir -UrlPath $urlPath
      if ($null -eq $path) {
        $body = [Text.Encoding]::UTF8.GetBytes("403 Forbidden")
        Write-HttpBytes -Stream $stream -StatusCode 403 -StatusText "Forbidden" -BodyBytes $body -ContentType "text/plain; charset=utf-8"
        continue
      }

      if (!(Test-Path -LiteralPath $path -PathType Leaf)) {
        $body = [Text.Encoding]::UTF8.GetBytes("404 Not Found")
        Write-HttpBytes -Stream $stream -StatusCode 404 -StatusText "Not Found" -BodyBytes $body -ContentType "text/plain; charset=utf-8"
        continue
      }

      $bytes = [IO.File]::ReadAllBytes($path)
      $ct = Get-ContentType -Path $path
      if ($method -eq "HEAD") { $bytes = [byte[]]::new(0) }
      Write-HttpBytes -Stream $stream -StatusCode 200 -StatusText "OK" -BodyBytes $bytes -ContentType $ct
    } catch {
      Write-Log -LogPath $LogPath -Message ("Request error(TcpListener): " + $_.Exception.ToString())
      try {
        $s = $client.GetStream()
        $body = [Text.Encoding]::UTF8.GetBytes("500 Internal Server Error")
        Write-HttpBytes -Stream $s -StatusCode 500 -StatusText "Internal Server Error" -BodyBytes $body -ContentType "text/plain; charset=utf-8"
      } catch { }
    } finally {
      try { $client.Close() } catch { }
    }
  }
}

try {
  try {
    Run-HttpListenerServer -Port $Port -RootDir $rootDir -LogPath $logPath
  } catch {
    Write-Host ""
    Write-Host "HttpListener failed. Falling back to TcpListener..."
    Write-Host "If port is in use, change PORT in serve.cmd (or -Port in serve.ps1)."
    Write-Host ""
    Write-Log -LogPath $logPath -Message ("Falling back to TcpListener because: " + $_.Exception.Message)
    $candidates = @()
    $candidates += $Port
    $candidates += ($Port + 1)..($Port + 20)
    $candidates += 8080
    $candidates += 8000
    $candidates += 9000
    $candidates += 3000
    $candidates += 5000
    $candidates = $candidates | Select-Object -Unique
    Run-TcpServer -Ports $candidates -RootDir $rootDir -LogPath $logPath
  }
} catch {
  Write-Log -LogPath $logPath -Message ("Fatal: " + $_.Exception.ToString())
  throw
} finally {
  if ($agentProcess -and !$agentProcess.HasExited) {
    try { $agentProcess.Kill() } catch { }
  }
}


