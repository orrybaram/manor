import fs from "fs";
import path from "path";
import type { Page } from "@playwright/test";

/** Where step screenshots and any captured log land. */
const ARTIFACT_DIR = path.join(__dirname, "..", "artifacts");

/**
 * Numbered screenshots into `tests/e2e/artifacts/<run>/`, so a run reads as a
 * strip of stills from the app window and the phone side by side. This is the
 * part that makes a flow reviewable without having watched it happen.
 */
export class Filmstrip {
  private index = 0;
  readonly dir: string;

  constructor(run: string) {
    this.dir = path.join(ARTIFACT_DIR, run);
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
  }

  async shot(page: Page, name: string): Promise<void> {
    this.index += 1;
    const file = `${String(this.index).padStart(2, "0")}-${name}.png`;
    // Dialogs here fade and scale in. Without this a shot taken the instant a
    // dialog opens catches it half-transparent, overlapping whatever is behind
    // it — which reads as a UI problem when it is only a photograph of one.
    await page.screenshot({
      path: path.join(this.dir, file),
      animations: "disabled",
    });
  }

  write(name: string, contents: string): void {
    fs.writeFileSync(path.join(this.dir, name), contents);
  }
}
