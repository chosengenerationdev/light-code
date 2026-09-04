# Light Code office worker.
#
# One JSON request per line on stdin, one JSON response per line on stdout. The same shape as
# the Python tool worker, and for the same reason: a long-lived process keeps the COM handles
# warm, so attaching to a workbook someone has open is a lookup rather than a launch.
#
# ## Why Windows PowerShell 5.1 and not pwsh
#
# `Marshal::GetActiveObject` is how you reach an Office application that is *already running*,
# and it does not exist in .NET Core - pwsh throws PlatformNotSupported. Attaching to the live
# session is the entire point of this feature, so the host resolves powershell.exe explicitly.
#
# ## Why arguments never reach a command line
#
# Everything here is model-supplied text: sheet names, ranges, search terms. It arrives as JSON
# on stdin and is only ever passed as an *argument* to a COM method. Nothing is interpolated
# into a command, and `Invoke-Expression` appears nowhere. CLAUDE.md section 16 requires this.

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::UTF8

# Cached between requests. Reconnecting per call would take a second each time and, worse,
# could launch a second Excel while the user is looking at the first.
$script:apps = @{}

<#
  Enumerating the Running Object Table, so a running Excel can be found when it does not
  advertise itself.

  ## Why this exists

  `GetActiveObject('Excel.Application')` is the documented way to reach a running Excel, and it is
  unreliable: measured on this machine, with Excel open and a workbook loaded, it failed with
  MK_E_UNAVAILABLE - and then began working after a second workbook was added. Excel registers its
  *Application* object in the ROT only sometimes.

  What it does register, every time, is the open **workbook**. So the workbook moniker is bound
  instead and its `.Application` taken, which is the same object by another road. Verified against
  the exact failure: the ROT held the workbook while GetActiveObject was still refusing.

  The helper is compiled on first use only - measured at 696ms to compile and 15ms to enumerate -
  so the ordinary path where GetActiveObject works pays nothing for it.
#>
function Get-RotNames {
    if (-not $script:rotReady) {
        $definition = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
public static class LightCodeRot {
    [DllImport("ole32.dll")] static extern int GetRunningObjectTable(int reserved, out IRunningObjectTable table);
    [DllImport("ole32.dll")] static extern int CreateBindCtx(int reserved, out IBindCtx context);
    public static string[] Names() {
        var found = new List<string>();
        IRunningObjectTable table; IBindCtx context;
        if (GetRunningObjectTable(0, out table) != 0) { return found.ToArray(); }
        if (CreateBindCtx(0, out context) != 0) { return found.ToArray(); }
        IEnumMoniker moniker;
        table.EnumRunning(out moniker);
        moniker.Reset();
        var one = new IMoniker[1];
        while (moniker.Next(1, one, IntPtr.Zero) == 0) {
            string name;
            try { one[0].GetDisplayName(context, null, out name); found.Add(name); } catch { }
        }
        return found.ToArray();
    }
}
'@
        Add-Type -TypeDefinition $definition
        $script:rotReady = $true
    }
    return [LightCodeRot]::Names()
}

# Extensions Excel registers a document moniker under. Filtering first means only Excel documents
# are ever bound - binding an arbitrary ROT entry could reach into another application entirely.
$script:excelExtensions = @('.xls', '.xlsx', '.xlsm', '.xlsb', '.xlt', '.xltx', '.xltm', '.xlam', '.xla', '.csv')

function Get-ExcelViaRot {
    try {
        $names = Get-RotNames
    } catch {
        return $null
    }

    foreach ($name in $names) {
        $extension = ''
        try { $extension = [System.IO.Path]::GetExtension($name).ToLowerInvariant() } catch { continue }
        if ($script:excelExtensions -notcontains $extension) { continue }

        try {
            $document = [System.Runtime.InteropServices.Marshal]::BindToMoniker($name)
            $candidate = $document.Application
            # Touching Workbooks proves it is Excel rather than something else that opened a .csv.
            $null = $candidate.Workbooks.Count
            return $candidate
        } catch {
            # A stale moniker, or a document belonging to another application. Try the next.
        }
    }
    return $null
}

<#
  Reaching a running Office application.

  `AttachOnly` is the rule for everything except opening a named workbook: the feature is about the
  session someone already has in front of them, and silently starting a second invisible Excel that
  holds a file lock is a worse outcome than saying "open it first". Outlook is stricter still - a
  bare New-Object *starts* Outlook, which was measured hanging for a full 60 second timeout.
#>
function Get-OfficeApp {
    param([string]$ProgId, [bool]$AttachOnly)

    if ($script:apps.ContainsKey($ProgId)) {
        try {
            # Touching it proves the handle is still alive - the user may have closed the app
            # since the last request, and a dead handle throws on first use rather than on cache.
            $null = $script:apps[$ProgId].Version
            return $script:apps[$ProgId]
        } catch {
            $script:apps.Remove($ProgId)
        }
    }

    $app = $null
    try {
        $app = [System.Runtime.InteropServices.Marshal]::GetActiveObject($ProgId)
    } catch {
        # Excel frequently does not register its Application object even while running. See
        # Get-ExcelViaRot: the open workbook is registered, and leads to the same application.
        if ($ProgId -eq 'Excel.Application') { $app = Get-ExcelViaRot }

        if ($null -eq $app) {
            if ($AttachOnly) { throw (Get-AttachFailureMessage -ProgId $ProgId) }
            $app = New-Object -ComObject $ProgId
        }
    }
    $script:apps[$ProgId] = $app
    return $app
}

