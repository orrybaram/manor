/** Add a slide: import it and list it here. Its place comes from `SLIDE_ORDER`. */
import { SLIDE_ORDER, type Slide } from "../slide";
import { automations } from "./automations";
import { browser } from "./browser";
import { pullRequests } from "./pull-requests";
import { review } from "./review";
import { sideBySide } from "./side-by-side";
import { themes } from "./themes";

const BUILT: readonly Slide[] = [sideBySide, themes, review, pullRequests, browser, automations];

export const SLIDES: readonly Slide[] = SLIDE_ORDER.flatMap((id) => BUILT.find((slide) => slide.id === id) ?? []);
