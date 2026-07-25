param(
    [string]$ZoteroDir = "",
    [string]$DbPath = "",
    [int]$Limit = 500
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if ($Limit -lt 1) { $Limit = 1 }
if ($Limit -gt 5000) { $Limit = 5000 }

$cs = @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class ScientificSourceImporterSqlite {
    [DllImport("winsqlite3.dll", EntryPoint="sqlite3_open16", CharSet=CharSet.Unicode, CallingConvention=CallingConvention.Cdecl)]
    private static extern int sqlite3_open16(string filename, out IntPtr db);
    [DllImport("winsqlite3.dll", CallingConvention=CallingConvention.Cdecl)]
    private static extern int sqlite3_close(IntPtr db);
    [DllImport("winsqlite3.dll", EntryPoint="sqlite3_prepare16_v2", CharSet=CharSet.Unicode, CallingConvention=CallingConvention.Cdecl)]
    private static extern int sqlite3_prepare16_v2(IntPtr db, string sql, int nByte, out IntPtr stmt, IntPtr tail);
    [DllImport("winsqlite3.dll", CallingConvention=CallingConvention.Cdecl)]
    private static extern int sqlite3_step(IntPtr stmt);
    [DllImport("winsqlite3.dll", CallingConvention=CallingConvention.Cdecl)]
    private static extern int sqlite3_finalize(IntPtr stmt);
    [DllImport("winsqlite3.dll", CallingConvention=CallingConvention.Cdecl)]
    private static extern int sqlite3_column_count(IntPtr stmt);
    [DllImport("winsqlite3.dll", EntryPoint="sqlite3_column_name16", CallingConvention=CallingConvention.Cdecl)]
    private static extern IntPtr sqlite3_column_name16(IntPtr stmt, int iCol);
    [DllImport("winsqlite3.dll", EntryPoint="sqlite3_column_text16", CallingConvention=CallingConvention.Cdecl)]
    private static extern IntPtr sqlite3_column_text16(IntPtr stmt, int iCol);
    [DllImport("winsqlite3.dll", EntryPoint="sqlite3_errmsg16", CallingConvention=CallingConvention.Cdecl)]
    private static extern IntPtr sqlite3_errmsg16(IntPtr db);

    private const int SQLITE_ROW = 100;
    private const int SQLITE_DONE = 101;

    private static string Str(IntPtr ptr) {
        return ptr == IntPtr.Zero ? "" : Marshal.PtrToStringUni(ptr);
    }

    public static List<Dictionary<string, string>> Query(string dbPath, string sql) {
        IntPtr db;
        int rc = sqlite3_open16(dbPath, out db);
        if (rc != 0) throw new Exception("sqlite3_open16 failed: " + rc);
        try {
            IntPtr stmt;
            rc = sqlite3_prepare16_v2(db, sql, -1, out stmt, IntPtr.Zero);
            if (rc != 0) throw new Exception("sqlite3_prepare16_v2 failed: " + rc + " " + Str(sqlite3_errmsg16(db)));
            try {
                var rows = new List<Dictionary<string, string>>();
                int count = sqlite3_column_count(stmt);
                while (true) {
                    rc = sqlite3_step(stmt);
                    if (rc == SQLITE_DONE) break;
                    if (rc != SQLITE_ROW) throw new Exception("sqlite3_step failed: " + rc + " " + Str(sqlite3_errmsg16(db)));
                    var row = new Dictionary<string, string>();
                    for (int i = 0; i < count; i++) row[Str(sqlite3_column_name16(stmt, i))] = Str(sqlite3_column_text16(stmt, i));
                    rows.Add(row);
                }
                return rows;
            } finally {
                sqlite3_finalize(stmt);
            }
        } finally {
            sqlite3_close(db);
        }
    }
}
"@

if (-not ("ScientificSourceImporterSqlite" -as [type])) {
    Add-Type -TypeDefinition $cs
}

function Find-VaultRoot {
    $scriptPath = if ($PSCommandPath) { $PSCommandPath } else { $MyInvocation.PSCommandPath }
    $current = Get-Item -LiteralPath (Split-Path -Parent $scriptPath)
    while ($null -ne $current) {
        if (Test-Path -LiteralPath (Join-Path $current.FullName ".obsidian")) { return $current.FullName }
        $current = $current.Parent
    }
    return (Get-Location).Path
}

function Resolve-ConfiguredPath([string]$Raw, [string]$VaultRoot) {
    if ([string]::IsNullOrWhiteSpace($Raw)) { return $null }
    $candidate = $Raw.Trim()
    if ([System.IO.Path]::IsPathRooted($candidate)) { return $candidate }
    return (Join-Path $VaultRoot $candidate)
}

function Test-UncPath([string]$Path) {
    return -not [string]::IsNullOrWhiteSpace($Path) -and $Path.StartsWith("\\")
}

function Assert-SafeDbPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { throw "Путь к базе Zotero пуст" }
    if (Test-UncPath $Path) { throw "Сетевые UNC-пути к базе Zotero отключены" }
    $item = Get-Item -LiteralPath $Path -ErrorAction Stop
    if ($item.PSIsContainer) { throw "Путь к базе Zotero указывает на папку" }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Символические ссылки на базу Zotero отключены" }
    if ($item.Name -ne "zotero.sqlite") { throw "Разрешено читать только zotero.sqlite" }
    if ($item.Length -gt 1024MB) { throw "База Zotero слишком большая" }
    return $item.FullName
}