<#
  Why the attach failed, distinguished rather than guessed.

  Saying "open it first" to somebody who is looking at an open spreadsheet destroys trust in every
  later answer, and it is exactly what was reported. So the process list is checked: if the
  application really is running and still cannot be reached, that is a different problem with a
  different fix, and it is named as the likely one rather than asserted as the certain one.
#>
function Get-AttachFailureMessage {
    param([string]$ProgId)

    $processName = if ($ProgId -eq 'Excel.Application') { 'EXCEL' } else { 'OUTLOOK' }
    $friendly = if ($ProgId -eq 'Excel.Application') { 'Excel' } else { 'Outlook' }

    $running = $null
    try { $running = Get-Process -Name $processName -ErrorAction SilentlyContinue } catch { }

    if ($null -ne $running) {
        return "$friendly is running, but this could not connect to it. The usual cause is that " +
            "the two are at different privilege levels - if VS Code is running as administrator " +
            "and $friendly is not, or the other way round, Windows keeps them apart. Starting both " +
            "the same way normally fixes it. A modal dialog open in $friendly can also block the " +
            "connection. This deliberately will not start a second copy."
    }
    return "$ProgId is not running on this machine. Open it and try again - this deliberately will not start it for you, because starting it can take a minute and may put a dialog on your screen."
}

function Get-Workbook {
    param($App, [string]$Name)

    if ([string]::IsNullOrWhiteSpace($Name)) {
        if ($App.Workbooks.Count -eq 0) { throw 'No workbook is open in Excel.' }
        return $App.ActiveWorkbook
    }
    foreach ($wb in $App.Workbooks) {
        if ($wb.Name -eq $Name -or $wb.FullName -eq $Name) { return $wb }
    }
    throw "No open workbook named '$Name'. Call excel_sessions to see what is open."
}

function Get-Worksheet {
    param($Workbook, [string]$Name)

    if ([string]::IsNullOrWhiteSpace($Name)) { return $Workbook.ActiveSheet }
    foreach ($sheet in $Workbook.Worksheets) {
        if ($sheet.Name -eq $Name) { return $sheet }
    }
    throw "No sheet named '$Name' in $($Workbook.Name)."
}

# Turns Excel's internal error variants into the text a person sees in the cell.
#
# An error arrives over COM as a signed integer - #N/A is -2146826246 - which is meaningless to
# anyone reading it and, worse, looks like a number a formula produced. The low word is the
# xlCVError constant, and that maps to the familiar names.
function Convert-ExcelValue {
    param($Value)

    if ($Value -isnot [int]) { return $Value }
    if ($Value -ge 0) { return $Value }

    $code = $Value -band 0xFFFF
    switch ($code) {
        2000 { return '#NULL!' }
        2007 { return '#DIV/0!' }
        2015 { return '#VALUE!' }
        2023 { return '#REF!' }
        2029 { return '#NAME?' }
        2036 { return '#NUM!' }
        2042 { return '#N/A' }
        2043 { return '#GETTING_DATA' }
        default { return $Value }
    }
}

# A cell as the model should see it: what it displays, what it holds, and what computes it.
function Read-Cell {
    param($Cell)

    $formula = $Cell.Formula
    $result = [ordered]@{
        address = $Cell.Address($false, $false)
        value   = $null
        text    = $Cell.Text
    }
    if ($formula -is [string] -and $formula.StartsWith('=')) { $result.formula = $formula }

    try {
        $result.value = Convert-ExcelValue -Value $Cell.Value2
    } catch {
        # A cell holding an error (#REF!, #DIV/0!) throws on Value2 in some builds. The
        # displayed text still carries the answer, and an error *is* the interesting case here.
        $result.value = $null
    }
    return $result
}

<#
  Opening a named workbook, which is the one place this is allowed to start Excel.

  ## Why this is not a contradiction of attach-only

  Everything else here refuses to launch Excel, because "look at the spreadsheet I have open" must
  never be answered by a second invisible copy holding a file lock. That reasoning is about a
  *guess*. Here the user has named a file and asked for it to be opened, so there is nothing to
  guess at, and refusing would just mean they open it by hand and ask again.

  ## Macros are disabled while it opens

  A workbook can carry `Workbook_Open`, so opening one is capable of running code. Automation
  security is forced to disable-all for the duration of the open and put back afterwards, which
  means opening a file to investigate it cannot execute anything. Running a macro stays an explicit,
  separately approved act through excel_run_macro.

  Excel is made visible on purpose. An automation-started Excel is hidden by default, and a hidden
  process holding the user's file is the exact failure the attach-only rule exists to avoid.
