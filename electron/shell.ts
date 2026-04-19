import fs from "node:fs";
import path from "node:path";

import { shellSessionsDir, shellZdotdir } from "./paths";

export class ShellManager {
  static sessionsDir(): string {
    return shellSessionsDir();
  }

  static zdotdirPath(): string {
    return shellZdotdir();
  }

  static historyFileFor(paneId: string): string {
    return path.join(this.sessionsDir(), `${paneId}.history`);
  }

  static setupZdotdir(): string {
    const dir = this.zdotdirPath();
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(this.sessionsDir(), { recursive: true });

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
[[ -n $MANOR_HISTFILE ]] && HISTFILE=$MANOR_HISTFILE
setopt INC_APPEND_HISTORY

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
