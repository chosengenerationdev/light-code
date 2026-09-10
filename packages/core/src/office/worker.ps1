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

<#
  Transient COM failures, and why retrying is not papering over anything.

  Measured, not assumed: with a cell open for editing - which is the state a person is in
  whenever they are typing - **every** COM call into Excel fails with

      0x80010001  RPC_E_CALL_REJECTED  "Call was rejected by callee"

  It is not an error in any useful sense. Excel is simply not accepting calls this instant, and
  the same call a moment later succeeds. Surfacing it reads as the feature being broken, which
  is exactly how it was reported.

  Three codes are treated this way and no others:
    0x80010001  RPC_E_CALL_REJECTED         - busy, editing a cell, or a dialog is up
    0x8001010A  RPC_E_SERVERCALL_RETRYLATER - the message filter says come back
    0x800AC472  VBA_E_IGNORE                - Excel refusing automation mid-recalculation

  Everything else is a real failure and is raised immediately. A blanket retry would turn a
  genuine "no such sheet" into four seconds of silence and then the same error.
#>
$script:transientComCodes = @('0x80010001', '0x8001010A', '0x800AC472')

function Get-ComErrorCode {
    param($ErrorRecord)

    $ex = $ErrorRecord.Exception
    # COM failures arrive wrapped - often twice - and only the innermost carries the HRESULT.
    $depth = 0
    while ($null -ne $ex.InnerException -and $depth -lt 8) { $ex = $ex.InnerException; $depth++ }
    try { return ('0x{0:X8}' -f [int]$ex.HResult) } catch { return '' }
}

function Invoke-ComWithRetry {
    param([scriptblock]$Action, [int]$Attempts = 5)

    $delayMs = 200
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            return & $Action
        } catch {
            $code = Get-ComErrorCode -ErrorRecord $_
            if ($attempt -ge $Attempts -or $script:transientComCodes -notcontains $code) { throw }
            Start-Sleep -Milliseconds $delayMs
            # Backed off rather than hammered: someone typing a sentence into a cell holds Excel
            # for seconds, and five rapid attempts inside half a second would all fail.
            $delayMs = [Math]::Min($delayMs * 2, 2000)
        }
    }
}

<#
  Turns a COM failure into something a person can act on.

  The default text is unusable: "Call was rejected by callee" tells the user nothing about their
  spreadsheet, and the previous version of this passed it straight through. Naming the actual
  cause - and what to do about it - is the whole difference between a bug report and a fix.
#>
function Get-ComErrorAdvice {
    param([string]$Code, [string]$Operation)

    switch ($Code) {
        '0x80010001' {
            return "Excel would not accept the request ($Operation). It is busy: most often a cell is open for editing, or a dialog is waiting. Press Escape in Excel, click away from any cell being edited, and try again."
        }
        '0x8001010A' {
            return "Excel is busy and asked to be called back later ($Operation). It may be recalculating or opening a large workbook. Wait for it to settle and try again."
        }
        '0x800AC472' {
            return "Excel refused automation while it was recalculating ($Operation). Let the calculation finish and try again."
        }
        '0x800401E3' {
            return "Excel is not running, or is not reachable from here ($Operation)."
        }
        default { return '' }
    }
}

<#
  Every running Excel, not just the one Windows happens to nominate.

  ## The defect this fixes

  Measured with two Excel windows open, each holding a workbook:

      GetActiveObject     -> reached ONE instance, saw Book1 only
      Running Object Table -> zero Excel documents (unsaved workbooks register nothing)

  So the second workbook was invisible. In an office that is the ordinary case rather than an
  edge one - a workbook opened from mail gets its own instance, Protected View gets its own
  instance, and people simply start a second Excel. Asked about a spreadsheet plainly on screen,
  the tools answered that it was not open.

  ## How this reaches them

  Every top-level `XLMAIN` window is enumerated, and for each the workbook pane two levels down
  (`XLMAIN > XLDESK > EXCEL7`) is asked for its native object model through
  `AccessibleObjectFromWindow`. That yields a Window, whose `.Application` is the instance. It is
  the only approach that finds an instance the ROT never registered.

  `out object` must be marshalled as IUnknown explicitly; without it the call fails with
  "Specified OLE variant is invalid", which is what the first attempt did.
