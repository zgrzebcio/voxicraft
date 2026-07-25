# Minimal static file server for local preview of index.html (no Node/Python required)
$root = Split-Path -Parent $PSScriptRoot
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add('http://localhost:8407/')
$listener.Start()
Write-Host "Serving $root at http://localhost:8407/"
$mime = @{ '.html'='text/html'; '.js'='text/javascript'; '.css'='text/css'; '.png'='image/png'; '.json'='application/json'; '.ico'='image/x-icon' }
while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    try {
        $path = $ctx.Request.Url.AbsolutePath
        if ($path -eq '/') { $path = '/index.html' }
        $file = Join-Path $root ($path -replace '/', '\')
        if ((Test-Path $file -PathType Leaf) -and ((Resolve-Path $file).Path.StartsWith($root))) {
            $bytes = [IO.File]::ReadAllBytes($file)
            $ext = [IO.Path]::GetExtension($file).ToLower()
            $ctx.Response.ContentType = if ($mime[$ext]) { $mime[$ext] } else { 'application/octet-stream' }
            $ctx.Response.Headers.Add('Cache-Control', 'no-store')
            $ctx.Response.ContentLength64 = $bytes.Length
            $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $ctx.Response.StatusCode = 404
        }
    } catch {} finally {
        try { $ctx.Response.Close() } catch {}
    }
}
