import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import styles from "./ProjectItem.module.css";

/** The disclosure chevron on a project's or a linked group's header row. */
export function ProjectChevron(props: { expanded: boolean }) {
  const { expanded } = props;

  return (
    <span className={`${styles.projectChevron} ${expanded ? styles.projectChevronOpen : ""}`}>
      <ChevronRight size={12} />
    </span>
  );
}
