import { useId } from "react";
import { cobwebLevel } from "../../../lib/cobwebs";
import { tabUnseenFor, useTabSightings } from "../../../store/tab-sightings";
import {
  useHalloweenEffects,
  useMinuteClock,
} from "../../../hooks/useHalloweenEffects";
import styles from "./TabDust.module.css";

/**
 * One layer of specks: fine noise cut down to its brightest grains, kept
 * only where a slower noise says there's a patch, so dust gathers unevenly,
 * then painted in the theme's text color so it reads on light and dark.
 */
function SpeckFilter(props: {
  id: string;
  grain: number;
  seed: number;
  cutoff: number;
  patches: string;
  blur: number;
  strength?: number;
}) {
  const { id, grain, seed, cutoff, patches, blur, strength } = props;
  return (
    <filter id={id} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency={grain} numOctaves={1} seed={seed} result="fine" />
      <feColorMatrix
        in="fine"
        type="matrix"
        values={`0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 24 ${-cutoff}`}
        result="specks"
      />
      <feTurbulence type="fractalNoise" baseFrequency={patches} numOctaves={2} seed={seed + 3} result="clump" />
      <feColorMatrix
        in="clump"
        type="matrix"
        values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 6 -2.5"
        result="patches"
      />
      <feComposite in="specks" in2="patches" operator="in" result="dust" />
      <feFlood floodColor="currentColor" />
      <feComposite in2="dust" operator="in" />
      <feGaussianBlur stdDeviation={blur} />
      {strength !== undefined && (
        <feComponentTransfer>
          <feFuncA type="linear" slope={strength} />
        </feComponentTransfer>
      )}
    </filter>
  );
}

type TabDustProps = {
  tabId: string;
  /** Selected in its panel: no dust, whatever the tracker last saw. */
  isActive: boolean;
};

/**
 * During Halloween week, the dust a tab gathers while nobody looks at it:
 * a film along its top edge and specks that thicken at each level.
 */
export function TabDust(props: TabDustProps) {
  const { tabId, isActive } = props;

  const enabled = useHalloweenEffects();
  const now = useMinuteClock(enabled);
  useTabSightings(enabled);
  // `useId` ids hold colons, which `url(#…)` would need escaped.
  const id = useId().replace(/:/g, "");
  if (!enabled) return null;

  const level = isActive ? 0 : cobwebLevel(tabUnseenFor(tabId, now));
  return (
    <span className={styles.dust} data-tab-dust={level} data-testid="tab-dust" aria-hidden="true">
      <svg className={styles.specks}>
        <defs>
          <SpeckFilter id={`${id}-1`} grain={1.7} seed={4} cutoff={17.6} patches=".05 .1" blur={0.2} />
          <SpeckFilter id={`${id}-2`} grain={1.3} seed={11} cutoff={17} patches=".05 .12" blur={0.25} />
          <SpeckFilter id={`${id}-3`} grain={0.6} seed={15} cutoff={14.6} patches=".04 .09" blur={0.5} strength={0.7} />
        </defs>
        <rect className={styles.layer1} width="100%" height="100%" filter={`url(#${id}-1)`} />
        <rect className={styles.layer2} width="100%" height="100%" filter={`url(#${id}-2)`} />
        <rect className={styles.layer3} width="100%" height="100%" filter={`url(#${id}-3)`} />
      </svg>
    </span>
  );
}
