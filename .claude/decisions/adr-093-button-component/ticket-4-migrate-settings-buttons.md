---
title: Migrate SettingsModal and ProjectSetupWizard buttons
status: done
priority: medium
assignee: sonnet
blocked_by: [1]
---

# Migrate SettingsModal and ProjectSetupWizard buttons

Replace button patterns in the settings modal and project setup wizard with the Button component.

## Migration pattern

### SettingsModal
1. Replace `<button className={styles.closeButton}>` with `<Button variant="ghost" size="sm">`
2. Replace `<button className={styles.linearButton}>` with `<Button variant="secondary">` (keep the flex icon+label children as-is)
3. Replace `<button className={styles.addCommandBtn}>` with `<Button variant="secondary" size="sm">` (keep dashed border via inline style or a small override class if needed — the dashed border is unique to this context)

### ProjectSetupWizard
1. Replace `<button className={styles.nextButton}>` / `<button className={styles.submitButton}>` with `<Button variant="primary">`
2. Replace `<button className={styles.backButton}>` / `<button className={styles.skipButton}>` with `<Button variant="secondary">`
3. Replace `<button className={styles.addCommandBtn}>` with `<Button variant="secondary" size="sm">`

Remove orphaned CSS classes after migration.

## Files to touch
- `src/components/settings/SettingsModal/SettingsModal.tsx` — replace buttons
- `src/components/settings/SettingsModal/SettingsModal.module.css` — remove orphaned button classes
- `src/components/sidebar/ProjectSetupWizard/ProjectSetupWizard.tsx` — replace buttons
- `src/components/sidebar/ProjectSetupWizard/ProjectSetupWizard.module.css` — remove orphaned button classes