#>
function Initialize-ExcelWindowFinder {
    if ($script:excelWindowFinderReady) { return }
    $definition = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class LightCodeExcelWindows {
    delegate bool EnumProc(IntPtr hwnd, IntPtr param);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr param);
    [DllImport("user32.dll")] static extern IntPtr FindWindowExA(IntPtr parent, IntPtr after, string cls, string title);
    [DllImport("user32.dll")] static extern int GetClassNameA(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(
        IntPtr hwnd, uint id, ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object obj);

    public static List<object> Panes() {
        var tops = new List<IntPtr>();
        EnumWindows((hwnd, p) => {
            var name = new StringBuilder(64);
            GetClassNameA(hwnd, name, name.Capacity);
            if (name.ToString() == "XLMAIN") { tops.Add(hwnd); }
            return true;
        }, IntPtr.Zero);

        var found = new List<object>();
        foreach (var top in tops) {
            IntPtr desk = FindWindowExA(top, IntPtr.Zero, "XLDESK", null);
            if (desk == IntPtr.Zero) { continue; }
            IntPtr pane = FindWindowExA(desk, IntPtr.Zero, "EXCEL7", null);
            if (pane == IntPtr.Zero) { continue; }

            var iid = new Guid("00020400-0000-0000-C000-000000000046");
            object window;
            if (AccessibleObjectFromWindow(pane, 0xFFFFFFF0, ref iid, out window) == 0 && window != null) {
                found.Add(window);
            }
        }
        return found;
    }
}
'@
    Add-Type -TypeDefinition $definition
    $script:excelWindowFinderReady = $true
}

function Get-ExcelInstances {
    $instances = @()
    $seen = @{}

    try {
        Initialize-ExcelWindowFinder
        foreach ($pane in [LightCodeExcelWindows]::Panes()) {
            try {
                $app = $pane.Application
                $key = [string]$app.Hwnd
                if ($seen.ContainsKey($key)) { continue }
                $seen[$key] = $true
                $instances += $app
            } catch {
                # A window mid-teardown, or one that will not hand over its object model.
            }
        }
    } catch {
        # No window enumeration available. The fallbacks below still find the usual single case.
    }

    # Fallbacks, in the order they are likely to work. Both reach at most one instance, which is
    # exactly the limitation the enumeration above exists to remove - but either is better than
    # none when it fails.
    if ($instances.Count -eq 0) {
        try {
            $app = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application')
            $instances += $app
        } catch { }
    }
    if ($instances.Count -eq 0) {
        $app = Get-ExcelViaRot
        if ($null -ne $app) { $instances += $app }
    }

    return $instances
}

<#
  Finds a workbook by name across every running Excel.

  Searching one instance was the old behaviour and is why a workbook in a second window reported
  as not open. Matching is on name or full path, and is case-insensitive because nobody types a
  file name back exactly as Windows stored it.
#>
function Find-ExcelWorkbook {
    param([string]$Name)

    $instances = Get-ExcelInstances
    if ($instances.Count -eq 0) { throw (Get-AttachFailureMessage -ProgId 'Excel.Application') }

    if ([string]::IsNullOrWhiteSpace($Name)) {
        foreach ($app in $instances) {
            try {
                if ($app.Workbooks.Count -gt 0) {
                    $active = $app.ActiveWorkbook
                    if ($null -ne $active) { return @{ app = $app; workbook = $active } }
                }
            } catch { }
        }
        throw 'No workbook is open in Excel.'
    }

    $available = @()
    foreach ($app in $instances) {
        try {
            foreach ($wb in $app.Workbooks) {
                $available += $wb.Name
                if ($wb.Name -eq $Name -or $wb.FullName -eq $Name) { return @{ app = $app; workbook = $wb } }
            }
        } catch { }
    }
    # Second pass, case-insensitively, so a name typed back in lower case still matches.
    foreach ($app in $instances) {
        try {
            foreach ($wb in $app.Workbooks) {
                if ($wb.Name -ieq $Name -or $wb.FullName -ieq $Name) { return @{ app = $app; workbook = $wb } }
            }
        } catch { }
    }

    $list = if ($available.Count -gt 0) { ' Open now: ' + ($available -join ', ') + '.' } else { ' Nothing is open.' }
    throw "No open workbook named '$Name'.$list Call excel_sessions to see what is open."
}

<#
  A workbook by name, wherever it is open.

  `$App` is accepted and ignored on purpose: every caller already had one to hand, and threading
  the instance through was how the search came to be confined to a single Excel in the first
  place. `Find-ExcelWorkbook` looks across all of them - see the note there for the measurement
  that made that necessary.
