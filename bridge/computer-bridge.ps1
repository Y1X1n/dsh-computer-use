#requires -version 5.1
# dsh-computer-use persistent bridge, protocol shim.
#
# All automation work lives in Engine.cs (compiled once, below). This file
# only frames the wire protocol so the compiled engine stays the single
# place that touches the platform.
#
# Wire format, one JSON object per line on stdio, UTF-8:
#   request : {"id":1,"op":"screen.capture","args":{...}}
#   response: {"id":1,"ok":true,"result":{...}} | {"id":1,"ok":false,"error":{"code":"..","message":".."}}
#   handshake: {"ready":true,"version":"1.0.0","platform":"win32"} (first line, no id)
#
# The process must never die on op errors; stdin EOF ends it cleanly.

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$script:BridgeVersion = '1.0.0'
$script:Compiled = $false
$script:CompileError = $null
$script:BridgeErrorType = $null

# ---------------------------------------------------------------------------
# stdio: explicit UTF-8 streams (the console encoding setters can throw on
# redirected handles, so the raw streams are wrapped directly).
# ---------------------------------------------------------------------------

$script:Out = New-Object System.IO.StreamWriter(
  ([Console]::OpenStandardOutput()), (New-Object System.Text.UTF8Encoding($false)))
$script:Out.AutoFlush = $false
$script:In = New-Object System.IO.StreamReader(
  ([Console]::OpenStandardInput()), (New-Object System.Text.UTF8Encoding($false)))

function Write-Line {
  param([string]$Text)
  $script:Out.WriteLine($Text)
  $script:Out.Flush()
}

function To-JsonLine {
  param($Value)
  return (ConvertTo-Json -InputObject $Value -Depth 10 -Compress)
}

# ---------------------------------------------------------------------------
# Engine compilation, once per process, on the first op (the handshake is
# emitted before this so the client never waits on the compiler).
# ---------------------------------------------------------------------------

function Test-EngineLoaded {
  try {
    $null = [DshComputerUse.Engine]
    return $true
  } catch {
    return $false
  }
}

function Complete-Compile {
  # Records the freshly available engine in this session. Returns $false when the
  # types are still not resolvable, so callers can fall back instead of guessing.
  if (-not (Test-EngineLoaded)) { return $false }
  $script:BridgeErrorType = [DshComputerUse.BridgeException]
  $script:Compiled = $true
  return $true
}

function Get-EngineCacheDir {
  $root = $env:LOCALAPPDATA
  if (-not $root) { $root = [System.IO.Path]::GetTempPath() }
  $dir = Join-Path $root 'dsh-computer-use\engine-cache'
  if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
  }
  return $dir
}

function Get-EngineCachePath {
  param([string]$Source)
  # The key covers everything that can change the emitted IL: the source itself,
  # the PowerShell/CLR pair that drives the legacy compiler, and a scheme version
  # so an older layout can never be mistaken for a valid build.
  $material = $Source + "`n|scheme=1|ps=" + $PSVersionTable.PSVersion.ToString() + "|clr=" + [Environment]::Version.ToString()
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($material)
    $hash = [System.BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
  return (Join-Path (Get-EngineCacheDir) ('engine-' + $hash.Substring(0, 32) + '.dll'))
}

function Ensure-Compiled {
  if ($script:Compiled) { return }
  if ($script:CompileError) {
    # Previous attempt failed; answer quickly instead of re-running the
    # compiler on every request.
    throw $script:CompileError
  }

  $sourcePath = Join-Path $PSScriptRoot 'Engine.cs'
  $source = [System.IO.File]::ReadAllText($sourcePath)
  $refs = @(
    'System.Drawing',
    'System.Windows.Forms',
    'UIAutomationClient',
    'UIAutomationTypes',
    'WindowsBase'
  )

  # Compiling C# costs ~0.9s per cold start. Keep the assembly next to the user's
  # cache so a cold bridge only pays that once per Engine.cs revision — borrowed
  # from Yu-tao-Li/dsh-computer-use-win (see docs/borrow-mit-projects.md).
  $cachePath = $null
  try { $cachePath = Get-EngineCachePath -Source $source } catch { $cachePath = $null }

  if ($cachePath -and (Test-Path -LiteralPath $cachePath)) {
    try {
      Add-Type -Path $cachePath
      if (Complete-Compile) { return }
    } catch { }
    # Unusable entry (truncated, corrupt, half-copied): drop it and rebuild.
    try { Remove-Item -LiteralPath $cachePath -Force -ErrorAction SilentlyContinue } catch { }
  }

  if ($cachePath) {
    $tmp = $cachePath + '.' + [Guid]::NewGuid().ToString('n') + '.tmp'
    try {
      Add-Type -TypeDefinition $source -ReferencedAssemblies $refs -OutputAssembly $tmp
      Move-Item -LiteralPath $tmp -Destination $cachePath -Force
      if (Complete-Compile) { return }
    } catch {
      try { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue } catch { }
      # A concurrent bridge may have won the race and published its own copy.
      if (Test-Path -LiteralPath $cachePath) {
        try {
          Add-Type -Path $cachePath
          if (Complete-Compile) { return }
        } catch { }
      }
    }
  }

  # Last resort: compile into memory. A read-only or unavailable cache directory
  # must never break the bridge, it may only cost the original compile time.
  try {
    Add-Type -TypeDefinition $source -ReferencedAssemblies $refs
  } catch {
    if (-not (Test-EngineLoaded)) {
      $script:CompileError = $_.Exception
      throw
    }
  }
  if (-not (Complete-Compile)) {
    $script:CompileError = (New-Object System.Exception 'engine types failed to load')
    throw $script:CompileError
  }
}

# ---------------------------------------------------------------------------
# Args arrive from ConvertFrom-Json as PSCustomObject; the engine expects
# dictionaries with TryGetValue. Convert recursively (PS 5.1 has no
# -AsHashtable switch).
# ---------------------------------------------------------------------------

function Convert-ToDict {
  param($Value)
  # PS wraps values crossing assignment/return boundaries in PSObject; C#
  # needs the raw instance. PSCustomObject's BaseObject is an EMPTY shell, so
  # only unwrap when the base is a real container. Unwrapping stays inline:
  # any function boundary re-wraps the value.
  if ($null -eq $Value) { return $null }
  if ($Value -is [PSObject]) {
    $base = $Value.PSObject.BaseObject
    if (-not ($base -is [System.Management.Automation.PSCustomObject])) { $Value = $base }
  }

  if ($Value -is [System.Management.Automation.PSCustomObject]) {
    $dict = New-Object 'System.Collections.Generic.Dictionary[string,object]'
    foreach ($prop in $Value.PSObject.Properties) {
      $child = Convert-ToDict -Value $prop.Value
      if ($child -is [PSObject]) {
        $childBase = $child.PSObject.BaseObject
        if (-not ($childBase -is [System.Management.Automation.PSCustomObject])) { $child = $childBase }
      }
      $dict[$prop.Name] = $child
    }
    return ,$dict
  }
  if ($Value -is [System.Collections.IDictionary]) {
    $dict = New-Object 'System.Collections.Generic.Dictionary[string,object]'
    foreach ($key in @($Value.Keys)) {
      $child = Convert-ToDict -Value $Value[$key]
      if ($child -is [PSObject]) {
        $childBase = $child.PSObject.BaseObject
        if (-not ($childBase -is [System.Management.Automation.PSCustomObject])) { $child = $childBase }
      }
      $dict[[string]$key] = $child
    }
    return ,$dict
  }
  # Arrays (and every IEnumerable) get flattened by the pipeline when returned
  # from a function; the comma prefix preserves them.
  if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
    $list = New-Object 'System.Collections.Generic.List[object]'
    foreach ($item in $Value) {
      $child = Convert-ToDict -Value $item
      if ($child -is [PSObject]) {
        $childBase = $child.PSObject.BaseObject
        if (-not ($childBase -is [System.Management.Automation.PSCustomObject])) { $child = $childBase }
      }
      $list.Add($child)
    }
    return ,$list.ToArray()
  }
  return $Value
}