function Get-DbPath([string]$VaultRoot) {
    $paths = New-Object System.Collections.Generic.List[string]
    $configuredDb = Resolve-ConfiguredPath $DbPath $VaultRoot
    if ($configuredDb) { $paths.Add($configuredDb) }
    $configuredDir = Resolve-ConfiguredPath $ZoteroDir $VaultRoot
    if ($configuredDir) { $paths.Add((Join-Path $configuredDir "zotero.sqlite")) }
    $paths.Add((Join-Path $VaultRoot "Zotero\zotero.sqlite"))
    $paths.Add((Join-Path $env:USERPROFILE "Zotero\zotero.sqlite"))
    $seen = @{}
    foreach ($path in $paths) {
        if ([string]::IsNullOrWhiteSpace($path)) { continue }
        $key = $path.ToLowerInvariant()
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        if (Test-Path -LiteralPath $path) { return Assert-SafeDbPath $path }
    }
    throw "Не найдена база Zotero"
}

function Copy-DbForRead([string]$SourcePath) {
    $target = Join-Path ([System.IO.Path]::GetTempPath()) ("zotero-import-" + [System.Guid]::NewGuid().ToString("N") + ".sqlite")
    Copy-Item -LiteralPath (Assert-SafeDbPath $SourcePath) -Destination $target -Force
    return $target
}

function Invoke-Sql([string]$Sql) {
    return ,[ScientificSourceImporterSqlite]::Query($script:TempDbPath, $Sql)
}

function Assert-IntegerId([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch "^\d+$") { throw "Некорректный ID Zotero" }
    return $Value
}

function Get-Fields([string]$ItemId) {
    $ItemId = Assert-IntegerId $ItemId
    $rows = Invoke-Sql @"
select f.fieldName as name, v.value as value
from itemData id
join itemDataValues v on v.valueID = id.valueID
join fieldsCombined f on f.fieldID = id.fieldID
where id.itemID = $ItemId
"@
    $fields = @{}
    foreach ($row in $rows) { $fields[$row["name"]] = $row["value"] }
    return $fields
}

function Get-ItemType([string]$ItemId) {
    $rows = Invoke-Sql "select t.typeName as typeName from items i join itemTypes t on t.itemTypeID = i.itemTypeID where i.itemID = $(Assert-IntegerId $ItemId)"
    if ($rows.Count -gt 0) { return $rows[0]["typeName"] }
    return ""
}

function Get-ItemKey([string]$ItemId) {
    $rows = Invoke-Sql "select key as key from items where itemID = $(Assert-IntegerId $ItemId)"
    if ($rows.Count -gt 0) { return $rows[0]["key"] }
    return ""
}

function Get-Authors([string]$ItemId) {
    $rows = Invoke-Sql @"
select ic.orderIndex as orderIndex, c.firstName as firstName, c.lastName as lastName
from itemCreators ic
join creators c on c.creatorID = ic.creatorID
where ic.itemID = $(Assert-IntegerId $ItemId)
order by ic.orderIndex
"@
    $authors = @()
    foreach ($row in $rows) {
        $authors += [ordered]@{
            order = [int]$row["orderIndex"]
            first_name = if ($row["firstName"]) { $row["firstName"] } else { "" }
            last_name = if ($row["lastName"]) { $row["lastName"] } else { "" }
        }
    }
    return $authors
}

function Test-SafeRelativeStoragePath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    if ([System.IO.Path]::IsPathRooted($Path)) { return $false }
    if (Test-UncPath $Path) { return $false }
    foreach ($part in @($Path -split "[\\/]+" | Where-Object { $_ })) {
        if ($part -eq "." -or $part -eq "..") { return $false }
    }
    return $true
}

