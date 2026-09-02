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
        if ($AttachOnly) {
            throw "$ProgId is not running on this machine. Open it and try again - this deliberately will not start it for you, because starting it can take a minute and may put a dialog on your screen."
        }
        $app = New-Object -ComObject $ProgId
    }
    $script:apps[$ProgId] = $app
    return $app
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
        $result.value = $Cell.Value2
    } catch {
        # A cell holding an error (#REF!, #DIV/0!) throws on Value2 in some builds. The
        # displayed text still carries the answer, and an error *is* the interesting case here.
        $result.value = $null
    }
    return $result
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

function Invoke-ExcelReadRange {
    param($Request)

    $app = Get-OfficeApp -ProgId 'Excel.Application' -AttachOnly $true
    $wb = Get-Workbook -App $app -Name $Request.workbook
    $sheet = Get-Worksheet -Workbook $wb -Name $Request.sheet
    $range = $sheet.Range($Request.range)

    $limit = 2000
    if ($range.Count -gt $limit) {
        throw "That range holds $($range.Count) cells; ask for at most $limit at a time."
    }

    $cells = @()
    foreach ($cell in $range) { $cells += Read-Cell -Cell $cell }
    return @{ sheet = $sheet.Name; workbook = $wb.Name; cells = $cells }
}

# Walks back from a cell to the cells that feed it, and to the cells that feed those.
#
# This is the "why does this cell say that" question. `Precedents` is Excel's own answer and it
# only covers the current sheet, so cross-sheet references are read out of the formula text as
# well - a formula pointing at another sheet is exactly the case people cannot trace by eye.
function Invoke-ExcelTrace {
    param($Request)

    $app = Get-OfficeApp -ProgId 'Excel.Application' -AttachOnly $true
    $wb = Get-Workbook -App $app -Name $Request.workbook
    $sheet = Get-Worksheet -Workbook $wb -Name $Request.sheet

    $script:traceMaxDepth = 3
    if ($Request.depth) { $script:traceMaxDepth = [Math]::Min([int]$Request.depth, 6) }

    <#
      Script-scoped, not local.

      PowerShell lets a nested function *read* an enclosing variable but an assignment creates a
      new local one, so `$nodes += ...` inside Walk built a copy that was discarded on return -
      the trace came back empty with no error at all. Verified against a real workbook.
    #>
    $script:traceSeen = @{}
    $script:traceNodes = @()

    function Walk {
        param($Sheet, [string]$Address, [int]$Depth)

        $key = "$($Sheet.Name)!$Address"
        if ($script:traceSeen.ContainsKey($key) -or $Depth -gt $script:traceMaxDepth) { return }
        $script:traceSeen[$key] = $true

        $cell = $Sheet.Range($Address)
        $node = Read-Cell -Cell $cell
        $node.sheet = $Sheet.Name
        $node.depth = $Depth

        $feeders = @()
        if ($node.Contains('formula')) {
            try {
                foreach ($p in $cell.Precedents) {
                    $feeders += "$($p.Parent.Name)!$($p.Address($false, $false))"
                }
            } catch {
                # No precedents on this sheet: Excel raises rather than returning an empty range.
            }
            # Cross-sheet references, which `Precedents` does not report.
            foreach ($match in [regex]::Matches($node.formula, "(?:'([^']+)'|([A-Za-z0-9_]+))!(\`$?[A-Z]{1,3}\`$?[0-9]{1,7})")) {
                $sheetName = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
                $feeders += "$sheetName!$($match.Groups[3].Value -replace '\$', '')"
            }
        }
        $node.feeds = @($feeders | Select-Object -Unique)
        $script:traceNodes += $node

        foreach ($feeder in $node.feeds) {
            $parts = $feeder -split '!', 2
            try {
                $next = Get-Worksheet -Workbook $script:traceWorkbook -Name $parts[0]
                Walk -Sheet $next -Address $parts[1] -Depth ($Depth + 1)
            } catch {
                # A reference to a closed workbook or a deleted sheet. Recorded by its absence
                # from the node list rather than failing the whole trace.
            }
        }
    }

    $script:traceWorkbook = $wb
    Walk -Sheet $sheet -Address $Request.cell -Depth 0
    return @{ workbook = $wb.Name; start = "$($sheet.Name)!$($Request.cell)"; nodes = $script:traceNodes }
}

function Get-VbProject {
    param($Workbook)

    try {
        return $Workbook.VBProject
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
function Invoke-OutlookFolders {
    param($Request)

    $ns = Get-OutlookNamespace
    $script:folderList = @()
    $script:folderMaxDepth = 4
    if ($Request -and $Request.depth) { $script:folderMaxDepth = [Math]::Min([int]$Request.depth, 8) }

    function Walk-Folder {
        param($Folder, [string]$Path, [int]$Depth)

        $script:folderList += [ordered]@{
            name   = $Folder.Name
            path   = $Path
            depth  = $Depth
            items  = $Folder.Items.Count
            unread = $Folder.UnReadItemCount
        }
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
    return @{ folders = $script:folderList }
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

    return @{
        subject     = $item.Subject
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
        'excel.sessions'        { return Invoke-ExcelSessions }
        'excel.readRange'       { return Invoke-ExcelReadRange -Request $Request }
        'excel.trace'           { return Invoke-ExcelTrace -Request $Request }
        'excel.listMacros'      { return Invoke-ExcelListMacros -Request $Request }
        'excel.readMacro'       { return Invoke-ExcelReadMacro -Request $Request }
        'excel.writeMacro'      { return Invoke-ExcelWriteMacro -Request $Request }
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