# ---------------------------------------------------------------------------
# Startup handshake, then the request loop. Responses are one JSON line each.
# ---------------------------------------------------------------------------

Write-Line (To-JsonLine @{
  ready    = $true
  version  = $script:BridgeVersion
  platform = 'win32'
})

while ($true) {
  $line = $script:In.ReadLine()
  if ($null -eq $line) { break }   # stdin closed: clean exit
  if (-not $line.Trim()) { continue }

  $request = $null
  $id = $null
  try {
    $request = $line | ConvertFrom-Json
    if ($null -ne $request -and $request.PSObject.Properties['id']) { $id = $request.id }
  } catch {
    Write-Line (To-JsonLine @{
      id    = $id
      ok    = $false
      error = @{ code = 'BAD_REQUEST'; message = ("unparseable request line: " + $_.Exception.Message) }
    })
    continue
  }

  try {
    Ensure-Compiled
    $op = [string]$request.op
    $opArgs = New-Object 'System.Collections.Generic.Dictionary[string,object]'
    if ($request.PSObject.Properties['args'] -and $null -ne $request.args) {
      $converted = Convert-ToDict -Value $request.args
      if ($converted -is [System.Collections.Generic.Dictionary[string,object]]) {
        $opArgs = $converted
      }
    }
    $result = [DshComputerUse.Engine]::Run($op, $opArgs)
    Write-Line (To-JsonLine @{ id = $id; ok = $true; result = $result })
  } catch {
    $code = 'OP_FAILED'
    $message = $_.Exception.Message
    if ($script:BridgeErrorType) {
      if ($script:BridgeErrorType.IsInstanceOfType($_.Exception)) {
        $code = $_.Exception.Code
        $message = $_.Exception.Message
      } elseif ($_.Exception.InnerException -and $script:BridgeErrorType.IsInstanceOfType($_.Exception.InnerException)) {
        $code = $_.Exception.InnerException.Code
        $message = $_.Exception.InnerException.Message
      } elseif ($_.Exception.InnerException) {
        $message = $_.Exception.InnerException.Message
      }
    } elseif ($_.Exception.InnerException) {
      $message = $_.Exception.InnerException.Message
    }
    Write-Line (To-JsonLine @{
      id    = $id
      ok    = $false
      error = @{ code = $code; message = $message }
    })
  }
}

# Teardown: nothing this bridge injected may outlive it. A key still held down
# (a caller that died between keyboard.press down and up) would otherwise stay
# held on the user's keyboard, and the hosting strip would linger on screen.
try {
  if ($script:Compiled) { [DshComputerUse.Engine]::Shutdown() }
} catch {
  # Shutdown is best-effort; the process is going away regardless.
}
exit 0
