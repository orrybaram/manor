import fs from "node:fs";
import path from "node:path";

import { shellZdotdir } from "./paths";

export class ShellManager {
  static zdotdirPath(): string {
    return shellZdotdir();
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
# Global history shared in and out of Manor — honor whatever HISTFILE the user's
# .zshrc resolved (oh-my-zsh and most configs set ~/.zsh_history); fall back to
# ~/.zsh_history only if the sourced .zshrc left it unset.
: "\${HISTFILE:=\${REAL_ZDOTDIR:-$HOME}/.zsh_history}"
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
    ];

    for (const [name, body] of files) {
      fs.writeFileSync(path.join(dir, name), body);
    }

    return dir;
  }
}