function Test-SafePdfFile([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    if (Test-UncPath $Path) { return $false }
    if ([System.IO.Path]::GetExtension($Path).ToLowerInvariant() -ne ".pdf") { return $false }
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $item = Get-Item -LiteralPath $Path -ErrorAction Stop
    if ($item.PSIsContainer) { return $false }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
    return $true
}

function Resolve-AttachmentPath([string]$AttachmentId, [string]$RawPath) {
    if ([string]::IsNullOrWhiteSpace($RawPath)) { return "" }
    if (-not $RawPath.StartsWith("storage:")) { return "" }
    $relativeName = $RawPath.Substring("storage:".Length)
    if (-not (Test-SafeRelativeStoragePath $relativeName)) { return "" }
    $attachmentKey = Get-ItemKey $AttachmentId
    if (-not (Test-SafeRelativeStoragePath $attachmentKey)) { return "" }
    $candidate = Join-Path (Join-Path $script:ZoteroRoot "storage") (Join-Path $attachmentKey $relativeName)
    if (Test-SafePdfFile $candidate) { return (Get-Item -LiteralPath $candidate).FullName }
    $attachmentDir = Join-Path (Join-Path $script:ZoteroRoot "storage") $attachmentKey
    if (Test-Path -LiteralPath $attachmentDir) {
        $pdfs = @(Get-ChildItem -LiteralPath $attachmentDir -File -Filter "*.pdf" -ErrorAction SilentlyContinue | Where-Object { Test-SafePdfFile $_.FullName })
        if ($pdfs.Count -eq 1) { return $pdfs[0].FullName }
    }
    return ""
}

function Get-Attachments([string]$ItemId) {
    $rows = Invoke-Sql "select itemID as itemID, contentType as contentType, path as path from itemAttachments where parentItemID = $(Assert-IntegerId $ItemId) order by itemID"
    $attachments = @()
    foreach ($row in $rows) {
        $path = Resolve-AttachmentPath $row["itemID"] $row["path"]
        if ($path) {
            $attachments += [ordered]@{
                item_id = [int]$row["itemID"]
                content_type = if ($row["contentType"]) { $row["contentType"] } else { "" }
                path = $path
            }
        }
    }
    return $attachments
}

function Build-Item([string]$ItemId) {
    $fields = Get-Fields $ItemId
    $attachments = @(Get-Attachments $ItemId | Where-Object { $_.path -and $_.content_type -eq "application/pdf" })
    if ($attachments.Count -eq 0) { return $null }
    return [ordered]@{
        zotero_item_id = [int]$ItemId
        zotero_key = Get-ItemKey $ItemId
        item_type = Get-ItemType $ItemId
        citation_key = if ($fields.citationKey) { $fields.citationKey } else { "" }
        title = if ($fields.title) { $fields.title } else { "" }
        short_title = if ($fields.shortTitle) { $fields.shortTitle } else { "" }
        date = if ($fields.date) { $fields.date } else { "" }
        publication_title = if ($fields.publicationTitle) { $fields.publicationTitle } else { "" }
        publisher = if ($fields.publisher) { $fields.publisher } else { "" }
        place = if ($fields.place) { $fields.place } else { "" }
        volume = if ($fields.volume) { $fields.volume } else { "" }
        issue = if ($fields.issue) { $fields.issue } else { "" }
        pages = if ($fields.pages) { $fields.pages } else { "" }
        doi = if ($fields.DOI) { $fields.DOI } elseif ($fields.doi) { $fields.doi } else { "" }
        issn = if ($fields.ISSN) { $fields.ISSN } elseif ($fields.issn) { $fields.issn } else { "" }
        url = if ($fields.url) { $fields.url } else { "" }
        abstract = if ($fields.abstractNote) { $fields.abstractNote } else { "" }
        language = if ($fields.language) { $fields.language } else { "" }
        authors = @(Get-Authors $ItemId)
        pdf_paths = @($attachments | ForEach-Object { $_.path })
    }
}

$vaultRoot = Find-VaultRoot
$sourceDbPath = Get-DbPath $vaultRoot
$script:ZoteroRoot = Split-Path -Parent $sourceDbPath
$script:TempDbPath = Copy-DbForRead $sourceDbPath

try {
    $rows = Invoke-Sql @"
select i.itemID as itemID
from items i
where i.itemID not in (select itemID from deletedItems)
  and exists (select 1 from itemAttachments a where a.parentItemID = i.itemID and lower(a.contentType) = 'application/pdf')
order by i.dateModified desc
limit $Limit
"@
    $items = @()
    foreach ($row in $rows) {
        $item = Build-Item $row["itemID"]
        if ($null -ne $item) { $items += $item }
    }
    [ordered]@{
        zotero_dir = $script:ZoteroRoot
        db_path = $sourceDbPath
        count = $items.Count
        items = $items
    } | ConvertTo-Json -Depth 20
} finally {
    if ($script:TempDbPath -and (Test-Path -LiteralPath $script:TempDbPath)) {
        Remove-Item -LiteralPath $script:TempDbPath -Force -ErrorAction SilentlyContinue
    }
}
