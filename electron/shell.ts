import fs from "node:fs";
import path from "node:path";

import { shellBashrc, shellZdotdir } from "./paths";

export class ShellManager {
  static zdotdirPath(): string {
    return shellZdotdir();
  }

  static realZdotdir(): string {
    const inherited = process.env.ZDOTDIR;
    // If the app inherited OUR own zdotdir (Manor launched from a Manor pane),
    // it is not a real user ZDOTDIR — fall back to HOME so the generated scripts
    // source the user's real dotfiles instead of recursively sourcing themselves.
    if (inherited && inherited !== this.zdotdirPath()) return inherited;
    return process.env.HOME ?? "";
  }

  static setupZdotdir(): string {
    const dir = this.zdotdirPath();
    fs.mkdirSync(dir, { recursive: true });

    const files: [string, string][] = [
      [
        ".zshenv",
        `[[ -f "\${REAL_ZDOTDIR:-$HOME}/.zshenv" ]] && source "\${REAL_ZDOTDIR:-$HOME}/.zshenv"\n`,
      ],
      [
        ".zprofile",
        `[[ -f "\${REAL_ZDOTDIR:-$HOME}/.zprofile" ]] && source "\${REAL_ZDOTDIR:-$HOME}/.zprofile"\n`,
      ],
      [
        ".zshrc",
        `[[ -f "\${REAL_ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${REAL_ZDOTDIR:-$HOME}/.zshrc"
# /etc/zshrc on macOS sets HISTFILE=\${ZDOTDIR:-$HOME}/.zsh_history before this
# block runs, and our ZDOTDIR override poisons it to Manor's private dir. Reclaim
# the global file when HISTFILE is empty or lives inside our ZDOTDIR; honor any
# genuinely custom path the user set in their real .zshrc (it won't be under our
# dir — they don't know it exists).
if [[ -z "$HISTFILE" || "$HISTFILE" == "$ZDOTDIR"/* ]]; then
  HISTFILE="\${REAL_ZDOTDIR:-$HOME}/.zsh_history"
fi
# Guarantee the shared history is deep enough to be useful without shrinking a
# user who already set a larger value in their real .zshrc (sourced above).
(( HISTSIZE < 100000 )) && HISTSIZE=100000
(( SAVEHIST < 100000 )) && SAVEHIST=100000
# Share one history across every Manor pane (and the launching terminal): append
# each command immediately and pull in commands typed in other live sessions, so
# ctrl+r sees them all.
setopt SHARE_HISTORY

# Emit OSC 7 (CWD reporting) on each prompt so Manor can track the working directory
__manor_osc7_precmd() {
  printf '\\e]7;file://%s%s\\e\\\\' "\${HOST}" "\${PWD}"
}
[[ -z \${precmd_functions+x} ]] && precmd_functions=()
precmd_functions+=(__manor_osc7_precmd)
`,
      ],
      [
        ".zlogin",
        `[[ -f "\${REAL_ZDOTDIR:-$HOME}/.zlogin" ]] && source "\${REAL_ZDOTDIR:-$HOME}/.zlogin"\n`,
      ],
      [
        ".zlogout",
        `[[ -f "\${REAL_ZDOTDIR:-$HOME}/.zlogout" ]] && source "\${REAL_ZDOTDIR:-$HOME}/.zlogout"\n`,
      ],
    ];

    for (const [name, body] of files) {
      fs.writeFileSync(path.join(dir, name), body);
    }

    this.setupBashrc();
    return dir;
  }

  static bashrcPath(): string {
    return shellBashrc();
  }

  /**
   * The bash counterpart of the zdotdir: sources the user's ~/.bashrc, then
   * emits OSC 7 on each prompt. Without it a bash pane (the default shell on
   * most Linux hosts) never reports reaching a prompt, so queued commands
   * wait out the renderer's 3s fallback before they are typed.
   */
  static setupBashrc(): string {
    const file = this.bashrcPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"

# Emit OSC 7 (CWD reporting) on each prompt so Manor can track the working
# directory. Appended, so a prompt command that reads $? still sees the last
# command's status.
__manor_osc7_prompt() {
  printf '\\e]7;file://%s%s\\e\\\\' "\${HOSTNAME}" "\${PWD}"
}
case ";\${PROMPT_COMMAND};" in
  *";__manor_osc7_prompt;"*) ;;
  *) PROMPT_COMMAND="\${PROMPT_COMMAND:+\${PROMPT_COMMAND};}__manor_osc7_prompt" ;;
esac
`,
    );
    return file;
  }
}