#>
function Invoke-ExcelOpen {
    param($Request)

    $path = $Request.path
    if ([string]::IsNullOrWhiteSpace($path)) { throw 'No path was given.' }
    if (-not (Test-Path -LiteralPath $path)) { throw "There is no file at '$path'." }
    $full = (Resolve-Path -LiteralPath $path).ProviderPath

    $readOnly = $true
    if ($null -ne $Request.readOnly) { $readOnly = [bool]$Request.readOnly }

    $app = $null
    $started = $false
    try {
        $app = Get-OfficeApp -ProgId 'Excel.Application' -AttachOnly $true
    } catch {
        $app = New-Object -ComObject Excel.Application
        $script:apps['Excel.Application'] = $app
        $started = $true
    }

    # Already open is the common case when someone asks twice, and reopening would either be
    # refused by Excel or quietly discard their unsaved edits.
    foreach ($existing in $app.Workbooks) {
        if ($existing.FullName -eq $full) {
            return @{
                workbook = $existing.Name
                fullName = $existing.FullName
                sheets   = @(Get-SheetNames -Workbook $existing)
                opened   = $false
                started  = $false
                readOnly = [bool]$existing.ReadOnly
            }
        }
    }

    $app.Visible = $true
    $previousSecurity = $app.AutomationSecurity
    $wb = $null
    try {
        # 3 is msoAutomationSecurityForceDisable: macros do not run, whatever the file asks for.
        $app.AutomationSecurity = 3
        # UpdateLinks 0 stops the "update links?" prompt, which nobody is present to answer.
        $wb = $app.Workbooks.Open($full, 0, $readOnly)
    } finally {
        try { $app.AutomationSecurity = $previousSecurity } catch { }
    }

    return @{
        workbook = $wb.Name
        fullName = $wb.FullName
        sheets   = @(Get-SheetNames -Workbook $wb)
        opened   = $true
        started  = $started
        readOnly = [bool]$wb.ReadOnly
    }
}

function Get-SheetNames {
    param($Workbook)

    $names = @()
    foreach ($sheet in $Workbook.Worksheets) { $names += $sheet.Name }
    return $names
}

function Invoke-ExcelSessions {
    $app = Get-OfficeApp -ProgId 'Excel.Application' -AttachOnly $true
    $sessions = @()
    foreach ($wb in $app.Workbooks) {
        $sheets = @()
        foreach ($sheet in $wb.Worksheets) { $sheets += $sheet.Name }
        $sessions += [ordered]@{
            name     = $wb.Name
            fullName = $wb.FullName
            saved    = [bool]$wb.Saved
            sheets   = $sheets
            active   = ($wb.Name -eq $app.ActiveWorkbook.Name)
        }
    }
    return @{ workbooks = $sessions; version = $app.Version }
}

<#
  Reads a range in two COM calls rather than four per cell.

  ## The measurement that forced this

  The first version walked the range and read Address, Text, Formula and Value2 from each cell.
  Every one of those is a cross-process call into Excel. Measured on an idle local workbook: 400
  cells took 2.2 seconds, while fetching the same block as two array properties took 7ms - **315
  times faster**. At the 2000-cell cap that is the difference between a moment and a minute, and
  on a workbook backed by a network share or OneDrive it was running past the timeout entirely.
  Reported as Excel "timing out" and "might be busy"; Excel was neither, it was being asked
  eight thousand questions one at a time.

  ## What the bulk form costs

  `Value2` and `Formula` come back as 2-D arrays in one call each, but there is no array
  equivalent of `Text` - the *formatted* string a person sees in the cell. So for a small range
  the text is still fetched per cell, which is affordable and exact; past that threshold it is
  derived from the value, losing number formatting but keeping the meaning. The result says which
  happened, because a currency column silently losing its currency is the kind of difference
  someone should be told about rather than left to notice.
#>
function Invoke-ExcelReadRange {
    param($Request)

    $app = Get-OfficeApp -ProgId 'Excel.Application' -AttachOnly $true
    $wb = Get-Workbook -App $app -Name $Request.workbook
    $sheet = Get-Worksheet -Workbook $wb -Name $Request.sheet
    $range = $sheet.Range($Request.range)

    $limit = 5000
    if ($range.Count -gt $limit) {
        throw "That range holds $($range.Count) cells; ask for at most $limit at a time."
    }

    # Below this, exact formatted text is worth four extra calls per cell.
    $exactTextLimit = 200
    $withText = ($range.Count -le $exactTextLimit)

    $firstRow = $range.Row
    $firstColumn = $range.Column
    $rowCount = $range.Rows.Count
    $columnCount = $range.Columns.Count

    # One call each. A single cell returns a scalar rather than an array, so both are normalised.
    $values = $range.Value2
    $formulas = $range.Formula

    $cells = @()
    for ($r = 1; $r -le $rowCount; $r++) {
        for ($c = 1; $c -le $columnCount; $c++) {
            $value = if ($rowCount -eq 1 -and $columnCount -eq 1) { $values } else { $values[$r, $c] }
            $formula = if ($rowCount -eq 1 -and $columnCount -eq 1) { $formulas } else { $formulas[$r, $c] }
            $converted = Convert-ExcelValue -Value $value

            $entry = [ordered]@{
                address = (Get-CellAddress -Row ($firstRow + $r - 1) -Column ($firstColumn + $c - 1))
                value   = $converted
            }
            if ($formula -is [string] -and $formula.StartsWith('=')) { $entry.formula = $formula }
            if ($withText) {
                $entry.text = $sheet.Cells.Item($firstRow + $r - 1, $firstColumn + $c - 1).Text
            } else {
                # Derived: the value as a string. Formatting is lost, and the caller is told.
                $entry.text = if ($null -eq $converted) { '' } else { [string]$converted }
            }
            $cells += $entry
        }
    }

    return @{
        sheet     = $sheet.Name
        workbook  = $wb.Name
        cells     = $cells
        exactText = $withText
    }
}

