# ============================================================
#  Post-it de alerta del Premercado SPX (2026-10-13)
#  Ventana amarilla, siempre encima, que NO se cierra sola: es la
#  senal en pantalla de que hoy no hay premercado (o que hay que
#  mirar algo) y que hace falta que Guillermo intervenga.
#  La lanza el gate en un proceso aparte para no bloquearse.
#  Uso: powershell -File postit_alerta.ps1 -Archivo <txt con el mensaje>
#  (primera linea = titulo, el resto = cuerpo)
# ============================================================
param([Parameter(Mandatory = $true)][string]$Archivo)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$lineas = @(Get-Content $Archivo -Encoding UTF8)
$titulo = if ($lineas.Count) { $lineas[0] } else { 'Premercado SPX' }
$cuerpo = if ($lineas.Count -gt 1) { ($lineas[1..($lineas.Count - 1)] -join "`r`n") } else { '' }

$f = New-Object Windows.Forms.Form
$f.Text = "Premercado SPX - $titulo"
$f.TopMost = $true
$f.StartPosition = 'Manual'
$f.Size = New-Object Drawing.Size(460, 420)
$area = [Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$f.Location = New-Object Drawing.Point(($area.Right - 480), ($area.Top + 20))
$f.BackColor = [Drawing.Color]::FromArgb(255, 240, 120)
$f.FormBorderStyle = 'FixedToolWindow'

$t = New-Object Windows.Forms.Label
$t.Text = $titulo
$t.Font = New-Object Drawing.Font('Segoe UI', 13, [Drawing.FontStyle]::Bold)
$t.ForeColor = [Drawing.Color]::FromArgb(150, 0, 0)
$t.SetBounds(12, 10, 420, 52)
$f.Controls.Add($t)

$c = New-Object Windows.Forms.TextBox
$c.Multiline = $true
$c.ReadOnly = $true
$c.ScrollBars = 'Vertical'
$c.BorderStyle = 'None'
$c.BackColor = $f.BackColor
$c.Font = New-Object Drawing.Font('Segoe UI', 10)
$c.Text = $cuerpo
$c.SetBounds(12, 66, 420, 260)
$f.Controls.Add($c)

$b = New-Object Windows.Forms.Button
$b.Text = 'Entendido'
$b.SetBounds(330, 338, 100, 32)
$b.Add_Click({ $f.Close() })
$f.Controls.Add($b)

$f.Add_Shown({ $f.Activate(); $b.Select() })
[void]$f.ShowDialog()
