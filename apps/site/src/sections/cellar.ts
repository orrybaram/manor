/**
 * The cellar: a hidden terminal behind ⌘K / Ctrl+K. A few canned commands,
 * Escape or the backdrop to leave, and focus goes back where it was.
 */
import "./cellar.css";

const term = document.querySelector<HTMLElement>("#term");
const out = document.querySelector<HTMLElement>("#term-out");
const input = document.querySelector<HTMLInputElement>("#term-in");
const form = document.querySelector<HTMLFormElement>("#term-form");
const closeButton = document.querySelector<HTMLButtonElement>("#close-term");

if (term && out && input && form && closeButton) {
  let lastFocus: HTMLElement | null = null;
  let greeted = false;

  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  const say = (html: string) => {
    out.insertAdjacentHTML("beforeend", html + "\n");
    out.scrollTop = out.scrollHeight;
  };

  const open = () => {
    lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    term.hidden = false;
    if (!greeted) {
      say('<span class="bl">Manor</span>you found the cellar. type <span class="y">help</span>.');
      greeted = true;
    }
    input.focus();
  };
  const close = () => {
    term.hidden = true;
    lastFocus?.focus();
  };

  const commands: Record<string, () => void> = {
    help: () =>
      say(
        '<span class="y">agents</span>   who is awake\n<span class="y">status</span>   the house, room by room\n<span class="y">summon</span>   wake an agent\n<span class="y">hail</span>     pay respects\n<span class="y">download</span> take the ticket\n<span class="y">clear</span>    sweep the floor\n<span class="y">exit</span>     back upstairs',
      ),
    agents: () =>
      say(
        'claude    <span class="y">working</span>         homepage\ncodex     <span class="p">requires input</span>  file-pane\npi        thinking        eval-sweep @ gpu-box\nopencode  responded       automations',
      ),
    status: () =>
      say('room 1  this mac   4 panes\nroom 2  phone      paired\nroom 3  gpu-box    2 panes  <span class="r">1 error</span>\nroom 4  pod        asleep. zzz'),
    summon: () =>
      say('<span class="bl">Rise</span>an agent stirs in the east wing.\n<span class="p">codex requires input</span>: allow it to haunt you? [y/N]'),
    hail: () => {
      say('<span class="bl">\\m/ Hail \\m/</span>');
      document.body.style.setProperty("--bile", "var(--wound)");
      setTimeout(() => document.body.style.removeProperty("--bile"), 2400);
    },
    download: () => {
      say("opening the ticket booth…");
      location.hash = "ticket";
      close();
    },
    clear: () => {
      out.innerHTML = "";
    },
    exit: close,
  };

  closeButton.addEventListener("click", close);
  term.addEventListener("click", (e) => {
    if (e.target === term) close();
  });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (term.hidden) open();
      else close();
    } else if (e.key === "Escape" && !term.hidden) {
      close();
    }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const said = input.value.trim();
    input.value = "";
    if (!said) return;
    say(`<span class="p">$</span> ${esc(said)}`);
    const command = commands[said.toLowerCase()];
    if (command) command();
    else say(`<span class="r">${esc(said)}: no such spirit.</span> try <span class="y">help</span>`);
  });
}