# A1-style address from 1-based row and column numbers.
#
# Computed rather than asked for: `$cell.Address()` is one more cross-process call per cell, and
# the arithmetic is the same arithmetic Excel would do.
function Get-CellAddress {
    param([int]$Row, [int]$Column)

    $letters = ''
    $n = $Column
    while ($n -gt 0) {
        $remainder = ($n - 1) % 26
        $letters = [char]([int][char]'A' + $remainder) + $letters
        $n = [Math]::Floor(($n - 1) / 26)
    }
    return "$letters$Row"
}

<#
  Walks back from a cell to what feeds it, and to what feeds those.

  This is the "why does this cell say that" question. `Precedents` is Excel's own answer and it
  covers the current sheet only, so cross-sheet references are read out of the formula text too -
  a formula pointing at another sheet is exactly the case people cannot trace by eye.

  ## Why precedents are grouped rather than enumerated

  The first version walked `Precedents` cell by cell and recursed into every one. On a formula as
  ordinary as `=SUM(A1:A2000)` that is 2000 precedent cells: measured at **9.3 seconds merely to
  list them**, before reading four properties off each and asking each for its own precedents. It
  timed out, and raising the timeout could not help, because the cost was not a slow step but a
  fan-out.

  `Precedents.Areas` gives the contiguous blocks instead - the same formula is **one** area,
  `Data!A1:A2000`, in 755ms. The grouped answer is also the better one. Nobody investigating a
  total wants two thousand nodes; they want to know which block feeds it and whether anything in
  that block is broken. So a multi-cell area is summarised in a single bulk read.

  ## What is followed and what is described

  A single-cell precedent is followed, because that is the chain an investigation is actually
  walking: this cell came from that one, which came from that one. A range is described and not
  entered - its cells are inputs to an aggregate, not steps on a path to a cause, and the summary
  already answers the question worth asking about it. Node count is capped as well, so a
  pathological sheet ends with a note instead of a hang.
#>
function Invoke-ExcelTrace {
    param($Request)

    $app = Get-OfficeApp -ProgId 'Excel.Application' -AttachOnly $true
    $wb = Get-Workbook -App $app -Name $Request.workbook
    $sheet = Get-Worksheet -Workbook $wb -Name $Request.sheet

    $script:traceMaxDepth = 3
    if ($Request.depth) { $script:traceMaxDepth = [Math]::Min([int]$Request.depth, 6) }
    $script:traceNodeLimit = 60

    <#
      Script-scoped, not local.

      PowerShell lets a nested function *read* an enclosing variable but an assignment creates a
      new local one, so `$nodes += ...` inside Walk built a copy that was discarded on return -
      the trace came back empty with no error at all. Verified against a real workbook.
    #>
    $script:traceSeen = @{}
    $script:traceNodes = @()
    $script:traceTruncated = $false
    $script:traceWorkbook = $wb

    function Walk {
        param($Sheet, [string]$Address, [int]$Depth)

        $key = "$($Sheet.Name)!$Address"
        if ($script:traceSeen.ContainsKey($key) -or $Depth -gt $script:traceMaxDepth) { return }
        if ($script:traceNodes.Count -ge $script:traceNodeLimit) { $script:traceTruncated = $true; return }
        $script:traceSeen[$key] = $true

        $cell = $Sheet.Range($Address)
        $node = Read-Cell -Cell $cell
        $node.sheet = $Sheet.Name
        $node.depth = $Depth

        $feeders = @()
        $follow = @()
        $summaries = @()

        if ($node.Contains('formula') -and $Depth -lt $script:traceMaxDepth) {
            try {
                # Areas, never cells. See the note above: one call per block, not one per cell.
                foreach ($area in $cell.Precedents.Areas) {
                    $areaSheet = $area.Parent
                    $areaAddress = $area.Address($false, $false)
                    $areaCount = $area.Count
                    $feeders += "$($areaSheet.Name)!$areaAddress"
                    if ($areaCount -eq 1) {
                        $follow += @{ SheetName = $areaSheet.Name; Address = $areaAddress }
                    } else {
                        $summaries += (Get-AreaSummary -Area $area -Count $areaCount -Sheet $areaSheet.Name -Address $areaAddress -Depth ($Depth + 1))
                    }
                }
            } catch {
                # No precedents on this sheet: Excel raises rather than returning an empty range.
            }

            <#
              Cross-sheet references, which `Precedents` does not report.

              The range half of the alternation is new. The original pattern matched a single cell
              only, so `=SUM(Data!A1:A500)` was recorded as feeding on nothing at all - a trace
              that stopped dead at the most common cross-sheet formula there is.
            #>
            $pattern = "(?:'([^']+)'|([A-Za-z0-9_]+))!(\`$?[A-Z]{1,3}\`$?[0-9]{1,7}(?::\`$?[A-Z]{1,3}\`$?[0-9]{1,7})?)"
            foreach ($match in [regex]::Matches($node.formula, $pattern)) {
                $sheetName = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
                $reference = $match.Groups[3].Value -replace '\$', ''
                $feeders += "$sheetName!$reference"
                try {
                    $refSheet = Get-Worksheet -Workbook $script:traceWorkbook -Name $sheetName
                    $refRange = $refSheet.Range($reference)
                    $refCount = $refRange.Count
                    if ($refCount -eq 1) {
                        $follow += @{ SheetName = $sheetName; Address = $reference }
                    } else {
                        $summaries += (Get-AreaSummary -Area $refRange -Count $refCount -Sheet $sheetName -Address $reference -Depth ($Depth + 1))
                    }
                } catch {
                    # A closed workbook or a deleted sheet. Still named among the feeders, because
                    # "it points at something that is not there" is very often the answer.
                }
            }
        }

        $node.feeds = @($feeders | Select-Object -Unique)
        $script:traceNodes += $node
        foreach ($summary in $summaries) {
            $summaryKey = "$($summary.sheet)!$($summary.address)"
            if ($script:traceSeen.ContainsKey($summaryKey)) { continue }
            $script:traceSeen[$summaryKey] = $true
            $script:traceNodes += $summary
        }

        foreach ($next in $follow) {
            try {
                $nextSheet = Get-Worksheet -Workbook $script:traceWorkbook -Name $next.SheetName
                Walk -Sheet $nextSheet -Address $next.Address -Depth ($Depth + 1)
            } catch {
                # Recorded by its absence from the node list rather than failing the whole trace.
            }
        }
    }

    Walk -Sheet $sheet -Address $Request.cell -Depth 0
    return @{
        workbook  = $wb.Name
        start     = "$($sheet.Name)!$($Request.cell)"
        nodes     = $script:traceNodes
        truncated = $script:traceTruncated
    }
}

