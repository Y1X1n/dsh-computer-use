<#
.SYNOPSIS
    Configure GitHub branch protection for main/master via the gh CLI.

.DESCRIPTION
    Applies the mandatory-PR policy to a protected branch:

      - required_pull_request_reviews with required_approving_review_count = 0
        (single-maintainer project: a PR must exist, but needs no approvals)
      - allow_force_pushes = false
      - allow_deletions   = false
      - enforce_admins    = true
      - required_status_checks: none (CI is not stable yet; intentionally left
        empty so merges are not blocked. Tighten later via -RequireCiChecks.)

    The script needs the GitHub API variant that only exists for public repos
    or paid plans (Pro/Team/Enterprise). On a private repo on a free plan the
    API answers 403; this script catches that, prints a clear fallback
    explanation and still exits with a defined code so callers can react.

    Repository resolution order:
      1. -Owner/-Repo parameters
      2. git remote "origin" of the current repository (via gh's own resolution)

    This script never deletes an existing ruleset and only touches the one
    branch given via -Branch (default: main).

.PARAMETER Branch
    Branch to protect. Default: main.

.PARAMETER Owner, Repo
    Target repository. Defaults: resolved from git remote origin / gh.

.PARAMETER RequireCiChecks
    Also require these status check names to pass before merging
    (e.g. -RequireCiChecks ci/windows, ci/ubuntu). Off by default.

.PARAMETER DryRun
    Print the exact gh api call that would be made, then exit without
    touching anything.

.EXAMPLE
    pwsh scripts/guard/set-branch-protection.ps1
    pwsh scripts/guard/set-branch-protection.ps1 -Branch main -DryRun
    pwsh scripts/guard/set-branch-protection.ps1 -Owner Y1X1n -Repo dsh-computer-use

.NOTES
    Exit codes:
      0 = branch protection applied (or skipped in DryRun) - see codes below
      1 = gh missing / not authenticated / other gh api failure
      2 = 403 (plan not eligible - local-only protection mode, see output)
#>
[CmdletBinding()]
param(
    [string]$Branch = 'main',

    [string]$Owner = '',

    [string]$Repo = '',

    [string[]]$RequireCiChecks = @(),

    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Colored output helpers
# ---------------------------------------------------------------------------
function Write-Info  { param([string]$Message) Write-Host "[branch-protection] $Message" }
function Write-Ok    { param([string]$Message) Write-Host "[branch-protection] OK: $Message" -ForegroundColor Green }
function Write-Warn2 { param([string]$Message) Write-Host "[branch-protection] WARN: $Message" -ForegroundColor Yellow }
function Write-Err2  { param([string]$Message) Write-Host "[branch-protection] ERROR: $Message" -ForegroundColor Red }

# ---------------------------------------------------------------------------
# 1. Preflight: gh CLI present?
# ---------------------------------------------------------------------------
$gh = Get-Command gh -ErrorAction SilentlyContinue
if (-not $gh) {
    Write-Err2 "GitHub CLI (gh) not found on PATH."
    Write-Info  "Install it from https://cli.github.com/ , then run: gh auth login"
    exit 1
}

$authStatus = & gh auth status 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Err2 "gh is not authenticated. Run 'gh auth login' first."
    Write-Info "gh auth status output:"
    Write-Info ($authStatus | Out-String).Trim()
    exit 1
}

# ---------------------------------------------------------------------------
# 2. Resolve owner/repo (parameters > git remote origin)
# ---------------------------------------------------------------------------
if (-not $Owner -or -not $Repo) {
    $repoSlug = (& gh repo view --json nameWithOwner -q .nameWithOwner 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $repoSlug) {
        Write-Err2 "Could not resolve owner/repo. Run inside the repo with an 'origin' remote, or pass -Owner and -Repo."
        exit 1
    }
    $parts = $repoSlug -split '/', 2
    if ($parts.Count -ne 2) {
        Write-Err2 "Unexpected repository slug format: '$repoSlug'"
        exit 1
    }
    $Owner = $parts[0]
    $Repo  = $parts[1]
}

$endpoint = "repos/$Owner/$Repo/branches/$Branch/protection"
Write-Info "Target: $Owner/$Repo -> branch '$Branch'"
if ($RequireCiChecks.Count -gt 0) {
    Write-Info ("Required status checks: " + ($RequireCiChecks -join ', '))
} else {
    Write-Info "Required status checks: none (CI not enforced yet)"
}

# ---------------------------------------------------------------------------
# 3. Request body (minimal, single-maintainer policy)
# ---------------------------------------------------------------------------
$requiredChecks = @()
if ($RequireCiChecks.Count -gt 0) {
    $checks = foreach ($name in $RequireCiChecks) { @{ context = $name } }
    $requiredChecks = @($checks)
}

$body = @{
    required_status_checks = @{
        strict   = $false
        contexts = $requiredChecks
    }
    enforce_admins = $true
    required_pull_request_reviews = @{
        # 0 approvals: a PR is mandatory, but the owner can self-merge.
        required_approving_review_count = 0
        require_code_owner_reviews      = $false
        dismiss_stale_reviews           = $false
    }
    restrictions      = $null   # null = no user/team push restriction
    allow_force_pushes = $false
    allow_deletions    = $false
    required_conversation_resolution = $false
    lock_branch                       = $false
    allow_fork_syncing                = $false
} | ConvertTo-Json -Depth 6

if ($DryRun) {
    Write-Info "DryRun - the following call would be made:"
    Write-Info "  gh api -X PUT $endpoint --input <body>"
    Write-Host ""
    Write-Host $body
    Write-Ok "DryRun complete - nothing was changed."
    exit 0
}

# ---------------------------------------------------------------------------
# 4. Apply
# ---------------------------------------------------------------------------
Write-Info "Applying branch protection..."
# Pipe the JSON via stdin (--input -) so it never lands on the command line.
$output = $body | & gh api -X PUT $endpoint --input - --silent 2>&1

if ($LASTEXITCODE -eq 0) {
    Write-Ok "Branch protection applied to '$Branch' in $Owner/$Repo."
    Write-Info "  - direct pushes rejected (PRs required, 0 approvals needed)"
    Write-Info "  - force pushes / deletions: disabled"
    Write-Info "  - admins included (enforce_admins)"
    Write-Info "  - required status checks: none (tighten later with -RequireCiChecks)"
    exit 0
}

$message = ($output | Out-String).Trim()

# ---------------------------------------------------------------------------
# 5. Error handling - 403 has a dedicated degradation path
# ---------------------------------------------------------------------------
# gh exits 1 on HTTP errors; classify by message content.
$isForbidden   = $message -match '\(HTTP 403\)'
$isNotFound    = $message -match '\(HTTP 404\)'
$isUnprocess   = $message -match '\(HTTP 422\)'

if ($isForbidden) {
    Write-Err2 "HTTP 403 - branch protection is NOT available for this repository."
    Write-Host ""
    Write-Host "  Most likely cause: $Owner/$Repo is a PRIVATE repository on the GitHub"
    Write-Host "  Free plan. Branch protection rules require GitHub Pro, Team, or"
    Write-Host "  Enterprise for private repos (public repos are always covered)."
    Write-Host ""
    Write-Host "  Degraded mode - enforce the mandatory PR workflow with local-only layers:"
    Write-Host "    1. pre-push hook (already in this repo):"
    Write-Host "         node scripts/guard/install.mjs"
    Write-Host "    2. CODEOWNERS (.github/CODEOWNERS) - documents ownership in PRs"
    Write-Host "    3. CI (.github/workflows/ci.yml) - runs on PRs and main pushes"
    Write-Host "  These do not technically forbid a direct push, so combine with:"
    Write-Host "    - team discipline: never push to main, always open a PR"
    Write-Host "    - gh CLI alias to make PR creation a one-liner:"
    Write-Host "        git config alias.pr '!gh pr create --fill-first --web'"
    Write-Host ""
    Write-Host "  Full write-up: docs/PR-WORKFLOW.md (degraded mode section)."
    Write-Host ""
    exit 2
}

if ($isNotFound) {
    Write-Err2 "HTTP 404 - repository '$Owner/$Repo' or branch '$Branch' not found."
    Write-Info "  - Is the slug correct? Is 'gh' authenticated as the right account?"
    Write-Info "  - Explicit form: pwsh scripts/guard/set-branch-protection.ps1 -Owner OWNER -Repo REPO"
    exit 1
}

if ($isUnprocess) {
    Write-Err2 "HTTP 422 - GitHub rejected the protection payload:"
    Write-Info $message
    Write-Info "  This usually means the API schema changed or a field is plan-restricted."
    Write-Info "  Try the minimal form (reviews + enforce_admins only) or check:"
    Write-Info "  https://docs.github.com/en/rest/branches/branch-protection"
    exit 1
}

Write-Err2 "gh api failed (exit $LASTEXITCODE):"
Write-Info $message
exit 1
