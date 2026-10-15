import { ConfirmDialog } from "../ui/ConfirmDialog/ConfirmDialog";

type RemoveProjectDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectName: string;
  /** Awaited: the dialog closes once it resolves and stays open if it rejects. */
  onConfirm: () => Promise<void>;
};

export function RemoveProjectDialog(props: RemoveProjectDialogProps) {
  const { open, onOpenChange, projectName, onConfirm } = props;

  return (
    <ConfirmDialog
      open={open}
      title="Remove Project"
      description={
        <>
          Remove <strong>{projectName}</strong> from the sidebar? This won't
          delete any files on disk.
        </>
      }
      confirmLabel="Remove"
      confirmVariant="danger"
      onConfirm={async () => {
        await onConfirm();
        onOpenChange(false);
      }}
      onCancel={() => onOpenChange(false)}
    />
  );
}