<#
  Describes a block of cells in one bulk read.

  What an investigation needs to know about a range feeding a total is not its two thousand values
  but whether something in it is wrong: an error, a blank where a number belongs, text where
  arithmetic expects a figure. So that is what is counted. `Value2` over the whole block is a
  single cross-process call where reading each cell is one per cell - the same 315x difference
  measured for Invoke-ExcelReadRange.
#>
function Get-AreaSummary {
    param($Area, [int]$Count, [string]$Sheet, [string]$Address, [int]$Depth)

    $numbers = 0
    $errors = 0
    $blanks = 0
    $texts = 0
    $min = $null
    $max = $null
    $errorCells = @()
    $errorLimit = 10

    <#
      Positions are worked out arithmetically, not asked of Excel.

      Naming the cell is the whole value of this summary - "an error somewhere in A1:A2000" sends
      someone scrolling, "A57 is #DIV/0!" ends the investigation. But asking each cell for its own
      `.Address` would put back exactly the per-cell round trip this function exists to avoid, so
      the block's own origin plus the offset gives the same answer for nothing.

      PowerShell enumerates a two-dimensional COM array row-major, which is what the offset
      arithmetic below assumes.
    #>
    $firstRow = $Area.Row
    $firstColumn = $Area.Column
    $columnCount = $Area.Columns.Count

    try {
        $index = 0
        foreach ($raw in $Area.Value2) {
            $rowOffset = [Math]::Floor($index / $columnCount)
            $columnOffset = $index % $columnCount
            $index++

            if ($null -eq $raw) { $blanks++; continue }
            $value = Convert-ExcelValue -Value $raw
            if ($value -is [string]) {
                if ($value.StartsWith('#')) {
                    $errors++
                    if ($errorCells.Count -lt $errorLimit) {
                        $where = Get-CellAddress -Row ($firstRow + $rowOffset) -Column ($firstColumn + $columnOffset)
                        $errorCells += "$where is $value"
                    }
                } else {
                    $texts++
                }
                continue
            }
            $numbers++
            $asDouble = [double]$value
            if ($null -eq $min -or $asDouble -lt $min) { $min = $asDouble }
            if ($null -eq $max -or $asDouble -gt $max) { $max = $asDouble }
        }
    } catch {
        # An unreadable block is still worth naming; its counts simply stay at zero.
    }

    $summary = [ordered]@{
        address = $Address
        sheet   = $Sheet
        depth   = $Depth
        kind    = 'range'
        cells   = $Count
        numbers = $numbers
        errors  = $errors
        blanks  = $blanks
        texts   = $texts
        feeds   = @()
    }
    if ($null -ne $min) { $summary.min = $min; $summary.max = $max }
    if ($errorCells.Count -gt 0) { $summary.errorCells = $errorCells }
    return $summary
}

# Reaching the VBA project, or explaining why not.
#
# Measured: with the Trust Center setting off, `$Workbook.VBProject` does **not** throw in Excel
# 16 - it returns $null. So the original try/catch never fired and every caller reported "this
# workbook contains no VBA modules", which is a confident wrong answer to a question about
# security settings. The null check is the one that actually does the work.
function Get-VbProject {
    param($Workbook)

    try {
        $project = $Workbook.VBProject
        if ($null -eq $project) { throw 'VBProject is not accessible.' }
        return $project
    } catch {
        throw ('Excel is not allowing access to the VBA project. Turn on ' +
            'File > Options > Trust Center > Trust Center Settings > Macro Settings > ' +
            '"Trust access to the VBA project object model", then try again.')
    }
}