#>
function Get-Workbook {
    param($App, [string]$Name)

    return (Find-ExcelWorkbook -Name $Name).workbook
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

<#
  Every open workbook, across every running Excel.

  It used to list one instance's workbooks, which is why a spreadsheet plainly on screen could be
  reported as not open: a workbook opened from mail, or in Protected View, or in a second Excel
  someone started, lives in a different process entirely. Measured with two instances open,
  `GetActiveObject` saw one of the two.

  `instance` is carried through so a person can tell two identically named `Book1`s apart, which
  is exactly what a second Excel gives you.
#>
<#
  A report on why Excel automation is or is not working on this machine.

  Written because the failures that remain are environmental, and an environment cannot be
  reproduced from a bug report that says it did not work. Every line here answers a question that
  has actually had to be asked: is Excel even running, how many of it, can we reach each one, is
  it accepting calls this instant, is the VBA object model reachable, and are we and Excel at the
  same privilege level.

  It reads state and changes nothing, so it is safe to run at any time - including while Excel is
  mid-edit, which is a state it specifically reports rather than failing on.
#>
function Invoke-ExcelDiagnose {
    $report = [ordered]@{}

    # --- the process, before any COM at all -------------------------------------------------
    $processes = @()
    try { $processes = @(Get-Process -Name 'EXCEL' -ErrorAction SilentlyContinue) } catch { }
    $report.excelProcesses = $processes.Count
    $report.windowTitles = @($processes | ForEach-Object { $_.MainWindowTitle } | Where-Object { $_ })

    # --- who we are, since a mismatch is invisible from inside ------------------------------
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        $report.weAreElevated = [bool]$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        $report.user = [string]$identity.Name
    } catch {
        $report.weAreElevated = $null
    }

    # --- each route to an instance, reported separately -------------------------------------
    $report.getActiveObject = 'not tried'
    try {
        $null = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application')
        $report.getActiveObject = 'reached one instance'
    } catch {
        $report.getActiveObject = 'failed: ' + (Get-ComErrorCode -ErrorRecord $_)
    }

    $rotCount = 0
    try {
        foreach ($name in Get-RotNames) {
            $extension = ''
            try { $extension = [System.IO.Path]::GetExtension($name).ToLowerInvariant() } catch { continue }
            if ($script:excelExtensions -contains $extension) { $rotCount++ }
        }
    } catch { }
    $report.rotExcelDocuments = $rotCount

    $instances = @()
    try { $instances = Get-ExcelInstances } catch { }
    $report.instancesReached = $instances.Count

    # --- what each instance holds, and whether it is answering right now --------------------
    $details = @()
    $index = 0
    foreach ($app in $instances) {
        $index++
        $entry = [ordered]@{ instance = $index }
        try { $entry.version = [string]$app.Version } catch { $entry.version = 'unreadable' }

        <#
          One deliberately trivial call, without the retry wrapper.

          The point is to report the *current* state rather than to succeed: if Excel is mid-edit
          this is exactly the rejection the user is hitting, and saying so is the whole reason
          this function exists.
        #>
        try {
            $null = $app.Ready
            $entry.acceptingCalls = $true
        } catch {
            $entry.acceptingCalls = $false
            $entry.rejectionCode = Get-ComErrorCode -ErrorRecord $_
        }

        try {
            $books = @()
            foreach ($wb in $app.Workbooks) { $books += $wb.Name }
            $entry.workbooks = $books
        } catch {
            $entry.workbooks = @()
            $entry.workbooksUnreadable = $true
        }

        # Trust Center, which returns *null* rather than throwing when access is off - the trap
        # that once made every workbook report as having no VBA at all.
        try {
            $first = $null
            try { $first = $app.Workbooks.Item(1) } catch { }
            if ($null -ne $first) {
                $project = $null
                try { $project = $first.VBProject } catch { }
                $entry.vbaAccessible = ($null -ne $project)
            }
        } catch { }

        $details += $entry
    }
    $report.instances = $details

    # --- the conclusion, so nobody has to infer it from the fields above --------------------
    $advice = @()
    if ($processes.Count -eq 0) {
        $advice += 'Excel is not running. Open the workbook and try again.'
    } elseif ($instances.Count -eq 0) {
        $advice += 'Excel is running but cannot be reached. The usual cause is a privilege mismatch: if VS Code runs as administrator and Excel does not, or the other way round, Windows keeps them apart. Start both the same way.'
    } elseif ($instances.Count -lt $processes.Count) {
        $advice += 'Some Excel processes could not be reached. A window in Protected View refuses automation; open the workbook properly (Enable Editing) if it is one of those.'
    }
    foreach ($entry in $details) {
        if ($entry.acceptingCalls -eq $false) {
            $advice += ('Instance ' + $entry.instance + ' is refusing calls right now (' + $entry.rejectionCode + '). A cell is probably open for editing, or a dialog is waiting. Press Escape in Excel.')
        }
        if ($entry.vbaAccessible -eq $false) {
            $advice += ('Instance ' + $entry.instance + ' will not expose its VBA project. Turn on File > Options > Trust Center > Trust Center Settings > Macro Settings > "Trust access to the VBA project object model" if you need macro tools.')
        }
    }
    if ($advice.Count -eq 0) { $advice += 'Excel is reachable and answering. If a specific tool still fails, the problem is in that tool rather than in the connection.' }
    $report.advice = $advice

    return $report
}

