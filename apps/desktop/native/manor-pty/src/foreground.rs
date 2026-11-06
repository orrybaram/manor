//! What runs in the pane's foreground, sampled every 500 ms and sent as
//! FgProc when it changes. The rules are `pty-subprocess.ts`'s
//! `pollForegroundProcess` and `foreground-shell.ts`, read straight from the
//! OS instead of through pgrep and ps; `__fixtures__/foreground-parity.json`
//! holds the cases both implementations are tested against.

use crate::procs;
use std::time::{Duration, Instant};

pub const INTERVAL: Duration = Duration::from_millis(500);

const KNOWN_SHELLS: [&str; 4] = ["zsh", "bash", "fish", "sh"];
const JS_RUNTIMES: [&str; 3] = ["node", "deno", "bun"];

/// `/bin/sh` → `sh`, `-zsh` (a login shell) → `zsh`.
pub fn process_basename(name: &str) -> &str {
    let base = name.rsplit('/').next().unwrap_or(name);
    base.strip_prefix('-').unwrap_or(base)
}

fn is_shell_name(name: &str) -> bool {
    KNOWN_SHELLS.contains(&name)
}

fn non_shell(name: &str) -> Option<String> {
    (!name.is_empty() && !is_shell_name(name)).then(|| name.to_owned())
}

/// `-c`, `-ec`, `-xc`: a flag cluster that includes `c`.
fn is_command_flag(arg: &str) -> bool {
    let Some(rest) = arg.strip_prefix('-') else {
        return false;
    };
    !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_alphabetic()) && rest.contains('c')
}

/// The script a shell's argv runs, by basename; None for an interactive
/// shell or when what it runs is itself a shell.
pub fn shell_script_name(argv: &[String]) -> Option<String> {
    let mut i = 1;
    while i < argv.len() {
        let arg = &argv[i];
        if arg == "--" {
            i += 1;
            continue;
        }
        if is_command_flag(arg) {
            let words: Vec<&str> = argv
                .get(i + 1)
                .map(|s| s.split_whitespace().collect())
                .unwrap_or_default();
            let command = if words.first() == Some(&"exec") {
                words.get(1)
            } else {
                words.first()
            };
            return command.and_then(|c| non_shell(process_basename(c)));
        }
        if arg.starts_with('-') || arg.starts_with('+') {
            i += 1;
            continue;
        }
        return non_shell(process_basename(arg));
    }
    None
}

/// The name to report while a shell leads the foreground.
pub fn shell_foreground_name(
    shell_pid: i32,
    leader_pid: Option<i32>,
    leader_args: Option<&[String]>,
    agent_below: Option<&str>,
) -> Option<String> {
    let leader = leader_pid?;
    if leader == shell_pid {
        return None;
    }
    if let Some(agent) = agent_below {
        return Some(agent.to_owned());
    }
    shell_script_name(leader_args?)
}

/// `\bname\b`, case-insensitive, with JavaScript's ASCII word characters.
pub fn mentions_word(line: &str, name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    let hay = line.to_ascii_lowercase();
    let needle = name.to_ascii_lowercase();
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let bytes = hay.as_bytes();
    let mut from = 0;
    while let Some(at) = hay[from..].find(&needle) {
        let start = from + at;
        let end = start + needle.len();
        let before_ok = start == 0 || !word(bytes[start - 1]);
        let after_ok = end == bytes.len() || !word(bytes[end]);
        if before_ok && after_ok {
            return true;
        }
        from = start + 1;
        while !hay.is_char_boundary(from) {
            from += 1;
        }
    }
    false
}

/// The first agent named in any of the command lines, in line order, then
/// name order (as `detectAgentFromChildArgs` reads `ps` output).
pub fn agent_in_lines(lines: impl IntoIterator<Item = String>, agent_names: &[String]) -> Option<&str> {
    for line in lines {
        for name in agent_names {
            if mentions_word(&line, name) {
                return Some(name);
            }
        }
    }
    None
}

/// "2.1.80": Claude Code sets its process title to its version.
fn is_version_string(name: &str) -> bool {
    let b = name.as_bytes();
    let digits = b.iter().take_while(|c| c.is_ascii_digit()).count();
    digits > 0 && b.get(digits) == Some(&b'.') && b.get(digits + 1).is_some_and(|c| c.is_ascii_digit())
}

pub struct Sampler {
    shell_pid: i32,
    shell_basename: String,
    agent_names: Vec<String>,
    last_sent: Option<String>,
    last_resolved: Option<(String, String)>,
    pub next_at: Instant,
}

impl Sampler {
    pub fn new(shell_pid: i32, shell: &str, agent_names: Vec<String>) -> Self {
        Sampler {
            shell_pid,
            shell_basename: process_basename(shell).to_owned(),
            agent_names,
            last_sent: None,
            last_resolved: None,
            next_at: Instant::now() + INTERVAL,
        }
    }