function Invoke-ExcelListMacros {
    param($Request)

    $app = Get-OfficeApp -ProgId 'Excel.Application' -AttachOnly $true
    $wb = Get-Workbook -App $app -Name $Request.workbook
    $project = Get-VbProject -Workbook $wb

    $modules = @()
    foreach ($component in $project.VBComponents) {
        $lines = $component.CodeModule.CountOfLines
        $modules += [ordered]@{
            name  = $component.Name
            type  = switch ($component.Type) { 1 { 'module' } 2 { 'class' } 3 { 'form' } 100 { 'document' } default { 'other' } }
            lines = $lines
        }
    }
    return @{ workbook = $wb.Name; modules = $modules }
}

function Invoke-ExcelReadMacro {
    param($Request)

    $app = Get-OfficeApp -ProgId 'Excel.Application' -AttachOnly $true
    $wb = Get-Workbook -App $app -Name $Request.workbook
    $project = Get-VbProject -Workbook $wb

    foreach ($component in $project.VBComponents) {
        if ($component.Name -eq $Request.module) {
            $count = $component.CodeModule.CountOfLines
            $code = if ($count -gt 0) { $component.CodeModule.Lines(1, $count) } else { '' }
            return @{ workbook = $wb.Name; module = $component.Name; code = $code }
        }
    }
    throw "No VBA module named '$($Request.module)' in $($wb.Name)."
}

function Invoke-ExcelWriteMacro {
    param($Request)

    $app = Get-OfficeApp -ProgId 'Excel.Application' -AttachOnly $true
    $wb = Get-Workbook -App $app -Name $Request.workbook
    $project = Get-VbProject -Workbook $wb

    foreach ($component in $project.VBComponents) {
        if ($component.Name -eq $Request.module) {
            $module = $component.CodeModule
            $before = $module.CountOfLines
            if ($before -gt 0) { $module.DeleteLines(1, $before) }
            if (-not [string]::IsNullOrEmpty($Request.code)) { $module.AddFromString($Request.code) }
            # Deliberately not saved. The user has this workbook open; writing their file out
            # from underneath them is a bigger act than editing a module, and they may want to
            # run it before keeping it.
            return @{ workbook = $wb.Name; module = $component.Name; linesBefore = $before; linesAfter = $module.CountOfLines }
        }
    }
    throw "No VBA module named '$($Request.module)' in $($wb.Name). Create it in Excel first."
}

# Attach-only, like Excel, and this was measured rather than assumed.
#
# Creating the COM object when Outlook is closed does not fail - it *starts* Outlook, which can
# take a minute, may put a profile chooser on screen, and leaves the user with an application
# they did not open. The first live test of this hung for the full timeout for exactly that
# reason. Requiring it to be running already is both faster and honest.
# Runs a macro and reports what it did, including how it failed.
#
# ## Why the before/after snapshot is part of running, not a separate call
#
# The point of running a macro during an investigation is to find out what it changes. Asking
# separately would race the user - they might touch the sheet in between - and would let a caller
# report "after" values it never had a "before" for.
#
# ## What this cannot do
#
# COM cannot drive the VBA debugger: there are no breakpoints, no stepping, and no reading of
# locals while stopped. What it gets is the return value, or the error VBA raised, which is the
# part people actually need. Anything finer means opening the VBE by hand.
function Invoke-ExcelRunMacro {
    param($Request)

    $app = Get-OfficeApp -ProgId 'Excel.Application' -AttachOnly $true
    $wb = Get-Workbook -App $app -Name $Request.workbook

    $before = @()
    $sheet = $null
    if ($Request.watchSheet -and $Request.watchRange) {
        $sheet = Get-Worksheet -Workbook $wb -Name $Request.watchSheet
        foreach ($cell in $sheet.Range($Request.watchRange)) { $before += Read-Cell -Cell $cell }
    }

    # Qualified with the workbook so a macro of the same name in another open book cannot be the
    # one that runs - which would be a very hard mistake to notice afterwards.
    $qualified = "'$($wb.Name)'!$($Request.macro)"

    $failed = $false
    $errorText = $null
    $returned = $null
    try {
        $arguments = @()
        if ($Request.arguments) { $arguments = @($Request.arguments) }
        switch ($arguments.Count) {
            0 { $returned = $app.Run($qualified) }
            1 { $returned = $app.Run($qualified, $arguments[0]) }
            2 { $returned = $app.Run($qualified, $arguments[0], $arguments[1]) }
            3 { $returned = $app.Run($qualified, $arguments[0], $arguments[1], $arguments[2]) }
            default { throw 'At most three arguments can be passed to a macro from here.' }
        }
    } catch {
        # Reported as a result, not thrown: a macro that fails is the *answer* when the reason for
        # running it was to find out why it fails.
        $failed = $true
        $errorText = $_.Exception.Message
    }

    $after = @()
    if ($sheet) {
        foreach ($cell in $sheet.Range($Request.watchRange)) { $after += Read-Cell -Cell $cell }
    }

    return @{
        workbook = $wb.Name
        macro    = $Request.macro
        failed   = $failed
        error    = $errorText
        returned = if ($null -eq $returned) { $null } else { [string]$returned }
        before   = $before
        after    = $after
    }
}