function Invoke-ExcelSessions {
    $instances = Get-ExcelInstances
    if ($instances.Count -eq 0) { throw (Get-AttachFailureMessage -ProgId 'Excel.Application') }

    $sessions = @()
    $version = ''
    $index = 0
    foreach ($app in $instances) {
        $index++
        try {
            if ($version -eq '') { $version = [string]$app.Version }
            $activeName = ''
            try { $activeName = [string]$app.ActiveWorkbook.Name } catch { }

            foreach ($wb in $app.Workbooks) {
                $sheets = @()
                foreach ($sheet in $wb.Worksheets) { $sheets += $sheet.Name }
                $sessions += [ordered]@{
                    name     = $wb.Name
                    fullName = $wb.FullName
                    saved    = [bool]$wb.Saved
                    sheets   = $sheets
                    active   = ($wb.Name -eq $activeName)
                    instance = $index
                    readOnly = [bool]$wb.ReadOnly
                }
            }
        } catch {
            # One unreachable instance must not hide the others. A Protected View window in
            # particular refuses most of its object model, and reporting the rest is right.
        }
    }
    return @{ workbooks = $sessions; version = $version; instances = $instances.Count }
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

<#
  Collects messages for the index, and reopens one on request.

  ## Why this is not Invoke-OutlookSearch with a bigger limit

  Searching answers a question now; harvesting builds a corpus incrementally, and the difference
  is entirely in what it must not do. It runs unattended on a timer, so it cannot walk a whole
  mailbox each time, cannot read a property that costs a server round trip per item, and cannot
  return bodies large enough to make the transport the bottleneck.

  So the date filter is pushed into Outlook with the same DASL restriction Invoke-OutlookSearch
  already uses - deliberately the same, because DASL takes an ISO-ish timestamp and is therefore
  locale-independent, where the Jet syntax parses dates with the machine's own short-date pattern
  and silently returns the wrong window on a day-first machine.

  Only a preview of the body travels. The full body is never needed here: the model gets metadata
  and an opening, and opens the real message when the user wants to read it.
#>
function Invoke-OutlookHarvest {
    param($Request)

    $ns = Get-OutlookNamespace

    $limit = 500
    if ($Request.limit) { $limit = [Math]::Min([int]$Request.limit, 2000) }
    $previewChars = 400
    if ($Request.previewChars) { $previewChars = [Math]::Min([int]$Request.previewChars, 2000) }

    $harvested = @()
    $truncated = $false

    foreach ($request in $Request.folders) {
        if ($harvested.Count -ge $limit) { $truncated = $true; break }

        $folder = $null
        try {
            $folder = Get-OutlookFolder -Namespace $ns -Path $request.path
        } catch {
            # A folder that has been renamed or removed since it was configured. Skipped rather
            # than failing the whole run, which would stop every other folder indexing too.
            continue
        }
        if ($null -eq $folder) { continue }

        $items = $folder.Items
        $items.Sort('[ReceivedTime]', $true)

        if ($request.sinceMs) {
            $since = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$request.sinceMs).LocalDateTime
            $stamp = $since.ToString('yyyy-MM-dd HH:mm')
            try {
                $items = $items.Restrict("@SQL=urn:schemas:httpmail:datereceived >= '$stamp'")
            } catch {
                # An unparseable restriction is worse than none: fall back to the sorted
                # collection and let the count limit do the bounding.
            }
        }

        foreach ($item in $items) {
            if ($harvested.Count -ge $limit) { $truncated = $true; break }
            # Mail folders hold other things too - meeting requests, delivery reports. 43 is
            # olMail; anything else has no ReceivedTime worth indexing.
            $class = 0
            try { $class = [int]$item.Class } catch { continue }
            if ($class -ne 43) { continue }

            $received = $null
            try { $received = $item.ReceivedTime } catch { continue }
            if ($null -eq $received) { continue }

            $entryId = ''
            try { $entryId = [string]$item.EntryID } catch { continue }
            if ([string]::IsNullOrWhiteSpace($entryId)) { continue }

            $subject = ''
            try { if ($item.Subject) { $subject = [string]$item.Subject } } catch { }

            $sender = ''
            try {
                if ($item.SenderName) { $sender = [string]$item.SenderName }
                if ($item.SenderEmailAddress) { $sender = ($sender + ' <' + [string]$item.SenderEmailAddress + '>').Trim() }
            } catch { }

            $preview = ''
            try {
                if ($item.Body) {
                    $body = [string]$item.Body
                    if ($body.Length -gt $previewChars) { $preview = $body.Substring(0, $previewChars) }
                    else { $preview = $body }
                }
            } catch { }

            $harvested += [ordered]@{
                id         = $entryId
                subject    = $subject
                sender     = $sender
                receivedAt = [int64]([DateTimeOffset]::new($received).ToUnixTimeMilliseconds())
                folder     = [string]$request.path
                preview    = $preview
            }
        }
    }

    return @{ messages = $harvested; truncated = $truncated }
}

