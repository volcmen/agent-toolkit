# Wrap interactive `claude` and `codex` sessions in sbg (Tattoy animated background).
# Disable with `set -gx SBG_AUTO 0`; pick an effect with `set -gx SBG_THEME waves`.

function __sbg_wrap
    set -l cmd $argv[1]
    set -e argv[1]
    set -l passthrough 0

    if test "$SBG_AUTO" = 0; or set -q SBG_ACTIVE
        set passthrough 1
    else if not set -q SBG_AUTO_DRY_RUN; and begin
            not isatty stdin; or not isatty stdout
        end
        set passthrough 1
    else if not type -q sbg; or not type -q tattoy
        set passthrough 1
    end

    if test $passthrough -eq 0
        for arg in $argv
            switch $arg
                case -p --print -v -V --version -h --help
                    set passthrough 1
                    break
            end
        end
    end

    if test $passthrough -eq 0; and set -q argv[1]; and not string match -q -- '-*' $argv[1]
        set -l batch
        switch $cmd
            case claude
                set batch mcp plugin plugins doctor update upgrade install auth setup-token agents worktree logs rm stop kill respawn gateway import fix auto-mode configuration installation
            case codex
                set batch exec login logout mcp plugin app-server completion update doctor sandbox debug apply features help cloud exec-server migrate-rollouts archive unarchive delete
        end
        if contains -- $argv[1] $batch
            set passthrough 1
        end
    end

    if test $passthrough -eq 1
        if set -q SBG_AUTO_DRY_RUN
            echo "passthrough: $cmd $argv"
            return 0
        end
        command $cmd $argv
        return $status
    end

    set -l theme auto
    if set -q SBG_THEME
        set theme $SBG_THEME
    end
    if set -q SBG_AUTO_DRY_RUN
        sbg --dry-run $theme -- $cmd $argv
        return $status
    end
    sbg $theme -- $cmd $argv
end

function claude --wraps claude --description 'Claude Code inside an sbg animated background'
    __sbg_wrap claude $argv
end

function codex --wraps codex --description 'Codex CLI inside an sbg animated background'
    __sbg_wrap codex $argv
end