# Evaluates an expression without writing it anywhere.
#
# `Application.Evaluate` computes a formula in the workbook's own context - the same names, the
# same sheets - and returns the answer without a cell being touched. It is the "what would this
# give" question, which during an investigation is asked far more often than "change this".
function Invoke-ExcelEvaluate {
    param($Request)

    $app = Get-OfficeApp -ProgId 'Excel.Application' -AttachOnly $true
    $wb = Get-Workbook -App $app -Name $Request.workbook
    $sheet = Get-Worksheet -Workbook $wb -Name $Request.sheet

    # Activated so relative references and sheet-scoped names resolve the way they would in a cell
    # on that sheet. Restored afterwards, because moving the user's selection is a visible change.
    $previous = $app.ActiveSheet
    $result = $null
    $failed = $false
    $errorText = $null
    try {
        $sheet.Activate()
        $result = $app.Evaluate($Request.expression)
    } catch {
        $failed = $true
        $errorText = $_.Exception.Message
    } finally {
        try { $previous.Activate() } catch { }
    }

    return @{
        workbook   = $wb.Name
        sheet      = $sheet.Name
        expression = $Request.expression
        failed     = $failed
        error      = $errorText
        value      = if ($null -eq $result) { $null } else { [string](Convert-ExcelValue -Value $result) }
    }
}

function Get-OutlookNamespace {
    $app = Get-OfficeApp -ProgId 'Outlook.Application' -AttachOnly $true
    return $app.GetNamespace('MAPI')
}

# Walks the whole tree, not just the top level.
#
# The first version listed store -> folder and stopped, which made a nested folder impossible to
# *discover* even though Get-OutlookFolder could already reach one by path. Someone whose mail is
# filed under Inbox\Projects\Acme could see neither the folder nor a reason it was missing.
#
# Depth-capped and script-scoped: a large mailbox nests deeply, and PowerShell's nested-function
# scoping means an inner assignment to `$folders` would build a local copy and discard it - the
# same trap that made the Excel trace return empty.
# Lists mail folders, cheaply enough to finish on a corporate mailbox.
#
# ## What went wrong the first time, reported from real use
#
# The first recursive version read `$Folder.Items.Count` for every folder it walked. On a cached
# local mailbox that is instant; on Exchange in online mode it is a server round trip *per
# folder*, and with a few hundred folders the whole call ran past the timeout. What the user saw
# was a tool that failed twice and an assistant confidently blaming a dialog box that did not
# exist.
#
# So the count is gone unless asked for. `UnReadItemCount` stays: it is a stored property on the
# folder rather than a query over its contents, and it is the number people actually scan for.
#
# The walk is also bounded twice over - by depth and by a hard ceiling on how many folders come
# back - because "how deep does this mailbox go" is not a question worth discovering by hanging.
function Invoke-OutlookFolders {
    param($Request)

    $ns = Get-OutlookNamespace
    $script:folderList = @()
    $script:folderMaxDepth = 2
    if ($Request -and $Request.depth) { $script:folderMaxDepth = [Math]::Min([int]$Request.depth, 8) }
    $script:folderWithCounts = $false
    if ($Request -and $Request.counts) { $script:folderWithCounts = $true }
    $script:folderLimit = 400

    function Walk-Folder {
        param($Folder, [string]$Path, [int]$Depth)

        if ($script:folderList.Count -ge $script:folderLimit) { return }

        $entry = [ordered]@{
            name  = $Folder.Name
            path  = $Path
            depth = $Depth
        }
        # Stored on the folder, so it costs nothing extra.
        try { $entry.unread = $Folder.UnReadItemCount } catch { $entry.unread = $null }
        # A query over the folder's contents, and the reason this used to time out.
        if ($script:folderWithCounts) {
            try { $entry.items = $Folder.Items.Count } catch { $entry.items = $null }
        }
        $script:folderList += $entry

        if ($Depth -ge $script:folderMaxDepth) { return }
        foreach ($child in $Folder.Folders) {
            Walk-Folder -Folder $child -Path "$Path\$($child.Name)" -Depth ($Depth + 1)
        }
    }

    foreach ($store in $ns.Folders) {
        foreach ($folder in $store.Folders) {
            Walk-Folder -Folder $folder -Path "$($store.Name)\$($folder.Name)" -Depth 1
        }
    }
    return @{
        folders  = $script:folderList
        depth    = $script:folderMaxDepth
        # Said rather than silently cut: a truncated list looks exactly like a complete one.
        truncated = ($script:folderList.Count -ge $script:folderLimit)
    }
}

function Get-OutlookFolder {
    param($Namespace, [string]$Path)

    # The inbox is what people mean when they do not say.
    if ([string]::IsNullOrWhiteSpace($Path)) { return $Namespace.GetDefaultFolder(6) }

    $parts = $Path -split '\\'
    foreach ($store in $Namespace.Folders) {
        if ($store.Name -ne $parts[0]) { continue }
        $current = $store
        foreach ($part in $parts[1..($parts.Length - 1)]) {
            $next = $null
            foreach ($child in $current.Folders) { if ($child.Name -eq $part) { $next = $child; break } }
            if ($null -eq $next) { throw "No folder '$part' under '$($current.Name)'." }
            $current = $next
        }
        return $current
    }
    throw "No mail store named '$($parts[0])'. Call outlook_folders to see what is available."
}