<#
  Shows one message on screen.

  `Display` opens Outlook's own read window - the real message, with its formatting, exactly as
  the user would see it if they had found it themselves. Nothing is modified and nothing is sent.
#>
function Invoke-OutlookDisplay {
    param($Request)

    $ns = Get-OutlookNamespace

    $item = $null
    try {
        $item = $ns.GetItemFromID($Request.id)
    } catch {
        throw 'No message with that id is still in the mailbox. It may have been moved or deleted since it was indexed.'
    }
    if ($null -eq $item) { throw 'That message could not be opened.' }

    $subject = ''
    try { if ($item.Subject) { $subject = [string]$item.Subject } } catch { }
    $item.Display()
    return @{ subject = $subject; opened = $true }
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
        'excel.diagnose'        { return Invoke-ExcelDiagnose }
        'excel.readRange'       { return Invoke-ExcelReadRange -Request $Request }
        'excel.trace'           { return Invoke-ExcelTrace -Request $Request }
        'excel.listMacros'      { return Invoke-ExcelListMacros -Request $Request }
        'excel.readMacro'       { return Invoke-ExcelReadMacro -Request $Request }
        'excel.writeMacro'      { return Invoke-ExcelWriteMacro -Request $Request }
        'excel.runMacro'        { return Invoke-ExcelRunMacro -Request $Request }
        'excel.evaluate'        { return Invoke-ExcelEvaluate -Request $Request }
        'outlook.folders'       { return Invoke-OutlookFolders -Request $Request }
        'outlook.harvest'       { return Invoke-OutlookHarvest -Request $Request }
        'outlook.display'       { return Invoke-OutlookDisplay -Request $Request }
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
        <#
          Retried as a whole, rather than each COM call individually.

          A rejected call leaves nothing half-done - Excel declined to start it - so repeating the
          operation is safe, and wrapping here covers every op including ones added later. The
          alternative, sprinkling retries through each function, is the shape that gets forgotten
          exactly once and then fails intermittently for a year.
        #>
        $result = Invoke-ComWithRetry -Action { Invoke-Request -Request $request }
        $response = [ordered]@{ id = $id; ok = $true; result = $result }
    } catch {
        # Errors come back as data, never as a crashed process: one bad range should not take
        # down a session that took a second to attach and holds the user's open workbook.
        $code = Get-ComErrorCode -ErrorRecord $_
        $advice = Get-ComErrorAdvice -Code $code -Operation ([string]$request.op)
        $detail = if ($advice -ne '') { $advice } else { $_.Exception.Message }
        $response = [ordered]@{ id = $id; ok = $false; error = $detail }
    }
    [Console]::Out.WriteLine(($response | ConvertTo-Json -Depth 12 -Compress))
    [Console]::Out.Flush()
}
