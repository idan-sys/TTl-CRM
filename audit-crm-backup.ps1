param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Path
)

$ErrorActionPreference = 'Stop'

function Get-FirstFieldValue {
    param(
        [object]$Record,
        [string[]]$Names
    )

    foreach ($name in $Names) {
        $property = $Record.PSObject.Properties[$name]
        if ($null -ne $property -and $null -ne $property.Value) {
            return $property.Value
        }
    }

    return ''
}

function Get-ProjectFamily {
    param([string]$ProjectType)

    $eggWord = -join [char[]]@(0x05D1, 0x05D9, 0x05E6, 0x05D9, 0x05EA)
    $surrogacyWord = -join [char[]]@(0x05E4, 0x05D5, 0x05E0, 0x05D3, 0x05E7, 0x05D0, 0x05D5, 0x05EA)
    if ($ProjectType.Contains($eggWord)) { return 'Egg donation' }
    if ($ProjectType.Contains($surrogacyWord)) { return 'Surrogacy' }
    return 'Unknown'
}

function Get-DuplicateSummary {
    param(
        [object[]]$Records,
        [bool]$NormalizeNames
    )

    $groups = @{}
    foreach ($record in $Records) {
        $name = [string](Get-FirstFieldValue $record @('name', 'client_name', 'fullName', 'clientName'))
        $project = [string](Get-FirstFieldValue $record @('project', 'project_type', 'projectType'))
        if ([string]::IsNullOrWhiteSpace($name)) { continue }

        $family = Get-ProjectFamily $project
        $keyName = $name.Trim().ToLowerInvariant()
        if ($NormalizeNames) {
            $keyName = $keyName.Normalize([System.Text.NormalizationForm]::FormKC)
            $keyName = [regex]::Replace($keyName, '[\s\p{P}\p{S}\p{M}]', '')
        }

        $key = $family + '|' + $keyName
        if ($groups.ContainsKey($key)) {
            $groups[$key]++
        } else {
            $groups[$key] = 1
        }
    }

    $duplicateGroups = @($groups.Values | Where-Object { $_ -gt 1 })
    $extraRows = 0
    foreach ($count in $duplicateGroups) {
        $extraRows += $count - 1
    }

    return @{
        Groups = $duplicateGroups.Count
        ExtraRows = $extraRows
    }
}

if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Write-Error 'Backup file was not found.'
    exit 1
}

try {
    $backup = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    Write-Error 'Could not parse the JSON backup.'
    exit 1
}

if ($backup -is [System.Array]) {
    $records = @($backup)
} elseif ($backup.clients -is [System.Array]) {
    $records = @($backup.clients)
} elseif ($backup.projects -is [System.Array]) {
    $records = @($backup.projects)
} else {
    Write-Error 'The JSON file does not contain a clients or projects array.'
    exit 1
}

$activeRecords = @($records | Where-Object {
    $deleted = Get-FirstFieldValue $_ @('is_deleted', 'isDeleted')
    $deleted -ne $true
})
$deletedCount = $records.Count - $activeRecords.Count
$eggCount = @($activeRecords | Where-Object {
    (Get-ProjectFamily ([string](Get-FirstFieldValue $_ @('project', 'project_type', 'projectType')))) -eq 'Egg donation'
}).Count
$surrogacyCount = @($activeRecords | Where-Object {
    (Get-ProjectFamily ([string](Get-FirstFieldValue $_ @('project', 'project_type', 'projectType')))) -eq 'Surrogacy'
}).Count
$unknownCount = $activeRecords.Count - $eggCount - $surrogacyCount
$exactDuplicates = Get-DuplicateSummary $activeRecords $false
$normalizedDuplicates = Get-DuplicateSummary $activeRecords $true
$missingAgreements = @($activeRecords | Where-Object {
    $url = [string](Get-FirstFieldValue $_ @('contractUrl', 'agreement_url', 'agreementUrl'))
    $uri = $null
    -not [uri]::TryCreate($url, [System.UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne 'https'
}).Count

Write-Output 'CRM backup audit (aggregate counts only; no client names or contact data are printed)'
Write-Output ('Records total: {0}' -f $records.Count)
Write-Output ('Active records: {0}' -f $activeRecords.Count)
Write-Output ('Egg donation: {0}' -f $eggCount)
Write-Output ('Surrogacy: {0}' -f $surrogacyCount)
Write-Output ('Unknown project type: {0}' -f $unknownCount)
Write-Output ('Deleted/recycled records: {0}' -f $deletedCount)
Write-Output ('Exact duplicate name/project groups: {0}; extra records: {1}' -f $exactDuplicates.Groups, $exactDuplicates.ExtraRows)
Write-Output ('Normalized name/project groups to review: {0}; extra records: {1}' -f $normalizedDuplicates.Groups, $normalizedDuplicates.ExtraRows)
Write-Output ('Missing or non-HTTPS agreement links: {0}' -f $missingAgreements)