function Invoke-OutlookSearch {
    param($Request)

    $ns = Get-OutlookNamespace
    $folder = Get-OutlookFolder -Namespace $ns -Path $Request.folder

    $items = $folder.Items
    $items.Sort('[ReceivedTime]', $true)

    $limit = 25
    if ($Request.limit) { $limit = [Math]::Min([int]$Request.limit, 100) }

    # Restrict/DASL rather than reading every item: a mailbox holds tens of thousands, and
    # filtering in PowerShell would take minutes and a great deal of memory.
    $filters = @()
    if ($Request.from) { $filters += "urn:schemas:httpmail:fromemail LIKE '%$($Request.from -replace "'", "''")%'" }
    if ($Request.subject) { $filters += "urn:schemas:httpmail:subject LIKE '%$($Request.subject -replace "'", "''")%'" }
    <#
      Two ways to say "recently", because people say it both ways.

      `withinMinutes` is the one that gets used - "anything in the last two hours" - and computing
      the cutoff here rather than in the caller means it is relative to *this machine's* clock,
      which is the clock Outlook stamped the mail with.
    #>
    $cutoff = $null
    if ($Request.withinMinutes) { $cutoff = (Get-Date).AddMinutes(-1 * [double]$Request.withinMinutes) }
    elseif ($Request.since) { $cutoff = [datetime]::Parse($Request.since) }
    if ($cutoff) { $filters += "urn:schemas:httpmail:datereceived >= '$($cutoff.ToString('yyyy-MM-dd HH:mm'))'" }

    if ($filters.Count -gt 0) {
        $items = $items.Restrict('@SQL=' + ($filters -join ' AND '))
    }

    $results = @()
    $index = 0
    foreach ($item in $items) {
        if ($results.Count -ge $limit) { break }
        $index++
        # Non-mail items (meeting requests, tasks) have no SenderName and would throw.
        try {
            $body = [string]$item.Body
            if ($Request.contains -and $body -notmatch [regex]::Escape($Request.contains) -and
                $item.Subject -notmatch [regex]::Escape($Request.contains)) { continue }
            $results += [ordered]@{
                entryId  = $item.EntryID
                subject  = $item.Subject
                from     = $item.SenderName
                received = $item.ReceivedTime.ToString('s')
                unread   = [bool]$item.UnRead
                preview  = if ($body.Length -gt 300) { $body.Substring(0, 300) } else { $body }
            }
        } catch {
            continue
        }
    }
    return @{ folder = $folder.Name; matches = $results }
}

function Invoke-OutlookRead {
    param($Request)

    $ns = Get-OutlookNamespace
    $item = $ns.GetItemFromID($Request.entryId)
    $attachments = @()
    foreach ($attachment in $item.Attachments) { $attachments += $attachment.FileName }

    # The HTML body as well as the plain one.
    #
    # `Body` is the plain-text rendering and it discards every bit of formatting - which in
    # corporate mail is often the message itself: the red line is the failure, the highlighted
    # cell is the one that changed. The caller extracts the text and marks the parts that carried
    # meaning; sending the HTML straight through would cost thousands of tokens of Outlook markup
    # to convey a few words of emphasis.
    $html = $null
    try { $html = [string]$item.HTMLBody } catch { }

    return @{
        subject     = $item.Subject
        html        = $html
        from        = $item.SenderName
        fromAddress = $item.SenderEmailAddress
        to          = $item.To
        cc          = $item.CC
        received    = $item.ReceivedTime.ToString('s')
        body        = $item.Body
        attachments = $attachments
    }
}

function Invoke-Request {
    param($Request)

    switch ($Request.op) {
        'ping'                  { return @{ ok = $true } }
        'excel.open'            { return Invoke-ExcelOpen -Request $Request }
        'excel.sessions'        { return Invoke-ExcelSessions }
        'excel.readRange'       { return Invoke-ExcelReadRange -Request $Request }
        'excel.trace'           { return Invoke-ExcelTrace -Request $Request }
        'excel.listMacros'      { return Invoke-ExcelListMacros -Request $Request }
        'excel.readMacro'       { return Invoke-ExcelReadMacro -Request $Request }
        'excel.writeMacro'      { return Invoke-ExcelWriteMacro -Request $Request }
        'excel.runMacro'        { return Invoke-ExcelRunMacro -Request $Request }
        'excel.evaluate'        { return Invoke-ExcelEvaluate -Request $Request }
        'outlook.folders'       { return Invoke-OutlookFolders -Request $Request }
        'outlook.search'        { return Invoke-OutlookSearch -Request $Request }
        'outlook.read'          { return Invoke-OutlookRead -Request $Request }
        default                 { throw "Unknown operation '$($Request.op)'." }
    }
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ([string]::IsNullOrWhiteSpace($line)) { continue }

    $id = $null
    try {
        $request = $line | ConvertFrom-Json
        $id = $request.id
        $result = Invoke-Request -Request $request
        $response = [ordered]@{ id = $id; ok = $true; result = $result }
    } catch {
        # Errors come back as data, never as a crashed process: one bad range should not take
        # down a session that took a second to attach and holds the user's open workbook.
        $response = [ordered]@{ id = $id; ok = $false; error = $_.Exception.Message }
    }
    [Console]::Out.WriteLine(($response | ConvertTo-Json -Depth 12 -Compress))
    [Console]::Out.Flush()
}