    /// Sample now; Some(name) when it differs from what was last sent.
    pub fn sample(&mut self, master: i32) -> Option<Option<String>> {
        self.next_at = Instant::now() + INTERVAL;
        let leader = crate::pty::foreground_pgrp(master);
        let fg = leader.and_then(foreground_name).unwrap_or_default();
        let basename = process_basename(&fg).to_owned();

        let is_shell = basename.is_empty() || basename == self.shell_basename || is_shell_name(&basename);
        if is_shell {
            self.last_resolved = None;
        }
        // Telling the pane's own shell from a shell running a script costs a
        // ps on macOS in pty-subprocess.js, so it skips its own shell's name
        // there; here it's free, but the same rule keeps the answers the same.
        let may_be_script = !basename.is_empty() && (cfg!(target_os = "linux") || basename != self.shell_basename);
        let name = if !is_shell {
            Some(self.resolve_fg_name(&basename))
        } else if may_be_script {
            let leader_args = leader.and_then(procs::args);
            let agent_below = leader.and_then(|l| self.agent_below(l));
            shell_foreground_name(self.shell_pid, leader, leader_args.as_deref(), agent_below.as_deref())
        } else {
            None
        };

        if name != self.last_sent {
            self.last_sent = name.clone();
            Some(name)
        } else {
            None
        }
    }

    fn resolve_fg_name(&mut self, fg: &str) -> String {
        if !JS_RUNTIMES.contains(&fg) && !is_version_string(fg) {
            return fg.to_owned();
        }
        if let Some(agent) = self.agent_below(self.shell_pid) {
            self.last_resolved = Some((fg.to_owned(), agent.clone()));
            return agent;
        }
        match &self.last_resolved {
            Some((name, agent)) if name == fg => agent.clone(),
            _ => fg.to_owned(),
        }
    }

    /// An agent among `pid`'s children and grandchildren.
    fn agent_below(&self, pid: i32) -> Option<String> {
        let kids = procs::children_of(pid);
        let mut all = kids.clone();
        for k in &kids {
            all.extend(procs::children_of(*k));
        }
        all.sort_unstable();
        all.dedup();
        let lines = all.into_iter().filter_map(procs::args).map(|a| a.join(" "));
        agent_in_lines(lines, &self.agent_names).map(str::to_owned)
    }
}

/// What node-pty's `.process` reports for a process group leader: argv[0] on
/// Linux, the kernel's short name (`p_comm`) on macOS.
fn foreground_name(pid: i32) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
        let first = raw.split(|b| *b == 0).next().unwrap_or(&[]);
        Some(String::from_utf8_lossy(first).into_owned())
    }
    #[cfg(target_os = "macos")]
    {
        let info = procs::macos::bsdinfo(pid)?;
        let comm: Vec<u8> = info
            .pbsi_comm
            .iter()
            .take_while(|c| **c != 0)
            .map(|c| *c as u8)
            .collect();
        (!comm.is_empty()).then(|| String::from_utf8_lossy(&comm).into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const FIXTURE: &str = include_str!("../../../electron/terminal-host/__fixtures__/foreground-parity.json");

    fn strings(v: &Value) -> Vec<String> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_owned())
            .collect()
    }

    fn opt(v: &Value) -> Option<String> {
        v.as_str().map(str::to_owned)
    }

    #[test]
    fn matches_the_typescript_cases() {
        let f: Value = serde_json::from_str(FIXTURE).unwrap();
        let names = strings(&f["agentNames"]);
        for case in f["processBasename"].as_array().unwrap() {
            assert_eq!(
                process_basename(case[0].as_str().unwrap()),
                case[1].as_str().unwrap(),
                "{case}"
            );
        }
        for case in f["shellScriptName"].as_array().unwrap() {
            assert_eq!(shell_script_name(&strings(&case[0])), opt(&case[1]), "{case}");
        }
        for case in f["shellForegroundName"].as_array().unwrap() {
            let c = &case[0];
            let args = c["leaderArgs"].as_array().map(|_| strings(&c["leaderArgs"]));
            let got = shell_foreground_name(
                c["shellPid"].as_i64().unwrap() as i32,
                c["leaderPid"].as_i64().map(|p| p as i32),
                args.as_deref(),
                c["agentBelow"].as_str(),
            );
            assert_eq!(got, opt(&case[1]), "{case}");
        }
        for case in f["agentInCommandLine"].as_array().unwrap() {
            let got = agent_in_lines([case[0].as_str().unwrap().to_owned()], &names);
            assert_eq!(got.map(str::to_owned), opt(&case[1]), "{case}");
        }
        for case in f["isVersionString"].as_array().unwrap() {
            assert_eq!(
                is_version_string(case[0].as_str().unwrap()),
                case[1].as_bool().unwrap(),
                "{case}"
            );
        }
    }
}
